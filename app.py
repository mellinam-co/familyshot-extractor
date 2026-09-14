import asyncio
import html
import json
import os
import re
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

app = FastAPI(title="Familyshot Product Extractor", version="0.1.0")

ALLOWED_HOSTS = {"minilu.de", "www.minilu.de"}
PRODUCT_RE = re.compile(r"/shop/product/(?P<slug>[^/?#]+)/(?P<sku>[^/?#]+)")
IMAGE_HINT = "publicshop-prod/media/"


def validate_product_url(url: str):
    p = urlparse(url)
    if p.scheme != "https" or p.hostname not in ALLOWED_HOSTS:
        raise HTTPException(400, "Für den MVP sind nur https://www.minilu.de/... URLs erlaubt.")
    m = PRODUCT_RE.search(p.path)
    if not m:
        raise HTTPException(400, "Die URL sieht nicht wie eine minilu Produkt-URL aus.")
    return m.group("slug"), m.group("sku")


def normalize_url(value: str) -> str:
    if value.startswith("//"):
        return "https:" + value
    if value.startswith("/"):
        return "https://www.minilu.de" + value
    return value


def first_match(patterns, text):
    for pat in patterns:
        m = re.search(pat, text, re.I | re.M)
        if m:
            return m.group(1).strip()
    return None


async def extract_single(page, product_url: str):
    try:
        await page.goto(product_url, wait_until="domcontentloaded", timeout=45000)
        try:
            await page.wait_for_load_state("networkidle", timeout=8000)
        except PlaywrightTimeoutError:
            pass
    except PlaywrightTimeoutError:
        raise HTTPException(504, f"Timeout beim Öffnen von {product_url}")

    body = await page.locator("body").inner_text()
    current_url = page.url
    pm = PRODUCT_RE.search(urlparse(current_url).path)
    sku_from_url = pm.group("sku") if pm else None

    title = None
    for selector in ["h1", "h2", "meta[property='og:title']", "title"]:
        try:
            loc = page.locator(selector).first
            if await loc.count():
                if selector.startswith("meta"):
                    value = await loc.get_attribute("content")
                else:
                    value = (await loc.inner_text()).strip()
                if value:
                    title = value
                    break
        except Exception:
            pass

    sku = first_match([
        r"Artikelnummer:\s*([A-Za-z0-9._-]+)",
        r"Hersteller-Artikelnr\.:\s*([A-Za-z0-9._-]+)",
    ], body) or sku_from_url

    color = first_match([
        r"(?:^|\n)Farbe\s*\n\s*([^\n]+)",
        r"(?:^|\n)(?:Farbe|Color)\s*:?\s*([^\n]+)",
    ], body)

    brand = first_match([
        r"(?:^|\n)Hersteller\s*\n\s*([^\n]+)",
        r"\bvon\s+([^\n]+)",
    ], body)

    # Prefer the obvious product-CDN image. Use currentSrc because sites often use srcset/lazy loading.
    image_url = None
    imgs = page.locator("img")
    for i in range(await imgs.count()):
        img = imgs.nth(i)
        try:
            src = await img.evaluate("el => el.currentSrc || el.src || el.getAttribute('data-src') || ''")
            alt = (await img.get_attribute("alt")) or ""
            if src and IMAGE_HINT in src and ("produkt" in alt.lower() or image_url is None):
                image_url = src
                if "produkt" in alt.lower():
                    break
        except Exception:
            continue

    return {
        "sku": sku,
        "variant": color,
        "brand": brand,
        "product_name": title,
        "product_url": current_url,
        "image_url": image_url,
    }


