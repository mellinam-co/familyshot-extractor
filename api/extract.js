import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const MAX_VARIANTS = 30;
const NAV_TIMEOUT = 25000;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeUrl(value, base) {
  if (!value) return null;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

function assertAllowedProductUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (!(host === "minilu.de" || host.endsWith(".minilu.de"))) {
    throw new Error("Für diesen MVP sind nur minilu.de Produkt-URLs erlaubt.");
  }
  if (!url.pathname.startsWith("/shop/product/")) {
    throw new Error("Bitte eine minilu Produkt-URL unter /shop/product/... verwenden.");
  }
  return url;
}

function productSlugFromUrl(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("product");
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
}

function variantUrlRegex(slug) {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:https?:\\/\\/[^\\s\"'<>]+)?\\/shop\\/product\\/${escaped}\\/([A-Za-z0-9_-]+)`, "gi");
}

function extractVariantUrlsFromText(text, baseUrl, slug) {
  const out = new Set();
  if (!text || !slug) return out;
  const rx = variantUrlRegex(slug);
  let match;
  while ((match = rx.exec(text))) {
    const candidate = normalizeUrl(match[0].replaceAll("\\/", "/"), baseUrl);
    if (candidate) out.add(candidate.split("#")[0]);
  }
  return out;
}

function htmlPage(result) {
  const rows = result.variants.map(v => `
    <tr>
      <td>${escapeHtml(v.variant || "—")}</td>
      <td>${escapeHtml(v.sku || "—")}</td>
      <td>${v.product_url ? `<a href="${escapeHtml(v.product_url)}" target="_blank" rel="noreferrer">Produktseite</a>` : "—"}</td>
      <td>${v.image_url ? `<a href="${escapeHtml(v.image_url)}" target="_blank" rel="noreferrer">Originalbild</a>` : "fehlt"}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(result.product_name || "Product variants")}</title>
<style>
body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#111827}h1{font-size:28px}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{padding:12px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}th{background:#f9fafb}code{background:#f3f4f6;padding:2px 6px;border-radius:5px}.muted{color:#6b7280}.ok{color:#047857}.warn{color:#b45309}a{color:#2563eb;word-break:break-all}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:20px 0}.card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px}</style>
</head>
<body>
<h1>${escapeHtml(result.product_name || "Produkt")}</h1>
<p class="muted">Extrahiert aus <a href="${escapeHtml(result.source_url)}">${escapeHtml(result.source_url)}</a></p>
<div class="meta">
  <div class="card"><strong>Hersteller</strong><br>${escapeHtml(result.manufacturer || "—")}</div>
  <div class="card"><strong>Varianten gefunden</strong><br>${result.variants.length}</div>
  <div class="card"><strong>Mit Bild</strong><br>${result.variants.filter(v => v.image_url).length}</div>
  <div class="card"><strong>Discovery</strong><br>${escapeHtml(result.discovery?.method || "DOM")}</div>
</div>
${result.variants.length === 1 ? '<p class="warn"><strong>Hinweis:</strong> Es wurde nur eine Variante gefunden. Öffne die JSON-Ausgabe unter <code>/api/extract?url=...</code>, um die Discovery-Diagnose zu sehen.</p>' : '<p class="ok"><strong>OK:</strong> Mehrere Varianten wurden gefunden.</p>'}
<table>
<thead><tr><th>Variante</th><th>SKU</th><th>Produktseite</th><th>Originalbild</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2>Für amber</h2>
<p>Lies diese Tabelle vollständig aus. Nutze pro Variante ausschließlich die zugeordnete SKU, Produktseite und Originalbild-URL. Erfinde keine Varianten.</p>
</body></html>`;
}

async function launchBrowser() {
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });
}

