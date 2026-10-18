// Builds the public, crawlable pages from the live database:
//   /wine/<slug>/   one page per wine on sale at an active store (partial wines excluded)
//   /store/<slug>/  one page per active store
//   /wine/, /store/ index pages, and sitemap.xml
// Run nightly by .github/workflows/build-pages.yml (node 20+, no dependencies).
// Content (story, 5 pairings, sizes, label) is written into the database by the Cellar Writer agent;
// a page stays out of Google (noindex, not in sitemap) until it has real content.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = (process.env.SITE_URL || 'https://dlm-dig-26.github.io/ob-sommelier').replace(/\/$/, '');
const cfg = readFileSync(join(ROOT, 'config.js'), 'utf8');
const SB_URL = process.env.SUPABASE_URL || cfg.match(/SUPABASE_URL:\s*'([^']+)'/)[1];
const SB_KEY = process.env.SUPABASE_ANON_KEY || cfg.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/)[1];
const VER = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/styles\.css\?v=(\w+)/) || [])[1] || '1';

async function loadData() {
  if (process.env.EXPORT_FILE) return JSON.parse(readFileSync(process.env.EXPORT_FILE, 'utf8'));
  const r = await fetch(`${SB_URL}/rest/v1/rpc/site_export`, {
    method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: '{}'
  });
  if (!r.ok) throw new Error(`site_export failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => { if (!d) return ''; const [y, m, day] = d.slice(0, 10).split('-'); return `${+day} ${MONTHS[+m - 1]} ${y}`; };
const sizeLabel = (ml) => ml >= 1000 ? `${String(ml / 1000).replace('.', ',')} L` : `${ml} ml`;
const COLOR = { red: 'Red', white: 'White', rose: 'Rosé', sparkling: 'Sparkling', dessert: 'Dessert and fortified' };
const COLOR_ORDER = ['red', 'white', 'rose', 'sparkling', 'dessert'];
function describe(w) {
  const col = { red: 'Red', white: 'White', rose: 'Rosé', sparkling: 'Sparkling', dessert: 'Dessert' }[w.color];
  const what = (w.varietal && col && w.varietal.toLowerCase().startsWith(col.toLowerCase())) ? w.varietal : [col, w.varietal].filter(Boolean).join(' ');
  const origin = [w.region, w.country].filter(Boolean).join(', ');
  return origin ? `${what || 'Wine'} from ${origin}` : (what || 'Wine');
}
const dots = (n) => n ? `<span class="dots" role="img" aria-label="${n} out of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>` : '';
const money = (o) => `${o.currency === 'USD' ? 'US$' : 'Afl.'} ${Number(o.price).toFixed(2)}`;
const mapsUrl = (s) => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
const indexable = (w) => !!(w.story || w.notes || (Array.isArray(w.pairings) && w.pairings.length));

function page({ title, description, path, body, depth, noindex = false }) {
  const up = '../'.repeat(depth);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
${noindex ? '<meta name="robots" content="noindex, follow" />\n' : ''}<link rel="canonical" href="${SITE}/${path}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${SITE}/${path}" />
<meta property="og:image" content="${SITE}/icons/icon-512.png" />
<meta name="theme-color" content="#173a2b" />
<link rel="icon" href="${up}icons/icon-192.png" type="image/png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Barlow+Condensed:wght@600&family=Gloock&display=swap" />
<link rel="stylesheet" href="${up}styles.css?v=${VER}" />
<link rel="stylesheet" href="${up}pages.css?v=${VER}" />
</head>
<body class="pg">
<div class="band">
  <header class="top">
    <a class="brand" href="${up}"><span class="logo" aria-hidden="true"></span><span class="brand-name">OB Sommelier Aruba</span></a>
  </header>
  <div class="finder">
    <form class="search" action="${up}" method="get" role="search">
      <input name="q" type="search" placeholder="Find another wine near you" aria-label="Wine name, producer or grape" enterkeyhint="search" />
      <button class="ibtn go" type="submit" aria-label="Search"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg></button>
    </form>
  </div>
</div>
<main class="pg-main">
${body}
<footer class="foot">
  <p>Prices are shown for ${DATA.price_days} days after they were last confirmed by a shelf photo, a store price list or the store itself, with the date. Prices and stock can change at any time; check at the store.</p>
  <p><a href="${up}">Open the wine finder</a>. <a href="${up}wine/">All wines</a>. <a href="${up}store/">All stores</a>. <a href="${up}privacy.html">Privacy and terms</a>. For adults of legal drinking age (18+ in Aruba). Please drink responsibly.</p>
</footer>
</main>
</body>
</html>
`;
}

// ---------- build ----------
const DATA = await loadData();
const stores = DATA.stores.map((s) => ({ ...s }));
const storeById = new Map(stores.map((s) => [s.id, s]));
const usedSlugs = new Set();
const uniq = (base, id) => { let s = base; if (usedSlugs.has(s)) s = `${base}-${id.slice(0, 6)}`; usedSlugs.add(s); return s; };
for (const s of stores) s.slug = uniq(slugify(s.name), s.id);
usedSlugs.clear();
const wines = DATA.wines.filter((w) => !w.partial && w.offers && w.offers.length);
for (const w of wines) w.slug = uniq(slugify(w.name), w.id);
const today = DATA.generated_at.slice(0, 10);

for (const dir of ['wine', 'store']) { if (existsSync(join(ROOT, dir))) rmSync(join(ROOT, dir), { recursive: true }); }
const out = (rel, html) => { const f = join(ROOT, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, html); };

function offerHtml(o, best, up) {
  const s = storeById.get(o.store_id); if (!s) return '';
  const when = o.price != null ? `Price confirmed ${fmtDate(o.price_date)}` : (o.source === 'shelf' ? `Seen on the shelf ${fmtDate(o.seen_date)}` : `Listed by the store, ${fmtDate(o.seen_date)}`);
  const tag = o.price != null
    ? `<div class="price${best ? ' best' : ''}"><span class="cur">${o.currency === 'USD' ? 'US$' : 'Afl.'}</span><span class="amt">${Number(o.price).toFixed(2)}</span>${o.size_ml && o.size_ml !== 750 ? `<span class="size">${sizeLabel(o.size_ml)}</span>` : ''}</div>`
    : `<div class="price none">No price</div>`;
  return `<div class="offer"><div><a class="store" href="${up}store/${s.slug}/">${esc(s.name)}</a>
<div class="sub">${esc(s.address || '')}</div><div class="sub">${esc(when)}</div>
<div class="sub"><a href="${mapsUrl(s)}" rel="noopener" target="_blank">Directions</a></div></div>${tag}</div>`;
}

// Wine pages
for (const w of wines) {
  const up = '../../';
  const offers = [...w.offers].sort((a, b) => (a.price == null) - (b.price == null) || (a.price ?? 0) - (b.price ?? 0));
  const priced = offers.filter((o) => o.price != null);
  const nStores = new Set(offers.map((o) => o.store_id)).size;
  const cheapest = priced[0];
  const where = offers.map((o, i) => offerHtml(o, i === 0 && o.price != null, up)).join('\n');
  const pairings = Array.isArray(w.pairings) ? w.pairings.slice(0, 5) : [];
  const similar = wines.filter((x) => x.id !== w.id && x.color === w.color && (w.varietal && x.varietal === w.varietal)).slice(0, 4);
  if (similar.length < 4) similar.push(...wines.filter((x) => x.id !== w.id && x.color === w.color && !similar.includes(x)).slice(0, 4 - similar.length));
  const sizes = Array.isArray(w.sizes) && w.sizes.length ? w.sizes.map(sizeLabel).join(', ') : '';
  const desc = `Where to buy ${w.name} in Aruba: ${nStores} ${nStores === 1 ? 'store' : 'stores'}${cheapest ? `, from ${money(cheapest)}` : ''}. ${describe(w)}.${w.notes ? ' ' + w.notes + '.' : ''}`.replace(/\.\./g, '.');
  const body = `<p class="crumbs small"><a href="${up}wine/">All wines</a> / ${esc(COLOR[w.color] || 'Wine')}</p>
<article class="pg-wine">
<h1>${esc(w.name)}</h1>
<p class="meta">${esc(describe(w))}${w.producer && !w.name.toLowerCase().includes(w.producer.toLowerCase()) ? `, by ${esc(w.producer)}` : ''}</p>
${w.notes ? `<p class="notes">${esc(w.notes)}</p>` : ''}
${w.body ? `<div class="profile"><span>Body ${dots(w.body)}</span><span>Sweetness ${dots(w.sweetness)}</span><span>Acidity ${dots(w.acidity)}</span><span>Tannin ${dots(w.tannin)}</span></div>` : ''}
<section class="where"><h2>Where to buy it in Aruba</h2>
<p class="status ok">${nStores === 1 ? '1 store has it' : `${nStores} stores have it`}${priced.length > 1 ? ', cheapest first' : ''}.</p>
${where}
<p><a class="btn primary" href="${up}?q=${encodeURIComponent(w.name)}">Find it near you</a></p>
</section>
${w.story || w.label || sizes ? `<section><h2>About this wine</h2>
${w.story ? `<p>${esc(w.story)}</p>` : ''}
${w.label ? `<p><b>On the shelf:</b> ${esc(w.label)}</p>` : ''}
${sizes ? `<p><b>Bottle sizes made:</b> ${esc(sizes)}. Stores in Aruba may carry only some of them.</p>` : ''}
</section>` : ''}
${pairings.length ? `<section><h2>What to eat with it</h2><ol class="pairs">
${pairings.map((p) => `<li><b>${esc(p.dish)}</b>${p.why ? `. ${esc(p.why)}` : ''}${p.recipe ? `<br><span class="small">Recipe idea: ${esc(p.recipe)}</span>` : ''}${p.recipe_url ? ` <a class="small" href="${esc(p.recipe_url)}" rel="noopener nofollow" target="_blank">Full recipe</a>` : ''}</li>`).join('\n')}
</ol></section>` : (w.pairing ? `<section><h2>What to eat with it</h2><p>${esc(w.pairing)}</p></section>` : '')}
${similar.length ? `<section><h2>Similar wines in Aruba</h2><ul class="links">${similar.map((x) => `<li><a href="${up}wine/${x.slug}/">${esc(x.name)}</a> <span class="small muted">${esc(describe(x))}</span></li>`).join('')}</ul></section>` : ''}
${Array.isArray(w.sources) && w.sources.length ? `<p class="small muted">Sources: ${w.sources.slice(0, 3).map((u) => { try { return `<a href="${esc(u)}" rel="noopener nofollow" target="_blank">${esc(new URL(u).hostname.replace(/^www\./, ''))}</a>`; } catch { return ''; } }).filter(Boolean).join(', ')}</p>` : ''}
</article>`;
  out(`wine/${w.slug}/index.html`, page({
    title: `${w.name}: where to buy it in Aruba | OB Sommelier Aruba`, description: desc.slice(0, 300),
    path: `wine/${w.slug}/`, body, depth: 2, noindex: !indexable(w)
  }));
}

// Store pages
for (const s of stores) {
  const up = '../../';
  const list = wines.flatMap((w) => w.offers.filter((o) => o.store_id === s.id).map((o) => ({ w, o })));
  const groups = COLOR_ORDER.map((c) => [c, list.filter((x) => x.w.color === c)]).filter(([, l]) => l.length);
  const other = list.filter((x) => !COLOR_ORDER.includes(x.w.color));
  if (other.length) groups.push(['other', other]);
  const body = `<p class="crumbs small"><a href="${up}store/">All stores</a></p>
<article class="pg-store">
<h1>${esc(s.name)}</h1>
<p class="meta">${esc(s.address || '')}</p>
${s.hours ? `<p><b>Open:</b> ${esc(s.hours)}</p>` : ''}
${s.phone ? `<p><b>Phone:</b> <a href="tel:${esc(s.phone.replace(/\s+/g, ''))}">${esc(s.phone)}</a></p>` : ''}
<p><a class="btn primary" href="${mapsUrl(s)}" rel="noopener" target="_blank">Directions</a></p>
${s.blurb ? `<p>${esc(s.blurb)}</p>` : ''}
<section><h2>Wines at ${esc(s.name)}</h2>
<p class="small muted">${list.length} ${list.length === 1 ? 'wine' : 'wines'} seen here. Prices shown only when confirmed in the last ${DATA.price_days} days.</p>
${groups.map(([c, l]) => `<h3>${esc(COLOR[c] || 'Other')}</h3><ul class="links wines">${l.sort((a, b) => a.w.name.localeCompare(b.w.name)).map(({ w, o }) =>
  `<li><a href="${up}wine/${w.slug}/">${esc(w.name)}</a>${o.price != null ? ` <span class="pp">${money(o)}${o.size_ml && o.size_ml !== 750 ? ` (${sizeLabel(o.size_ml)})` : ''}</span>` : ''}</li>`).join('')}</ul>`).join('\n')}
</section>
</article>`;
  out(`store/${s.slug}/index.html`, page({
    title: `Wines at ${s.name}, Aruba | OB Sommelier Aruba`,
    description: `${list.length} wines at ${s.name} (${s.address || 'Aruba'}), with prices where confirmed. Opening hours, directions and what to eat with each wine.`,
    path: `store/${s.slug}/`, body, depth: 2, noindex: list.length < 3
  }));
}

// Index pages
const wineIndex = COLOR_ORDER.map((c) => [c, wines.filter((w) => w.color === c)]).filter(([, l]) => l.length)
  .map(([c, l]) => `<h2>${esc(COLOR[c])}</h2><ul class="links wines">${l.map((w) => `<li><a href="${w.slug}/">${esc(w.name)}</a> <span class="small muted">${esc(describe(w))}</span></li>`).join('')}</ul>`).join('\n');
out('wine/index.html', page({
  title: 'Wines you can buy in Aruba | OB Sommelier Aruba',
  description: `${wines.length} wines on sale in Aruba supermarkets and wine shops, with the stores that carry them and prices where confirmed.`,
  path: 'wine/', depth: 1,
  body: `<h1>Wines you can buy in Aruba</h1><p class="meta">${wines.length} wines seen in ${stores.length} stores. Tap a wine to see where it is sold and what to eat with it.</p>${wineIndex}`
}));
out('store/index.html', page({
  title: 'Where to buy wine in Aruba: stores | OB Sommelier Aruba',
  description: `Supermarkets and wine shops in Aruba and the wines they carry: ${stores.map((s) => s.name).join(', ')}.`,
  path: 'store/', depth: 1,
  body: `<h1>Where to buy wine in Aruba</h1><p class="meta">Stores we have mapped so far. More are added every week.</p><ul class="links">${stores.map((s) => `<li><a href="${s.slug}/">${esc(s.name)}</a> <span class="small muted">${esc(s.address || '')}, ${s.wines} wines</span></li>`).join('')}</ul>`
}));

// Sitemap: only pages worth indexing
const urls = ['', 'privacy.html', 'wine/', 'store/',
  ...wines.filter(indexable).map((w) => `wine/${w.slug}/`),
  ...stores.filter((s) => s.wines >= 3).map((s) => `store/${s.slug}/`)];
writeFileSync(join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}/${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>
`);
console.log(`Built ${wines.length} wine pages (${wines.filter(indexable).length} indexable), ${stores.length} store pages, sitemap with ${urls.length} URLs.`);