async def discover_variant_urls(page, url: str, slug: str):
    await page.goto(url, wait_until="domcontentloaded", timeout=45000)
    try:
        await page.wait_for_load_state("networkidle", timeout=8000)
    except PlaywrightTimeoutError:
        pass

    # Give client-side variant controls a chance to render.
    await page.wait_for_timeout(1200)

    urls = {url}
    same_slug = f"/shop/product/{slug}/"

    # 1) Normal links in the rendered DOM.
    anchors = page.locator(f'a[href*="{same_slug}"]')
    for i in range(await anchors.count()):
        href = await anchors.nth(i).get_attribute("href")
        if href:
            urls.add(normalize_url(href).split("#")[0])

    # 2) URLs embedded in script/JSON/HTML, even if no visible anchor exists.
    content = await page.content()
    escaped_slug = re.escape(slug)
    patterns = [
        rf'https?://(?:www\.)?minilu\.de/shop/product/{escaped_slug}/[A-Za-z0-9._-]+',
        rf'/shop/product/{escaped_slug}/[A-Za-z0-9._-]+',
    ]
    for pattern in patterns:
        for match in re.findall(pattern, content):
            urls.add(normalize_url(match).replace("&amp;", "&").split("#")[0])

    # 3) Try opening likely dropdown/listbox controls once, then inspect again.
    candidates = page.locator('[role="combobox"], [aria-haspopup="listbox"], select')
    for i in range(min(await candidates.count(), 8)):
        try:
            el = candidates.nth(i)
            if await el.is_visible():
                await el.click(timeout=1500)
                await page.wait_for_timeout(300)
        except Exception:
            continue

    anchors = page.locator(f'a[href*="{same_slug}"]')
    for i in range(await anchors.count()):
        href = await anchors.nth(i).get_attribute("href")
        if href:
            urls.add(normalize_url(href).split("#")[0])

    # Keep only this exact product family.
    clean = []
    for candidate in urls:
        try:
            p = urlparse(candidate)
            if p.hostname in ALLOWED_HOSTS and same_slug in p.path:
                clean.append(f"https://www.minilu.de{p.path}")
        except Exception:
            pass
    return sorted(set(clean))


async def run_extraction(url: str):
    slug, input_sku = validate_product_url(url)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
            ),
            viewport={"width": 1440, "height": 1000},
        )
        page = await context.new_page()
        variant_urls = await discover_variant_urls(page, url, slug)

        variants = []
        seen = set()
        for variant_url in variant_urls:
            data = await extract_single(page, variant_url)
            key = data.get("sku") or data.get("product_url")
            if key not in seen:
                seen.add(key)
                variants.append(data)

        await browser.close()

    base = next((v for v in variants if v.get("sku") == input_sku), variants[0] if variants else None)
    return {
        "source_url": url,
        "product_slug": slug,
        "product_name": base.get("product_name") if base else None,
        "brand": base.get("brand") if base else None,
        "variant_count": len(variants),
        "variants": variants,
        "note": (
            "MVP-Heuristik: Varianten werden aus DOM-Links und eingebetteten Seitendaten derselben Produktfamilie gefunden. "
            "Wenn variant_count=1 ist, muss die Varianten-Discovery für diesen Shop weiter angepasst werden."
        ),
    }


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/api/extract")
async def api_extract(url: str = Query(..., description="minilu Produkt-URL")):
    data = await run_extraction(url)
    return JSONResponse(data)


@app.get("/extract", response_class=HTMLResponse)
async def extract_html(url: str = Query(..., description="minilu Produkt-URL")):
    data = await run_extraction(url)
    rows = []
    for v in data["variants"]:
        img = v.get("image_url") or ""
        rows.append(
            "<tr>"
            f"<td>{html.escape(str(v.get('variant') or ''))}</td>"
            f"<td>{html.escape(str(v.get('sku') or ''))}</td>"
            f"<td><a href=\"{html.escape(v.get('product_url') or '')}\">Produktseite</a></td>"
            f"<td><a href=\"{html.escape(img)}\">{html.escape(img)}</a></td>"
            "</tr>"
        )
    payload = html.escape(json.dumps(data, ensure_ascii=False, indent=2))
    return f"""
    <!doctype html>
    <html lang="de"><head><meta charset="utf-8"><title>Familyshot Extract</title></head>
    <body>
      <h1>{html.escape(str(data.get('product_name') or 'Produkt'))}</h1>
      <p><strong>Marke:</strong> {html.escape(str(data.get('brand') or ''))}</p>
      <p><strong>Varianten gefunden:</strong> {data.get('variant_count')}</p>
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr><th>Variante</th><th>SKU</th><th>Produktseite</th><th>Originalbild</th></tr></thead>
        <tbody>{''.join(rows)}</tbody>
      </table>
      <h2>Maschinenlesbare Daten</h2>
      <pre>{payload}</pre>
    </body></html>
    """


@app.get("/", response_class=HTMLResponse)
async def index():
    return """
    <!doctype html>
    <html lang="de"><head><meta charset="utf-8"><title>Familyshot Extractor</title></head>
    <body>
      <h1>Familyshot Product Extractor</h1>
      <form action="/extract" method="get">
        <label>minilu Produkt-URL:<br>
        <input name="url" size="100" placeholder="https://www.minilu.de/shop/product/..." required></label>
        <button type="submit">Varianten extrahieren</button>
      </form>
      <p>API: <code>/api/extract?url=...</code></p>
      <p>Health: <code>/health</code></p>
    </body></html>
    """