async function snapshotProduct(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await new Promise(resolve => setTimeout(resolve, 1200));

  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const title = document.title || "";

    const clean = s => (s || "").replace(/\s+/g, " ").trim();
    const textLines = text.split(/\n+/).map(clean).filter(Boolean);

    const skuMatch = text.match(/Artikelnummer\s*:?\s*([A-Za-z0-9_-]{4,30})/i);
    const sku = skuMatch?.[1] || null;

    let manufacturer = null;
    const manufacturerMatch = text.match(/(?:von|Hersteller)\s+([A-Za-z0-9ÄÖÜäöüß& .+\-]{2,80})/i);
    if (manufacturerMatch) manufacturer = clean(manufacturerMatch[1]).split(/\n/)[0];

    let variant = null;
    const colorIndex = textLines.findIndex(x => /^Farbe$/i.test(x));
    if (colorIndex >= 0 && textLines[colorIndex + 1]) variant = textLines[colorIndex + 1];
    if (!variant && sku) {
      const skuIndex = textLines.findIndex(x => x === sku);
      const nearby = skuIndex >= 0 ? textLines.slice(Math.max(0, skuIndex - 8), skuIndex + 15) : [];
      variant = nearby.find(x => /^(weiß|weiss|schwarz|blau|grün|gruen|gelb|orange|pink|rosa|lila|violett|rot|braun|grau|transparent|cedro|berry|weinrot|türkis|tuerkis)$/i.test(x)) || null;
    }

    const headingCandidates = [...document.querySelectorAll("h1,h2,h3,h4")]
      .map(el => clean(el.textContent))
      .filter(x => x && !/^(Shop|Produktbeschreibung|Lieferumfang|Produkteigenschaften)$/i.test(x));
    const productName = headingCandidates.find(x => x.length >= 4 && x.length <= 120) || title.split("|")[0].replace(/\s+(weiß|weiss|schwarz|blau|grün|gruen|gelb|orange|pink|rosa|lila|violett|rot|braun|grau|transparent|cedro|berry|weinrot|türkis|tuerkis)(\s+\([^)]*\))?.*$/i, "").trim();

    const imageCandidates = [...document.images].map(img => ({
      src: img.currentSrc || img.src || "",
      alt: img.alt || "",
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0
    })).filter(x => x.src);

    const productImage = imageCandidates.find(x => /cdn\.vanderven\.de\/publicshop-prod\/media\//i.test(x.src) && !/badge|icon|logo|svg/i.test(x.src))
      || imageCandidates.find(x => /Produktbild/i.test(x.alt) && !/svg/i.test(x.src))
      || null;

    const hrefs = [...document.querySelectorAll("a[href]")].map(a => a.href).filter(Boolean);
    const html = document.documentElement.outerHTML;

    const formValues = [];
    for (const select of document.querySelectorAll("select")) {
      for (const option of select.options || []) {
        formValues.push({ type: "option", text: clean(option.textContent), value: option.value || "" });
      }
    }
    for (const input of document.querySelectorAll("input[type=radio], input[type=hidden]")) {
      formValues.push({ type: input.type, text: clean(input.labels?.[0]?.textContent || input.getAttribute("aria-label") || ""), value: input.value || "" });
    }

    return { text, title, sku, manufacturer, variant, productName, productImage, hrefs, html, formValues };
  });
}

