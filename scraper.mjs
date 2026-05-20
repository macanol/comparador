/**
 * Vodafone España – Scraper de precios
 *
 * Requisitos (en tu máquina local):
 *   npm install playwright
 *   npx playwright install chromium
 *   node scraper.mjs
 *
 * El script actualiza directamente precios_vodafone_espana.html con precios reales.
 * Pone null en todo lo que no encuentre verificado directamente en el retailer.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_FILE = join(__dirname, 'precios_vodafone_espana.html');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const DELAY_BETWEEN_SEARCHES_MS = 2500;   // espera entre búsquedas (evita ban)
const DELAY_BETWEEN_RETAILERS_MS = 5000;  // espera entre retailers
const PAGE_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

// ─── PRODUCTOS (copiados del HTML para procesarlos externamente) ──────────────
// Formato: [rank, cat, brand, model, isNew, amz, eci, mm, pcc, car, pix, mie, ora, mov]
// Los índices 5..13 son los precios que se van a sobreescribir.
// Para añadir nuevos productos, edita el array RAW en el HTML.

// ─── EXTRACCIÓN DE PRODUCTOS DESDE EL HTML ────────────────────────────────────
function extractProductsFromHTML() {
  const html = readFileSync(HTML_FILE, 'utf8');
  const match = html.match(/const RAW = \[([\s\S]*?)\];/);
  if (!match) throw new Error('No se encontró const RAW en el HTML');
  // Evaluar con Function para parsear el array
  const raw = new Function(`return [${match[1]}]`)();
  return raw.map(p => ({
    rank: p[0], cat: p[1], brand: p[2], model: p[3], isNew: p[4],
    prices: p.slice(5) // [amz, eci, mm, pcc, car, pix, mie, ora, mov]
  }));
}

// ─── SCRAPERS POR RETAILER ────────────────────────────────────────────────────
// Cada función recibe (page, query) y devuelve el precio en euros (número) o null.

const SCRAPERS = {

  // ── AMAZON ──────────────────────────────────────────────────────────────────
  async Amazon(page, query) {
    const url = `https://www.amazon.es/s?k=${encodeURIComponent(query)}&rh=p_6:A1AT7YVPFBWXBL`;
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    // Rechazar cookies si aparece el banner
    await page.locator('input[id="sp-cc-accept"]').click({ timeout: 3000 }).catch(() => {});

    // Busca el primer resultado que NO sea "Sponsored" / reacondicionado / usado
    const items = await page.locator('[data-component-type="s-search-result"]').all();
    for (const item of items.slice(0, 8)) {
      const label = (await item.innerText().catch(() => '')).toLowerCase();
      if (label.includes('reacondicionado') || label.includes('usado') || label.includes('refurbishe')) continue;
      // Precio whole + fraction
      const whole = await item.locator('.a-price-whole').first().innerText({ timeout: 3000 }).catch(() => null);
      if (!whole) continue;
      const frac  = await item.locator('.a-price-fraction').first().innerText({ timeout: 1000 }).catch(() => '00');
      const priceStr = whole.replace(/[^\d]/g, '') + '.' + frac.replace(/[^\d]/g, '');
      const price = parseFloat(priceStr);
      if (!isNaN(price) && price > 0) return Math.round(price);
    }
    return null;
  },

  // ── EL CORTE INGLÉS ─────────────────────────────────────────────────────────
  async ElCorteIngles(page, query) {
    const url = `https://www.elcorteingles.es/search/?term=${encodeURIComponent(query)}`;
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await page.locator('#onetrust-accept-btn-handler').click({ timeout: 3000 }).catch(() => {});

    // Precio del primer resultado
    const priceEl = page.locator('.product-price__current-price, .price__current, [class*="current-price"]').first();
    const text = await priceEl.innerText({ timeout: 8000 }).catch(() => null);
    if (!text) return null;
    const price = parseFloat(text.replace(/[^\d,]/g, '').replace(',', '.'));
    return !isNaN(price) && price > 0 ? Math.round(price) : null;
  },

  // ── MEDIAMARKT ──────────────────────────────────────────────────────────────
  async MediaMarkt(page, query) {
    const url = `https://www.mediamarkt.es/es/search.html?query=${encodeURIComponent(query)}`;
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await page.locator('#mms-privacy-accept-all-btn, button[data-testid="accept-all"]').click({ timeout: 3000 }).catch(() => {});

    // Intentar extraer precio del hydration JSON (método descrito en metadatos del HTML)
    const hydrationPrice = await page.evaluate(() => {
      try {
        const scripts = [...document.querySelectorAll('script[type="application/json"]')];
        for (const s of scripts) {
          const d = JSON.parse(s.textContent);
          // buscar loaderData con estructura de producto
          const loaderData = d?.loaderData;
          if (!loaderData) continue;
          for (const key of Object.keys(loaderData)) {
            const price = loaderData[key]?.data?.cofrProductAggregate?.cofrPriceFeature?.price?.amount;
            if (price) return price;
          }
        }
      } catch(e) {}
      return null;
    }).catch(() => null);

    if (hydrationPrice) return Math.round(hydrationPrice);

    // Fallback: selector CSS en listado de búsqueda
    const priceEl = page.locator('[data-test="product-price"] span, .price-wrapper span[aria-label], .ProductCard__price, [class*="product-price"]').first();
    const text = await priceEl.innerText({ timeout: 8000 }).catch(() => null);
    if (!text) return null;
    const price = parseFloat(text.replace(/[^\d,]/g, '').replace(',', '.'));
    return !isNaN(price) && price > 0 ? Math.round(price) : null;
  },

  // ── PCCOMPONENTES ───────────────────────────────────────────────────────────
  async PCComponentes(page, query) {
    const url = `https://www.pccomponentes.com/buscar/?query=${encodeURIComponent(query)}`;
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await page.locator('#onetrust-accept-btn-handler, button[id*="accept"]').click({ timeout: 3000 }).catch(() => {});

    // Método LD+JSON (ItemList)
    const jsonPrice = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      for (const s of scripts) {
        try {
          const d = JSON.parse(s.textContent);
          if (d['@type'] === 'ItemList' && d.itemListElement) {
            for (const item of d.itemListElement) {
              const name = (item.item?.name || '').toLowerCase();
              if (name.includes('reacondicionado') || name.includes('refurbished')) continue;
              const price = item.item?.offers?.price || item.item?.offers?.lowPrice;
              if (price && Number(price) > 0) return Number(price);
            }
          }
        } catch(e) {}
      }
      return null;
    }).catch(() => null);

    if (jsonPrice) return Math.round(jsonPrice);

    // Fallback CSS
    const priceEl = page.locator('.product-card__price, .price, [class*="price"]:not([class*="old"]):not([class*="prev"])').first();
    const text = await priceEl.innerText({ timeout: 8000 }).catch(() => null);
    if (!text) return null;
    const price = parseFloat(text.replace(/[^\d,]/g, '').replace(',', '.'));
    return !isNaN(price) && price > 0 ? Math.round(price) : null;
  },

  // ── CARREFOUR ───────────────────────────────────────────────────────────────
  async Carrefour(page, query) {
    const url = `https://www.carrefour.es/buscar?q=${encodeURIComponent(query)}`;
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await page.locator('#onetrust-accept-btn-handler').click({ timeout: 3000 }).catch(() => {});

    const priceEl = page.locator('[class*="product-card__price"]:not([class*="old"]):not([class*="before"]) .buyable-product-card__product-price, .product-card__price--current, .ebx-result-price__main-price').first();
    const text = await priceEl.innerText({ timeout: 10000 }).catch(() => null);
    if (!text) return null;
    const price = parseFloat(text.replace(/[^\d,]/g, '').replace(',', '.'));
    return !isNaN(price) && price > 0 ? Math.round(price) : null;
  },

  // ── PIXMANIA ────────────────────────────────────────────────────────────────
  async Pixmania(page, query) {
    const url = `https://www.pixmania.com/es/es/search?q=${encodeURIComponent(query)}`;
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await page.locator('button[id*="accept"], button[class*="accept"]').click({ timeout: 3000 }).catch(() => {});

    // LD+JSON
    const jsonPrice = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      for (const s of scripts) {
        try {
          const d = JSON.parse(s.textContent);
          const items = Array.isArray(d) ? d : (d.itemListElement || [d]);
          for (const item of items) {
            const price = item?.offers?.price || item?.offers?.lowPrice;
            if (price && Number(price) > 0) return Number(price);
          }
        } catch(e) {}
      }
      return null;
    }).catch(() => null);

    if (jsonPrice) return Math.round(jsonPrice);

    const priceEl = page.locator('[class*="price"]:not([class*="old"]):not([class*="before"])').first();
    const text = await priceEl.innerText({ timeout: 8000 }).catch(() => null);
    if (!text) return null;
    const price = parseFloat(text.replace(/[^\d,]/g, '').replace(',', '.'));
    return !isNaN(price) && price > 0 ? Math.round(price) : null;
  },

  // ── MIELECTRO ───────────────────────────────────────────────────────────────
  async MiElectro(page, query) {
    const url = `https://www.mielectro.es/buscar/${encodeURIComponent(query).replace(/%20/g, '-')}`;
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'networkidle' });
    await page.locator('#onetrust-accept-btn-handler, button[class*="cookie-accept"]').click({ timeout: 4000 }).catch(() => {});

    // MiElectro es Magento 2 - precio en JSON de producto
    const jsonPrice = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      for (const s of scripts) {
        try {
          const d = JSON.parse(s.textContent);
          const arr = Array.isArray(d) ? d : [d];
          for (const item of arr) {
            if (item['@type'] === 'Product' || item.offers) {
              const price = item?.offers?.price || item?.offers?.lowPrice;
              if (price && Number(price) > 0) return Number(price);
            }
          }
        } catch(e) {}
      }
      return null;
    }).catch(() => null);

    if (jsonPrice) return Math.round(jsonPrice);

    const priceEl = page.locator('.price-wrapper .price, [data-price-type="finalPrice"] .price').first();
    const text = await priceEl.innerText({ timeout: 8000 }).catch(() => null);
    if (!text) return null;
    const price = parseFloat(text.replace(/[^\d,]/g, '').replace(',', '.'));
    return !isNaN(price) && price > 0 ? Math.round(price) : null;
  },

  // ── ORANGE ──────────────────────────────────────────────────────────────────
  async Orange(page, query) {
    const url = `https://www.orange.es/smartphones?search=${encodeURIComponent(query)}`;
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await page.locator('#onetrust-accept-btn-handler').click({ timeout: 3000 }).catch(() => {});

    // Solo smartphones - buscar precio libre (pago único)
    const priceEl = page.locator('[class*="device-price"]:not([class*="monthly"]), [class*="price-one-pay"], .price-total, .free-price').first();
    const text = await priceEl.innerText({ timeout: 8000 }).catch(() => null);
    if (!text) return null;
    const price = parseFloat(text.replace(/[^\d,]/g, '').replace(',', '.'));
    return !isNaN(price) && price > 0 ? Math.round(price) : null;
  },

  // ── MOVISTAR ────────────────────────────────────────────────────────────────
  async Movistar(page, query) {
    const url = `https://tienda.movistar.es/buscar?q=${encodeURIComponent(query)}`;
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await page.locator('button[id*="accept"], button[id*="cookie"]').click({ timeout: 3000 }).catch(() => {});

    // Precio libre (sin permanencia)
    const priceEl = page.locator('[class*="price-free"], [class*="libre"], .device-price-total').first();
    const text = await priceEl.innerText({ timeout: 8000 }).catch(() => null);
    if (!text) return null;
    const price = parseFloat(text.replace(/[^\d,]/g, '').replace(',', '.'));
    return !isNaN(price) && price > 0 ? Math.round(price) : null;
  },
};

const RETAILER_KEYS = ['Amazon','ElCorteIngles','MediaMarkt','PCComponentes','Carrefour','Pixmania','MiElectro','Orange','Movistar'];

// ─── UTILIDADES ───────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeWithRetry(scraper, page, query, attempts = MAX_RETRIES) {
  for (let i = 0; i <= attempts; i++) {
    try {
      return await scraper(page, query);
    } catch (e) {
      if (i === attempts) return null;
      await sleep(2000);
    }
  }
  return null;
}

function buildQuery(brand, model) {
  // Construye la query más precisa para cada producto
  return `${brand} ${model}`.trim();
}

// ─── ACTUALIZAR HTML ─────────────────────────────────────────────────────────
function updateHTMLPrices(allPrices) {
  let html = readFileSync(HTML_FILE, 'utf8');
  const today = new Date().toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
  const nextWeek = new Date(Date.now() + 7*24*60*60*1000).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });

  // Rebuild the RAW array in JavaScript
  const match = html.match(/const RAW = \[([\s\S]*?)\];/);
  if (!match) throw new Error('No se encontró const RAW en el HTML');

  const raw = new Function(`return [${match[1]}]`)();

  // Apply new prices
  const updatedRaw = raw.map(product => {
    const rank = product[0];
    const updated = allPrices[rank];
    if (!updated) return product;
    // Rebuild: [rank, cat, brand, model, isNew, ...prices]
    return [
      product[0], product[1], product[2], product[3], product[4],
      updated[0], updated[1], updated[2], updated[3],
      updated[4], updated[5], updated[6], updated[7], updated[8]
    ];
  });

  // Serialize back
  const newRawStr = updatedRaw.map(p => {
    const prices = p.slice(5).map(v => v === null ? 'null' : v);
    return `  [${p[0]}, "${p[1]}","${p[2]}", "${p[3]}", ${p[4]},${prices.join(', ')}]`;
  }).join(',\n');

  html = html.replace(/const RAW = \[[\s\S]*?\];/, `const RAW = [\n${newRawStr}\n];`);

  // Update dates
  html = html.replace(/id="last-updated-date">[^<]*</, `id="last-updated-date">${today}<`);
  html = html.replace(/(Última actualización completa:)\s*[\d/]+/, `$1 ${today}`);
  html = html.replace(/(Próxima revisión obligatoria:)\s*[\d/]+/, `$1 ${nextWeek}`);
  html = html.replace(/content="scrape-date" content="[^"]*"/, `content="scrape-date" content="${new Date().toISOString().slice(0,10)}"`);
  html = html.replace(/name="scrape-date" content="[^"]*"/, `name="scrape-date" content="${new Date().toISOString().slice(0,10)}"`);

  writeFileSync(HTML_FILE, html, 'utf8');
  console.log(`\n✅ HTML actualizado: ${HTML_FILE}`);
  console.log(`   Fecha scraping: ${today} · próxima: ${nextWeek}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Vodafone España – Scraper de precios');
  console.log('   Tardaré un tiempo. NO interrumpir.\n');

  const products = extractProductsFromHTML();
  console.log(`📦 Productos a scrapear: ${products.length}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ]
  });

  // Resultados: { [rank]: [amz, eci, mm, pcc, car, pix, mie, ora, mov] }
  const allPrices = {};

  // Procesar retailer a retailer para ser más ordenados
  const retailerEntries = Object.entries(SCRAPERS);

  for (let ri = 0; ri < retailerEntries.length; ri++) {
    const [retailerKey, scraperFn] = retailerEntries[ri];
    const retailerIdx = RETAILER_KEYS.indexOf(retailerKey);
    if (retailerIdx < 0) continue;

    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'es-ES',
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
      viewport: { width: 1366, height: 768 }
    });

    // Ocultar que es Playwright
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
      window.chrome = { runtime: {} };
    });

    const page = await ctx.newPage();
    console.log(`\n🏪 [${ri+1}/${retailerEntries.length}] ${retailerKey}`);

    let found = 0, notFound = 0;

    for (let pi = 0; pi < products.length; pi++) {
      const product = products[pi];
      const query = buildQuery(product.brand, product.model);

      process.stdout.write(`   [${pi+1}/${products.length}] ${query.slice(0,45).padEnd(45)} → `);

      const price = await scrapeWithRetry(scraperFn.bind(SCRAPERS), page, query);

      if (!allPrices[product.rank]) allPrices[product.rank] = [null,null,null,null,null,null,null,null,null];
      allPrices[product.rank][retailerIdx] = price;

      if (price !== null) {
        process.stdout.write(`${price} €\n`);
        found++;
      } else {
        process.stdout.write(`—\n`);
        notFound++;
      }

      await sleep(DELAY_BETWEEN_SEARCHES_MS);
    }

    console.log(`   ✓ Encontrados: ${found} | Sin precio: ${notFound}`);

    await ctx.close();
    if (ri < retailerEntries.length - 1) {
      console.log(`   ⏳ Pausa entre retailers...`);
      await sleep(DELAY_BETWEEN_RETAILERS_MS);
    }
  }

  await browser.close();

  // Guardar JSON de respaldo
  const jsonPath = join(__dirname, 'precios_raw.json');
  writeFileSync(jsonPath, JSON.stringify(allPrices, null, 2));
  console.log(`\n💾 Precios raw guardados: ${jsonPath}`);

  // Actualizar HTML
  updateHTMLPrices(allPrices);

  console.log('\n🎉 Scraping completado. Abre precios_vodafone_espana.html en el navegador.');
}

main().catch(e => {
  console.error('\n❌ Error fatal:', e.message);
  process.exit(1);
});
