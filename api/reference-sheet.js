import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { extractAll } from "./extract.js";

const CELL = 420;
const GAP = 28;
const PADDING = 36;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function validatePart(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Ungültiger ${name}.`);
  }
  return value;
}

function gridFor(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 8) return { cols: 4, rows: 2 };
  const cols = 4;
  return { cols, rows: Math.ceil(count / cols) };
}

async function launchBrowser() {
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });
}

function sheetHtml(variants, cols, rows) {
  const items = variants.map((v, index) => {
    const primary = v.reference_image_url || v.image_url || "";
    const fallback = v.image_url || "";
    return `<div class="cell" data-index="${index}">
      <img src="${escapeHtml(primary)}" data-fallback="${escapeHtml(fallback)}" alt="" />
    </div>`;
  }).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}body{width:${PADDING * 2 + cols * CELL + (cols - 1) * GAP}px;height:${PADDING * 2 + rows * CELL + (rows - 1) * GAP}px;overflow:hidden;font-family:Arial,sans-serif}.grid{display:grid;grid-template-columns:repeat(${cols},${CELL}px);grid-auto-rows:${CELL}px;gap:${GAP}px;padding:${PADDING}px;width:100%;height:100%}.cell{background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden}.cell img{display:block;max-width:92%;max-height:92%;object-fit:contain}
</style>
</head>
<body>
<div class="grid">${items}</div>
<script>
for (const img of document.images) {
  img.addEventListener('error', () => {
    const fallback = img.dataset.fallback;
    if (fallback && img.src !== fallback) img.src = fallback;
  }, { once: true });
}
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Nur GET ist erlaubt.");
  }

  try {
    const slug = validatePart(req.query.slug, /^[a-z0-9-]+$/i, "Slug");
    const sku = validatePart(req.query.sku, /^[A-Za-z0-9_-]+$/, "SKU");
    const rawUrl = `https://www.minilu.de/shop/product/${slug}/${sku}`;
    const result = await extractAll(rawUrl);
    const variants = result.variants.filter(v => v.reference_image_url || v.image_url);

    if (!variants.length) {
      return res.status(404).send("Keine Variantenbilder gefunden.");
    }

    const { cols, rows } = gridFor(variants.length);
    const width = PADDING * 2 + cols * CELL + (cols - 1) * GAP;
    const height = PADDING * 2 + rows * CELL + (rows - 1) * GAP;

    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.setContent(sheetHtml(variants, cols, rows), { waitUntil: "domcontentloaded" });

      try {
        await page.waitForFunction(
          () => [...document.images].every(img => img.complete && img.naturalWidth > 0),
          { timeout: 10000 }
        );
      } catch {}

      const missing = await page.evaluate(() => [...document.images].filter(img => !(img.complete && img.naturalWidth > 0)).length);
      if (missing > 0) {
        return res.status(502).send(`${missing} Referenzbild(er) konnten nicht geladen werden.`);
      }

      const png = await page.screenshot({ type: "png", fullPage: false, omitBackground: false });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `inline; filename="${slug}-${sku}-reference-sheet.png"`);
      res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
      return res.status(200).send(png);
    } finally {
      await browser.close();
    }
  } catch (err) {
    return res.status(500).send(String(err?.message || err));
  }
}