async function discoverVariants(browser, productUrl, slug) {
  const page = await browser.newPage();
  const responseTexts = [];

  page.on("response", async response => {
    try {
      const type = response.request().resourceType();
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      if ((type === "xhr" || type === "fetch") && (ct.includes("json") || ct.includes("javascript") || ct.includes("text"))) {
        const text = await response.text();
        if (text && text.length < 2_000_000) responseTexts.push(text);
      }
    } catch {}
  });

  const root = await snapshotProduct(page, productUrl.href);
  const candidates = new Set([productUrl.href.split("#")[0]]);

  for (const href of root.hrefs) {
    try {
      const u = new URL(href);
      if ((u.hostname === "minilu.de" || u.hostname.endsWith(".minilu.de")) && u.pathname.includes(`/shop/product/${slug}/`)) {
        candidates.add(u.href.split("#")[0]);
      }
    } catch {}
  }

  for (const u of extractVariantUrlsFromText(root.html, productUrl.href, slug)) candidates.add(u);
  for (const payload of responseTexts) {
    for (const u of extractVariantUrlsFromText(payload, productUrl.href, slug)) candidates.add(u);
  }

  // Some shops store only a SKU in select/radio values. If the current SKU appears
  // in the same control, sibling values are treated as candidate variant SKUs.
  const values = root.formValues || [];
  const currentSku = root.sku;
  if (currentSku && values.some(x => x.value === currentSku || x.value?.endsWith(`/${currentSku}`))) {
    for (const item of values) {
      const val = String(item.value || "").trim();
      if (/^[A-Za-z0-9_-]{4,30}$/.test(val)) {
        candidates.add(new URL(`/shop/product/${slug}/${val}`, productUrl.origin).href);
      }
    }
  }

  await page.close();
  return {
    root,
    urls: [...candidates].slice(0, MAX_VARIANTS),
    responsePayloadsSeen: responseTexts.length
  };
}

async function extractAll(rawUrl) {
  const productUrl = assertAllowedProductUrl(rawUrl);
  const slug = productSlugFromUrl(productUrl);
  if (!slug) throw new Error("Produkt-Slug konnte nicht erkannt werden.");

  const browser = await launchBrowser();
  try {
    const discovery = await discoverVariants(browser, productUrl, slug);
    const variants = [];

    for (const url of discovery.urls) {
      const page = await browser.newPage();
      try {
        const snap = url === productUrl.href ? discovery.root : await snapshotProduct(page, url);
        if (!snap.sku) continue;
        variants.push({
          sku: snap.sku,
          variant: snap.variant,
          product_url: url,
          image_url: snap.productImage?.src || null
        });
      } catch (err) {
        variants.push({ sku: null, variant: null, product_url: url, image_url: null, error: String(err?.message || err) });
      } finally {
        await page.close();
      }
    }

    const deduped = [];
    const seen = new Set();
    for (const v of variants) {
      const key = v.sku || v.product_url;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(v);
      }
    }

    deduped.sort((a, b) => String(a.variant || a.sku).localeCompare(String(b.variant || b.sku), "de"));

    return {
      product_name: discovery.root.productName || slug.replaceAll("-", " "),
      manufacturer: discovery.root.manufacturer,
      source_url: productUrl.href,
      variant_type: "Farbe",
      variants: deduped,
      discovery: {
        method: "browser DOM + XHR/fetch payloads + form values",
        candidate_urls: discovery.urls.length,
        xhr_payloads_seen: discovery.responsePayloadsSeen,
        note: deduped.length <= 1 ? "Nur eine Variante entdeckt. Dann muss die minilu-spezifische Variant-API/DOM-Struktur ergänzt werden." : "Mehrere Varianten entdeckt."
      }
    };
  } finally {
    await browser.close();
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Nur GET ist erlaubt." });
  }

  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
  const format = typeof req.query.format === "string" ? req.query.format : "json";
  if (!rawUrl) {
    return res.status(400).json({
      error: "Parameter url fehlt.",
      example: "/api/extract?url=https%3A%2F%2Fwww.minilu.de%2Fshop%2Fproduct%2Fmundspuelbecher-pp-180ml%2F111207"
    });
  }

  try {
    const result = await extractAll(rawUrl);
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
    if (format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(htmlPage(result));
    }
    return res.status(200).json(result);
  } catch (err) {
    const message = String(err?.message || err);
    if (format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(500).send(`<!doctype html><meta charset="utf-8"><h1>Extractor-Fehler</h1><pre>${escapeHtml(message)}</pre>`);
    }
    return res.status(500).json({ error: message });
  }
}
