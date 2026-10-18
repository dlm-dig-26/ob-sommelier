// Builds the public, crawlable pages from the live database (node 20+, no dependencies):
//   English (root):  /wine/<slug>/  /store/<slug>/  /wine/  /store/
//   Spanish:         /es/wine/...   /es/store/...
//   Dutch:           /nl/wine/...   /nl/store/...
//   Papiamento:      /pap/store/... (stores only, D 18 Oct 2026: wines are not translated to Papiamento)
//   sitemap.xml with hreflang alternates.
// Run nightly by .github/workflows/build-pages.yml.
// Content comes from the Cellar Writer agent (English + translations in page_i18n). Rules:
// - partial wines get no page; pages without content are noindex and left out of the sitemap;
// - a translated page exists only when its translation exists (no English text under /es/ or /nl/);
// - Papiamento store pages are published only after D approves them (page_i18n.pap.approved = true);
// - prices only within the price window, always dated.
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

// ---------- fixed page text per language ----------
// es: neutral Latin American Spanish, "tú". nl: Netherlands Dutch, "je". pap: Aruban Papiamento (Aruban spelling),
// store pages only; every pap line here is to be checked by D before the first pap page is approved.
const L = {
  en: {
    name: 'English', prefix: '', months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    colors: { red: 'Red', white: 'White', rose: 'Rosé', sparkling: 'Sparkling', dessert: 'Dessert and fortified', other: 'Other' },
    allWines: 'All wines', allStores: 'All stores', searchPh: 'Find another wine near you', searchLabel: 'Wine name, producer or grape', search: 'Search',
    whereH: 'Where to buy it in Aruba', stores1: '1 store has it', storesN: (n) => `${n} stores have it`, cheapestFirst: ', cheapest first',
    findNear: 'Find it near you', aboutH: 'About this wine', onShelf: 'On the shelf:', sizesMade: 'Bottle sizes made:', sizesNote: 'Stores in Aruba may carry only some of them.',
    eatH: 'What to eat with it', recipeIdea: 'Recipe idea:', fullRecipe: 'Full recipe', similarH: 'Similar wines in Aruba', sources: 'Sources:',
    priceConfirmed: (d) => `Price confirmed ${d}`, seenShelf: (d) => `Seen on the shelf ${d}`, listed: (d) => `Listed by the store, ${d}`,
    noPrice: 'No price', directions: 'Directions', open: 'Open:', phone: 'Phone:',
    body: 'Body', sweetness: 'Sweetness', acidity: 'Acidity', tannin: 'Tannin', outOf5: (n) => `${n} out of 5`,
    winesAtH: (s) => `Wines at ${s}`, seenHere: (n, d) => `${n} ${n === 1 ? 'wine' : 'wines'} seen here. Prices shown only when confirmed in the last ${d} days.`,
    wineTitle: (w) => `${w}: where to buy it in Aruba | OB Sommelier Aruba`,
    wineDesc: (w, n, from, meta, notes) => `Where to buy ${w} in Aruba: ${n} ${n === 1 ? 'store' : 'stores'}${from ? `, from ${from}` : ''}. ${meta}.${notes ? ' ' + notes + '.' : ''}`,
    storeTitle: (s) => `Wines at ${s}, Aruba | OB Sommelier Aruba`,
    storeDesc: (s, n, a) => `${n} wines at ${s} (${a}), with prices where confirmed. Opening hours, directions and what to eat with each wine.`,
    wineIndexTitle: 'Wines you can buy in Aruba | OB Sommelier Aruba', wineIndexH: 'Wines you can buy in Aruba',
    wineIndexDesc: (n) => `${n} wines on sale in Aruba supermarkets and wine shops, with the stores that carry them and prices where confirmed.`,
    wineIndexLede: (n, s) => `${n} wines seen in ${s} stores. Tap a wine to see where it is sold and what to eat with it.`,
    storeIndexTitle: 'Where to buy wine in Aruba: stores | OB Sommelier Aruba', storeIndexH: 'Where to buy wine in Aruba',
    storeIndexDesc: (names) => `Supermarkets and wine shops in Aruba and the wines they carry: ${names}.`,
    storeIndexLede: 'Stores we have mapped so far. More are added every week.', nWines: (n) => `${n} wines`,
    footPrice: (d) => `Prices are shown for ${d} days after they were last confirmed by a shelf photo, a store price list or the store itself, with the date. Prices and stock can change at any time; check at the store.`,
    openFinder: 'Open the wine finder', privacy: 'Privacy and terms', adults: 'For adults of legal drinking age (18+ in Aruba). Please drink responsibly.'
  },
  es: {
    name: 'Español', prefix: 'es/', months: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'],
    colors: { red: 'Tintos', white: 'Blancos', rose: 'Rosados', sparkling: 'Espumosos', dessert: 'Dulces y generosos', other: 'Otros' },
    allWines: 'Todos los vinos', allStores: 'Todas las tiendas', searchPh: 'Busca otro vino cerca de ti', searchLabel: 'Nombre del vino, bodega o uva', search: 'Buscar',
    whereH: 'Dónde comprarlo en Aruba', stores1: 'Lo tiene 1 tienda', storesN: (n) => `Lo tienen ${n} tiendas`, cheapestFirst: ', del más barato al más caro',
    findNear: 'Encuéntralo cerca de ti', aboutH: 'Sobre este vino', onShelf: 'En el estante:', sizesMade: 'Tamaños de botella que produce la bodega:', sizesNote: 'Es posible que las tiendas de Aruba solo tengan algunos.',
    eatH: 'Con qué comerlo', recipeIdea: 'Idea de receta:', fullRecipe: 'Receta completa', similarH: 'Vinos parecidos en Aruba', sources: 'Fuentes:',
    priceConfirmed: (d) => `Precio confirmado el ${d}`, seenShelf: (d) => `Visto en el estante el ${d}`, listed: (d) => `Publicado por la tienda el ${d}`,
    noPrice: 'Sin precio', directions: 'Cómo llegar', open: 'Horario:', phone: 'Teléfono:',
    body: 'Cuerpo', sweetness: 'Dulzor', acidity: 'Acidez', tannin: 'Taninos', outOf5: (n) => `${n} de 5`,
    winesAtH: (s) => `Vinos en ${s}`, seenHere: (n, d) => `${n} ${n === 1 ? 'vino visto' : 'vinos vistos'} aquí. Solo mostramos precios confirmados en los últimos ${d} días.`,
    wineTitle: (w) => `${w}: dónde comprarlo en Aruba | OB Sommelier Aruba`,
    wineDesc: (w, n, from, meta, notes) => `Dónde comprar ${w} en Aruba: ${n} ${n === 1 ? 'tienda' : 'tiendas'}${from ? `, desde ${from}` : ''}. ${meta}.${notes ? ' ' + notes + '.' : ''}`,
    storeTitle: (s) => `Vinos en ${s}, Aruba | OB Sommelier Aruba`,
    storeDesc: (s, n, a) => `${n} vinos en ${s} (${a}), con precios cuando están confirmados. Horario, cómo llegar y qué comer con cada vino.`,
    wineIndexTitle: 'Vinos que puedes comprar en Aruba | OB Sommelier Aruba', wineIndexH: 'Vinos que puedes comprar en Aruba',
    wineIndexDesc: (n) => `${n} vinos a la venta en supermercados y vinotecas de Aruba, con las tiendas que los tienen y precios confirmados.`,
    wineIndexLede: (n, s) => `${n} vinos vistos en ${s} tiendas. Toca un vino para ver dónde lo venden y con qué comerlo.`,
    storeIndexTitle: 'Dónde comprar vino en Aruba: tiendas | OB Sommelier Aruba', storeIndexH: 'Dónde comprar vino en Aruba',
    storeIndexDesc: (names) => `Supermercados y vinotecas de Aruba y los vinos que venden: ${names}.`,
    storeIndexLede: 'Las tiendas que hemos registrado hasta ahora. Cada semana sumamos más.', nWines: (n) => `${n} vinos`,
    footPrice: (d) => `Mostramos cada precio durante ${d} días desde su última confirmación (foto del estante, lista de precios de la tienda o la propia tienda), siempre con la fecha. Los precios y el stock pueden cambiar en cualquier momento; confírmalos en la tienda.`,
    openFinder: 'Abrir el buscador de vinos', privacy: 'Privacidad y condiciones', adults: 'Solo para adultos con la edad legal para beber (18+ en Aruba). Bebe con moderación.'
  },
  nl: {
    name: 'Nederlands', prefix: 'nl/', months: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
    colors: { red: 'Rood', white: 'Wit', rose: 'Rosé', sparkling: 'Mousserend', dessert: 'Zoet en versterkt', other: 'Overig' },
    allWines: 'Alle wijnen', allStores: 'Alle winkels', searchPh: 'Zoek een andere wijn in de buurt', searchLabel: 'Naam van de wijn, producent of druif', search: 'Zoeken',
    whereH: 'Waar koop je hem op Aruba', stores1: '1 winkel heeft hem', storesN: (n) => `${n} winkels hebben hem`, cheapestFirst: ', goedkoopste eerst',
    findNear: 'Vind hem bij jou in de buurt', aboutH: 'Over deze wijn', onShelf: 'In het schap:', sizesMade: 'Flesformaten van de producent:', sizesNote: 'Winkels op Aruba hebben er misschien maar een paar van.',
    eatH: 'Wat eet je erbij', recipeIdea: 'Receptidee:', fullRecipe: 'Volledig recept', similarH: 'Vergelijkbare wijnen op Aruba', sources: 'Bronnen:',
    priceConfirmed: (d) => `Prijs bevestigd op ${d}`, seenShelf: (d) => `Gezien in het schap op ${d}`, listed: (d) => `Door de winkel vermeld op ${d}`,
    noPrice: 'Geen prijs', directions: 'Route', open: 'Open:', phone: 'Telefoon:',
    body: 'Body', sweetness: 'Zoetheid', acidity: 'Zuurgraad', tannin: 'Tannine', outOf5: (n) => `${n} van de 5`,
    winesAtH: (s) => `Wijnen bij ${s}`, seenHere: (n, d) => `${n} ${n === 1 ? 'wijn' : 'wijnen'} hier gezien. We tonen alleen prijzen die in de afgelopen ${d} dagen zijn bevestigd.`,
    wineTitle: (w) => `${w}: waar koop je hem op Aruba | OB Sommelier Aruba`,
    wineDesc: (w, n, from, meta, notes) => `Waar koop je ${w} op Aruba: ${n} ${n === 1 ? 'winkel' : 'winkels'}${from ? `, vanaf ${from}` : ''}. ${meta}.${notes ? ' ' + notes + '.' : ''}`,
    storeTitle: (s) => `Wijnen bij ${s}, Aruba | OB Sommelier Aruba`,
    storeDesc: (s, n, a) => `${n} wijnen bij ${s} (${a}), met prijzen waar die bevestigd zijn. Openingstijden, route en wat je bij elke wijn eet.`,
    wineIndexTitle: 'Wijnen die je op Aruba kunt kopen | OB Sommelier Aruba', wineIndexH: 'Wijnen die je op Aruba kunt kopen',
    wineIndexDesc: (n) => `${n} wijnen te koop in supermarkten en wijnwinkels op Aruba, met de winkels die ze verkopen en bevestigde prijzen.`,
    wineIndexLede: (n, s) => `${n} wijnen gezien in ${s} winkels. Tik op een wijn om te zien waar hij te koop is en wat je erbij eet.`,
    storeIndexTitle: 'Waar koop je wijn op Aruba: winkels | OB Sommelier Aruba', storeIndexH: 'Waar koop je wijn op Aruba',
    storeIndexDesc: (names) => `Supermarkten en wijnwinkels op Aruba en de wijnen die ze verkopen: ${names}.`,
    storeIndexLede: 'De winkels die we tot nu toe in kaart hebben gebracht. Elke week komen er meer bij.', nWines: (n) => `${n} wijnen`,
    footPrice: (d) => `We tonen een prijs ${d} dagen na de laatste bevestiging (foto van het schap, prijslijst van de winkel of de winkel zelf), altijd met de datum. Prijzen en voorraad kunnen altijd veranderen; check het in de winkel.`,
    openFinder: 'Open de wijnzoeker', privacy: 'Privacy en voorwaarden', adults: 'Alleen voor volwassenen vanaf de wettelijke leeftijd (18+ op Aruba). Geniet, maar drink met mate.'
  },
  pap: { // Aruban Papiamento, store pages only. D TO CHECK every line before approving the first pap page.
    name: 'Papiamento', prefix: 'pap/', months: null,
    colors: { red: 'Biña cora', white: 'Biña blanco', rose: 'Rosé', sparkling: 'Biña cu bubuja', dessert: 'Biña dushi', other: 'Otro' },
    allWines: 'Tur biña', allStores: 'Tur tienda', searchPh: 'Busca un biña cerca di bo', searchLabel: 'Nomber di e biña, e productor of e uva', search: 'Busca',
    priceConfirmed: (d) => `Prijs confirma ${d}`, seenShelf: (d) => `Mira den rek ${d}`, listed: (d) => `Publica pa e tienda ${d}`,
    noPrice: 'Sin prijs', directions: 'Con pa yega', open: 'Habri:', phone: 'Telefon:',
    winesAtH: (s) => `Biña na ${s}`, seenHere: (n, d) => `${n} biña mira aki. Nos ta mustra prijs so si e ta confirma den e ultimo ${d} dianan.`,
    storeTitle: (s) => `Biña na ${s}, Aruba | OB Sommelier Aruba`,
    storeDesc: (s, n, a) => `${n} biña na ${s} (${a}), cu prijs ora e ta confirma. Ora di habri, con pa yega y kico come cu cada biña.`,
    storeIndexTitle: 'Unda pa cumpra biña na Aruba: tiendanan | OB Sommelier Aruba', storeIndexH: 'Unda pa cumpra biña na Aruba',
    storeIndexDesc: (names) => `Supermercado y tienda di biña na Aruba y e biñanan cu nan ta bende: ${names}.`,
    storeIndexLede: 'E tiendanan cu nos a registra te awor. Tur siman ta bin mas.', nWines: (n) => `${n} biña`,
    footPrice: (d) => `Nos ta mustra un prijs pa ${d} dia despues cu e ta confirma (potret di rek, lista di prijs di e tienda of e tienda mes), semper cu e fecha. Prijs y stock por cambia; check den tienda.`,
    openFinder: 'Habri e buscador di biña', privacy: 'Privacidad y condicion', adults: 'Solamente pa adulto di edad legal (18+ na Aruba). Bebe cu moderacion.'
  }
};
const WINE_LANGS = ['en', 'es', 'nl'];
const STORE_LANGS = ['en', 'es', 'nl', 'pap'];
const HREF = { en: 'en', es: 'es', nl: 'nl', pap: 'pap' };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
const fmtDate = (d, lang) => {
  if (!d) return ''; const [y, m, day] = d.slice(0, 10).split('-');
  return L[lang].months ? `${+day} ${L[lang].months[+m - 1]} ${y}` : `${+day}-${+m}-${y}`;
};
const sizeLabel = (ml) => ml >= 1000 ? `${String(ml / 1000).replace('.', ',')} L` : `${ml} ml`;
const COLOR_ORDER = ['red', 'white', 'rose', 'sparkling', 'dessert'];
function describeEn(w) {
  const col = { red: 'Red', white: 'White', rose: 'Rosé', sparkling: 'Sparkling', dessert: 'Dessert' }[w.color];
  const what = (w.varietal && col && w.varietal.toLowerCase().startsWith(col.toLowerCase())) ? w.varietal : [col, w.varietal].filter(Boolean).join(' ');
  const origin = [w.region, w.country].filter(Boolean).join(', ');
  return origin ? `${what || 'Wine'} from ${origin}` : (what || 'Wine');
}
// Wine content in a language: English from the columns, translations from page_i18n.
function wineText(w, lang) {
  if (lang === 'en') return { meta: describeEn(w), notes: w.notes, story: w.story, label: w.label, pairings: w.pairings, pairing: w.pairing };
  const t = (w.i18n && w.i18n[lang]) || null;
  if (!t) return null;
  return { meta: t.meta || '', notes: t.notes, story: t.story, label: t.label, pairings: t.pairings, pairing: null };
}
const hasContent = (t) => !!(t && (t.story || t.notes || (Array.isArray(t.pairings) && t.pairings.length)));
const storeHours = (s, lang) => lang === 'en' ? s.hours : ((s.i18n && s.i18n[lang] && s.i18n[lang].hours) || null);
const storeBlurb = (s, lang) => lang === 'en' ? s.blurb : (s.i18n && s.i18n[lang] && s.i18n[lang].blurb) || null;
const storeHasLang = (s, lang) => lang === 'en' || (!!storeBlurb(s, lang) && (lang !== 'pap' || s.i18n.pap.approved === true));
const dots = (n, lang) => n ? `<span class="dots" role="img" aria-label="${esc(L[lang].outOf5(n))}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>` : '';
const money = (o) => `${o.currency === 'USD' ? 'US$' : 'Afl.'} ${Number(o.price).toFixed(2)}`;
const mapsUrl = (s) => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;

