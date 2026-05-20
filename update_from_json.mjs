/**
 * Actualiza precios_vodafone_espana.html con los precios de precios_raw.json
 * Uso: node update_from_json.mjs [ruta_json]
 *
 * Si ya tienes un precios_raw.json de un scraping anterior, usa esto
 * para regenerar el HTML sin necesidad de volver a scrapear.
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_FILE = join(__dirname, 'precios_vodafone_espana.html');
const JSON_FILE = process.argv[2] || join(__dirname, 'precios_raw.json');

const allPrices = JSON.parse(readFileSync(JSON_FILE, 'utf8'));
let html = readFileSync(HTML_FILE, 'utf8');

const today = new Date().toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
const nextWeek = new Date(Date.now() + 7*24*60*60*1000).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });

const match = html.match(/const RAW = \[([\s\S]*?)\];/);
if (!match) throw new Error('No se encontró const RAW en el HTML');

const raw = new Function(`return [${match[1]}]`)();

const updatedRaw = raw.map(product => {
  const rank = product[0];
  const updated = allPrices[rank];
  if (!updated) return product;
  return [
    product[0], product[1], product[2], product[3], product[4],
    updated[0], updated[1], updated[2], updated[3],
    updated[4], updated[5], updated[6], updated[7], updated[8]
  ];
});

const newRawStr = updatedRaw.map(p => {
  const prices = p.slice(5).map(v => v === null ? 'null' : v);
  return `  [${p[0]}, "${p[1]}","${p[2]}", "${p[3]}", ${p[4]},${prices.join(', ')}]`;
}).join(',\n');

html = html.replace(/const RAW = \[[\s\S]*?\];/, `const RAW = [\n${newRawStr}\n];`);
html = html.replace(/id="last-updated-date">[^<]*</, `id="last-updated-date">${today}<`);
html = html.replace(/(Última actualización completa:)\s*[\d/]+/, `$1 ${today}`);
html = html.replace(/(Próxima revisión obligatoria:)\s*[\d/]+/, `$1 ${nextWeek}`);
html = html.replace(/name="scrape-date" content="[^"]*"/, `name="scrape-date" content="${new Date().toISOString().slice(0,10)}"`);

writeFileSync(HTML_FILE, html, 'utf8');
console.log(`✅ HTML actualizado desde ${JSON_FILE}`);
console.log(`   Fecha: ${today} | Próxima: ${nextWeek}`);