// alternates: [{lang, path}] for hreflang and the language links
function page({ lang, title, description, path, body, noindex = false, alternates = [] }) {
  const T = L[lang];
  const depth = path.split('/').filter(Boolean).length;
  const up = '../'.repeat(depth);
  const pre = T.prefix;
  const alt = alternates.length > 1 ? alternates : [];
  return `<!DOCTYPE html>
<html lang="${HREF[lang]}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
${noindex ? '<meta name="robots" content="noindex, follow" />\n' : ''}<link rel="canonical" href="${SITE}/${path}" />
${alt.map((a) => `<link rel="alternate" hreflang="${HREF[a.lang]}" href="${SITE}/${a.path}" />`).join('\n')}${alt.length ? `\n<link rel="alternate" hreflang="x-default" href="${SITE}/${(alt.find((a) => a.lang === 'en') || alt[0]).path}" />\n` : ''}<meta property="og:type" content="website" />
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
      <input name="q" type="search" placeholder="${esc(T.searchPh)}" aria-label="${esc(T.searchLabel)}" enterkeyhint="search" />
      <button class="ibtn go" type="submit" aria-label="${esc(T.search)}"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg></button>
    </form>
  </div>
</div>
<main class="pg-main">
${alt.length ? `<nav class="langs small" aria-label="Language">${alt.map((a) => a.lang === lang ? `<span aria-current="page">${L[a.lang].name}</span>` : `<a href="${up}${a.path}" hreflang="${HREF[a.lang]}" lang="${HREF[a.lang]}">${L[a.lang].name}</a>`).join(' ')}</nav>\n` : ''}${body}
<footer class="foot">
  <p>${esc(T.footPrice(DATA.price_days))}</p>
  <p><a href="${up}">${esc(T.openFinder)}</a>. ${T.allWines && lang !== 'pap' ? `<a href="${up}${pre}wine/">${esc(T.allWines)}</a>. ` : ''}<a href="${up}${pre}store/">${esc(T.allStores)}</a>. <a href="${up}privacy.html">${esc(T.privacy)}</a>. ${esc(T.adults)}</p>
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

for (const dir of ['wine', 'store', 'es', 'nl', 'pap']) { if (existsSync(join(ROOT, dir))) rmSync(join(ROOT, dir), { recursive: true }); }
const out = (rel, html) => { const f = join(ROOT, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, html); };
const sitemap = []; // {path, alternates}

// which language versions exist
const wineLangs = (w) => WINE_LANGS.filter((lang) => lang === 'en' || hasContent(wineText(w, lang)));
const wineIndexable = (w, lang) => hasContent(wineText(w, lang));
const wPath = (w, lang) => `${L[lang].prefix}wine/${w.slug}/`;
const sPath = (s, lang) => `${L[lang].prefix}store/${s.slug}/`;
// link to a wine/store in the reader's language when that version exists, else English
const wineHref = (w, lang, up) => `${up}${wineLangs(w).includes(lang) ? wPath(w, lang) : wPath(w, 'en')}`;
const storeHref = (s, lang, up) => `${up}${storeHasLang(s, lang) ? sPath(s, lang) : sPath(s, 'en')}`;

function offerHtml(o, best, up, lang) {
  const T = L[lang]; const s = storeById.get(o.store_id); if (!s) return '';
  const when = o.price != null ? T.priceConfirmed(fmtDate(o.price_date, lang)) : (o.source === 'shelf' ? T.seenShelf(fmtDate(o.seen_date, lang)) : T.listed(fmtDate(o.seen_date, lang)));
  const tag = o.price != null
    ? `<div class="price${best ? ' best' : ''}"><span class="cur">${o.currency === 'USD' ? 'US$' : 'Afl.'}</span><span class="amt">${Number(o.price).toFixed(2)}</span>${o.size_ml && o.size_ml !== 750 ? `<span class="size">${sizeLabel(o.size_ml)}</span>` : ''}</div>`
    : `<div class="price none">${esc(T.noPrice)}</div>`;
  return `<div class="offer"><div><a class="store" href="${storeHref(s, lang, up)}">${esc(s.name)}</a>
<div class="sub">${esc(s.address || '')}</div><div class="sub">${esc(when)}</div>
<div class="sub"><a href="${mapsUrl(s)}" rel="noopener" target="_blank">${esc(T.directions)}</a></div></div>${tag}</div>`;
}

// Wine pages (en, es, nl)
let winePages = 0;
for (const w of wines) {
  const langs = wineLangs(w);
  const alternates = langs.map((lang) => ({ lang, path: wPath(w, lang) }));
  const offers = [...w.offers].sort((a, b) => (a.price == null) - (b.price == null) || (a.price ?? 0) - (b.price ?? 0));
  const priced = offers.filter((o) => o.price != null);
  const nStores = new Set(offers.map((o) => o.store_id)).size;
  const cheapest = priced[0];
  // similar wines, per language: only wines that have a page in that language (no mixed-language lists)
  const similarFor = (lang) => {
    const pool = wines.filter((x) => x.id !== w.id && x.color === w.color && wineLangs(x).includes(lang));
    const sim = pool.filter((x) => w.varietal && x.varietal === w.varietal).slice(0, 4);
    if (sim.length < 4) sim.push(...pool.filter((x) => !sim.includes(x)).slice(0, 4 - sim.length));
    return sim;
  };
  const sizes = Array.isArray(w.sizes) && w.sizes.length ? w.sizes.map(sizeLabel).join(', ') : '';
  for (const lang of langs) {
    const T = L[lang]; const t = wineText(w, lang); const path = wPath(w, lang); const up = '../'.repeat(path.split('/').filter(Boolean).length);
    const pairings = Array.isArray(t.pairings) ? t.pairings.slice(0, 5) : [];
    const similar = similarFor(lang);
    const where = offers.map((o, i) => offerHtml(o, i === 0 && o.price != null, up, lang)).join('\n');
    const desc = T.wineDesc(w.name, nStores, cheapest ? money(cheapest) : '', t.meta, t.notes).replace(/\.\./g, '.');
    const body = `<p class="crumbs small"><a href="${up}${T.prefix}wine/">${esc(T.allWines)}</a> / ${esc(T.colors[w.color] || T.colors.other)}</p>
<article class="pg-wine">
<h1>${esc(w.name)}</h1>
<p class="meta">${esc(t.meta)}${lang === 'en' && w.producer && !w.name.toLowerCase().includes(w.producer.toLowerCase()) ? `, by ${esc(w.producer)}` : ''}</p>
${t.notes ? `<p class="notes">${esc(t.notes)}</p>` : ''}
${w.body ? `<div class="profile"><span>${T.body} ${dots(w.body, lang)}</span><span>${T.sweetness} ${dots(w.sweetness, lang)}</span><span>${T.acidity} ${dots(w.acidity, lang)}</span><span>${T.tannin} ${dots(w.tannin, lang)}</span></div>` : ''}
<section class="where"><h2>${esc(T.whereH)}</h2>
<p class="status ok">${esc(nStores === 1 ? T.stores1 : T.storesN(nStores))}${priced.length > 1 ? esc(T.cheapestFirst) : ''}.</p>
${where}
<p><a class="btn primary" href="${up}?q=${encodeURIComponent(w.name)}">${esc(T.findNear)}</a></p>
</section>
${t.story || t.label || sizes ? `<section><h2>${esc(T.aboutH)}</h2>
${t.story ? `<p>${esc(t.story)}</p>` : ''}
${t.label ? `<p><b>${esc(T.onShelf)}</b> ${esc(t.label)}</p>` : ''}
${sizes ? `<p><b>${esc(T.sizesMade)}</b> ${esc(sizes)}. ${esc(T.sizesNote)}</p>` : ''}
</section>` : ''}
${pairings.length ? `<section><h2>${esc(T.eatH)}</h2><ol class="pairs">
${pairings.map((p) => `<li><b>${esc(p.dish)}</b>${p.why ? `. ${esc(p.why)}` : ''}${p.recipe ? `<br><span class="small">${esc(T.recipeIdea)} ${esc(p.recipe)}</span>` : ''}${p.recipe_url ? ` <a class="small" href="${esc(p.recipe_url)}" rel="noopener nofollow" target="_blank">${esc(T.fullRecipe)}</a>` : ''}</li>`).join('\n')}
</ol></section>` : (t.pairing ? `<section><h2>${esc(T.eatH)}</h2><p>${esc(t.pairing)}</p></section>` : '')}
${similar.length ? `<section><h2>${esc(T.similarH)}</h2><ul class="links">${similar.map((x) => { const xt = wineText(x, lang); return `<li><a href="${up}${wPath(x, lang)}">${esc(x.name)}</a> <span class="small muted">${esc(xt.meta)}</span></li>`; }).join('')}</ul></section>` : ''}
${Array.isArray(w.sources) && w.sources.length ? `<p class="small muted">${esc(T.sources)} ${w.sources.slice(0, 3).map((u) => { try { return `<a href="${esc(u)}" rel="noopener nofollow" target="_blank">${esc(new URL(u).hostname.replace(/^www\./, ''))}</a>`; } catch { return ''; } }).filter(Boolean).join(', ')}</p>` : ''}
</article>`;
    const noindex = !wineIndexable(w, lang);
    out(`${path}index.html`, page({ lang, title: T.wineTitle(w.name), description: desc.slice(0, 300), path, body, noindex, alternates }));
    winePages++;
    if (!noindex) sitemap.push({ path, alternates: alternates.filter((a) => wineIndexable(w, a.lang)) });
  }
}

// Store pages (en, es, nl, pap)
let storePages = 0;
for (const s of stores) {
  const langs = STORE_LANGS.filter((lang) => storeHasLang(s, lang));
  const alternates = langs.map((lang) => ({ lang, path: sPath(s, lang) }));
  const list = wines.flatMap((w) => w.offers.filter((o) => o.store_id === s.id).map((o) => ({ w, o })));
  for (const lang of langs) {
    const T = L[lang]; const path = sPath(s, lang); const up = '../'.repeat(path.split('/').filter(Boolean).length);
    const groups = COLOR_ORDER.map((c) => [c, list.filter((x) => x.w.color === c)]).filter(([, l]) => l.length);
    const other = list.filter((x) => !COLOR_ORDER.includes(x.w.color));
    if (other.length) groups.push(['other', other]);
    const blurb = storeBlurb(s, lang);
    const body = `<p class="crumbs small"><a href="${up}${T.prefix}store/">${esc(T.allStores)}</a></p>
<article class="pg-store">
<h1>${esc(s.name)}</h1>
<p class="meta">${esc(s.address || '')}</p>
${storeHours(s, lang) ? `<p><b>${esc(T.open)}</b> ${esc(storeHours(s, lang))}</p>` : ''}
${s.phone ? `<p><b>${esc(T.phone)}</b> <a href="tel:${esc(s.phone.replace(/\s+/g, ''))}">${esc(s.phone)}</a></p>` : ''}
<p><a class="btn primary" href="${mapsUrl(s)}" rel="noopener" target="_blank">${esc(T.directions)}</a></p>
${blurb ? `<p>${esc(blurb)}</p>` : ''}
<section><h2>${esc(T.winesAtH(s.name))}</h2>
<p class="small muted">${esc(T.seenHere(list.length, DATA.price_days))}</p>
${groups.map(([c, l]) => `<h3>${esc(T.colors[c] || T.colors.other)}</h3><ul class="links wines">${l.sort((a, b) => a.w.name.localeCompare(b.w.name)).map(({ w, o }) =>
  `<li><a href="${wineHref(w, lang, up)}">${esc(w.name)}</a>${o.price != null ? ` <span class="pp">${money(o)}${o.size_ml && o.size_ml !== 750 ? ` (${sizeLabel(o.size_ml)})` : ''}</span>` : ''}</li>`).join('')}</ul>`).join('\n')}
</section>
</article>`;
    const noindex = list.length < 3;
    out(`${path}index.html`, page({ lang, title: T.storeTitle(s.name), description: T.storeDesc(s.name, list.length, s.address || 'Aruba'), path, body, noindex, alternates }));
    storePages++;
    if (!noindex) sitemap.push({ path, alternates });
  }
}

// Index pages per language
for (const lang of WINE_LANGS) {
  const T = L[lang];
  const list = wines.filter((w) => wineLangs(w).includes(lang));
  if (!list.length) continue;
  const idx = COLOR_ORDER.map((c) => [c, list.filter((w) => w.color === c)]).filter(([, l]) => l.length)
    .map(([c, l]) => `<h2>${esc(T.colors[c])}</h2><ul class="links wines">${l.map((w) => `<li><a href="${w.slug}/">${esc(w.name)}</a> <span class="small muted">${esc(wineText(w, lang).meta)}</span></li>`).join('')}</ul>`).join('\n');
  const path = `${T.prefix}wine/`;
  const alternates = WINE_LANGS.filter((l2) => wines.some((w) => wineLangs(w).includes(l2))).map((l2) => ({ lang: l2, path: `${L[l2].prefix}wine/` }));
  out(`${path}index.html`, page({ lang, title: T.wineIndexTitle, description: T.wineIndexDesc(list.length), path, alternates,
    body: `<h1>${esc(T.wineIndexH)}</h1><p class="meta">${esc(T.wineIndexLede(list.length, stores.length))}</p>${idx}` }));
  sitemap.push({ path, alternates });
}
for (const lang of STORE_LANGS) {
  const T = L[lang];
  const list = stores.filter((s) => storeHasLang(s, lang));
  if (!list.length) continue;
  const path = `${T.prefix}store/`;
  const alternates = STORE_LANGS.filter((l2) => stores.some((s) => storeHasLang(s, l2))).map((l2) => ({ lang: l2, path: `${L[l2].prefix}store/` }));
  out(`${path}index.html`, page({ lang, title: T.storeIndexTitle, description: T.storeIndexDesc(list.map((s) => s.name).join(', ')), path, alternates,
    body: `<h1>${esc(T.storeIndexH)}</h1><p class="meta">${esc(T.storeIndexLede)}</p><ul class="links">${list.map((s) => `<li><a href="${s.slug}/">${esc(s.name)}</a> <span class="small muted">${esc(s.address || '')}, ${esc(T.nWines(s.wines))}</span></li>`).join('')}</ul>` }));
  sitemap.push({ path, alternates });
}

// Sitemap with hreflang alternates; only pages worth indexing
const head = [{ path: '', alternates: [] }, { path: 'privacy.html', alternates: [] }];
const all = [...head, ...sitemap];
writeFileSync(join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${all.map((u) => `  <url><loc>${SITE}/${u.path}</loc><lastmod>${today}</lastmod>${u.alternates.length > 1 ? u.alternates.map((a) => `<xhtml:link rel="alternate" hreflang="${HREF[a.lang]}" href="${SITE}/${a.path}"/>`).join('') : ''}</url>`).join('\n')}
</urlset>
`);
console.log(`Built ${winePages} wine pages and ${storePages} store pages across languages; sitemap ${all.length} URLs.`);
