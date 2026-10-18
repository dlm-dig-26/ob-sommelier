/* OB Sommelier — consumer app.
 * Data path: demo.json (demo mode) or Supabase RPC `nearby_offers` (live mode).
 * Matching, price ranking and similarity fallback run client-side: fine for an
 * island-sized catalog (a few thousand rows). Move server-side past ~5k wines.
 */
(() => {
  'use strict';

  const CFG = window.OB_CONFIG || {};
  const LIVE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const CENTER = CFG.DEFAULT_CENTER || { lat: 12.5186, lng: -70.0358, label: 'Oranjestad' };
  const STALE_DAYS = CFG.STALE_AFTER_DAYS || 30;
  const PRICE_DAYS = CFG.PRICE_VALID_DAYS || 90; // a price is shown only if confirmed (photo, price list, store) within this window
  const ISLAND_KM = 40;
  const DAY = 86400000;
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  const TESSERACT_JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
  };

  const state = {
    wines: [], winesById: new Map(),
    demo: null, sb: null,
    pos: { lat: CENTER.lat, lng: CENTER.lng }, posLabel: CENTER.label,
    radius: store.get('ob.radius', CFG.DEFAULT_RADIUS_KM || 10),
    offers: [], offersKey: '',
    lastQuery: '', lastSource: 'text',
    searches: 0,
    popularity: new Map(), mine: new Map()
  };

  // ---------- DOM helper (no innerHTML with data: XSS-safe) ----------
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
    return n;
  }
  const loadScript = (src) => new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = el('script', { src, crossorigin: 'anonymous' });
    s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src));
    document.head.append(s);
  });

  // ---------- Geo ----------
  function haversineKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function locate(silent) {
    if (!('geolocation' in navigator)) { if (!silent) toastScan('Location not available on this device.'); return; }
    $('locLabel').textContent = '… finding you';
    navigator.geolocation.getCurrentPosition((p) => {
      state.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      state.posLabel = 'you';
      store.set('ob.geoOk', true);
      $('locLabel').textContent = state.posLabel;
      refresh();
    }, () => {
      $('locLabel').textContent = state.posLabel;
      if (!silent) toastScan(`Location is turned off for this site, so distances are measured from ${CENTER.label}. Allow location in your browser settings to fix this.`);
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }

  // ---------- Data ----------
  async function init() {
    if (LIVE) {
      await loadScript(SUPABASE_JS);
      state.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      const { data, error } = await state.sb.from('wines').select('*').is('merged_into', null).limit(5000);
      if (error) throw error;
      state.wines = data;
      const pop = await state.sb.rpc('popular_wines', { p_days: 30 });
      if (!pop.error) for (const r of pop.data) state.popularity.set(r.wine_id, Number(r.searches));
    } else {
      const r = await fetch('data/demo.json', { cache: 'no-cache' });
      state.demo = await r.json();
      const storesById = new Map(state.demo.stores.map((s) => [s.id, s]));
      state.demo.allOffers = state.demo.listings.map((l) => {
        const s = storesById.get(l.store_id);
        return {
          wine_id: l.wine_id, store_id: s.id, store_name: s.name, address: s.address,
          lat: s.lat, lng: s.lng, price: l.price ?? null, currency: 'AWG', source: l.source || 'vendor', size_ml: l.size_ml || 750,
          last_confirmed: new Date(Date.now() - s.confirmed_days_ago * DAY).toISOString()
        };
      });
      state.wines = state.demo.wines;
      $('modeBadge').hidden = false;
    }
    state.wines.forEach((w) => { w._idx = indexWine(w); state.winesById.set(w.id, w); });
  }

  // Whole-island offers, used for "closest taste" suggestions when nothing fits within the radius.
  async function getIslandOffers() {
    if (state.radius >= ISLAND_KM) return getOffers();
    const key = `${state.pos.lat.toFixed(4)},${state.pos.lng.toFixed(4)},island`;
    if (key === state.islandKey) return state.islandOffers;
    state.islandOffers = await fetchOffers(ISLAND_KM);
    state.islandKey = key;
    return state.islandOffers;
  }

  async function getOffers() {
    const key = `${state.pos.lat.toFixed(4)},${state.pos.lng.toFixed(4)},${state.radius}`;
    if (key === state.offersKey) return state.offers;
    state.offers = await fetchOffers(state.radius);
    state.offersKey = key;
    return state.offers;
  }

  async function fetchOffers(radius) {
    let rows;
    if (LIVE) {
      const { data, error } = await state.sb.rpc('nearby_offers_v4', {
        p_lat: state.pos.lat, p_lng: state.pos.lng, p_radius_km: radius, p_price_days: PRICE_DAYS
      });
      if (error) throw error;
      rows = data;
      // Opening hours (stores.hours) for the stores in range; best-effort, results still show without them.
      const ids = [...new Set(rows.map((r) => r.store_id))];
      if (ids.length) {
        const h = await state.sb.from('stores').select('id,hours').in('id', ids);
        if (!h.error) { const m = new Map(h.data.map((s) => [s.id, s.hours])); rows = rows.map((r) => ({ ...r, hours: m.get(r.store_id) || null })); }
      }
    } else {
      const cutoff = Date.now() - STALE_DAYS * DAY;
      rows = state.demo.allOffers
        .filter((o) => o.source === 'shelf' || Date.parse(o.last_confirmed) >= cutoff) // shelf sightings never expire
        .map((o) => ({ ...o, distance_km: haversineKm(state.pos, o) }))
        .filter((o) => o.distance_km <= radius);
    }
    return rows.map((o) => ({ ...o, price: o.price == null ? null : Number(o.price), distance_km: Number(o.distance_km), source: o.source || 'vendor', size_ml: Number(o.size_ml) || 750 }));
  }

  function logSearch(query, wineId, foundNearby, source) {
    if (!LIVE || !query) return;
    state.sb.from('search_events').insert({
      query: query.slice(0, 200), wine_id: wineId || null, found_nearby: !!foundNearby, source
    }).then(() => {}, () => {});
  }

  // ---------- Matching ----------
  const STOP = new Set(('wine wines vino vin the and with from de di la le del des du der den van von www com net ' +
    'product produce produced bottled contains sulfites sulphites alc vol ml cl liter litre estate vineyards ' +
    'vineyard winery cellars reserva reserve red white tinto blanco rouge blanc').split(' '));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = (s) => [...new Set(norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)))];

  function indexWine(w) {
    const fields = [[w.name, 3], [w.producer, 3], ...(w.aliases || []).map((a) => [a, 3]), [w.varietal, 2], [w.region, 1], [w.country, 1]];
    const map = new Map();
    for (const [f, wt] of fields) for (const t of tokens(f)) map.set(t, Math.max(map.get(t) || 0, wt));
    return map;
  }
  function editDist1(a, b) { // true if Levenshtein distance <= 1
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }
  function matchWines(query) {
    const q = tokens(query);
    if (!q.length) return [];
    const scored = [];
    for (const w of state.wines) {
      let score = 0;
      for (const [t, wt] of w._idx) {
        let best = 0;
        for (const u of q) {
          if (u === t) { best = 1; break; }
          if ((t.length >= 4 && u.length >= 4) && (t.startsWith(u) || u.startsWith(t))) best = Math.max(best, 0.8);
          else if (t.length >= 5 && editDist1(t, u)) best = Math.max(best, 0.7); // OCR tolerance
        }
        score += best * wt;
      }
      if (score >= 2) scored.push({ w, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return [];
    const top = scored[0].score;
    // keep strong matches only, so a precise label scan doesn't list every Cabernet
    return scored.filter((s) => s.score >= top * 0.6).slice(0, 6);
  }

  // Similarity: same color required; varietal, structure (body/sweetness/acidity/tannin), origin.
  function similarity(a, b) {
    if (a.id === b.id || !a.color || a.color !== b.color || b.partial) return 0;
    let s = 1;
    if (norm(a.varietal) === norm(b.varietal)) s += 3;
    for (const k of ['body', 'sweetness', 'acidity', 'tannin']) s += 1 - Math.abs((a[k] || 3) - (b[k] || 3)) / 4;
    if (a.country && a.country === b.country) s += 0.5;
    if (a.region && a.region === b.region) s += 0.5;
    return s; // max 9
  }
  function reasonFor(a, b) {
    if (norm(a.varietal) === norm(b.varietal)) return `Same grape, similar style`;
    const close = ['body', 'sweetness', 'acidity', 'tannin'].filter((k) => Math.abs((a[k] || 3) - (b[k] || 3)) <= 1);
    return close.length >= 3 ? `Similar body and taste, made from ${b.varietal}` : `Closest style in stock, made from ${b.varietal}`;
  }
  // ---------- Taste guess for wines we don't know yet ----------
  // [words in the query, varietal as stored in the catalog, colour, body, sweetness, acidity, tannin]
  // Regions/appellations map to their main grape (Rioja → Tempranillo, Chablis → Chardonnay...).
  const TASTE = [
    ['white zinfandel|white zin', 'White Zinfandel', 'rose', 2, 3, 3, 1],
    ['cabernet sauvignon|cab sauv|cabernet', 'Cabernet Sauvignon', 'red', 4, 1, 3, 4],
    ['cabernet franc|cab franc', 'Cabernet Franc', 'red', 3, 1, 4, 3],
    ['pinot noir|pinot nero|bourgogne rouge|burgundy|bourgogne', 'Pinot Noir', 'red', 2, 1, 4, 2],
    ['sauvignon blanc|sancerre|marlborough|pouilly fume', 'Sauvignon Blanc', 'white', 2, 1, 5, 1],
    ['pinot grigio|pinot gris', 'Pinot Grigio', 'white', 2, 1, 4, 1],
    ['red blend|tinto|rouge|rosso', 'Red blend', 'red', 4, 2, 3, 3],
    ['merlot', 'Merlot', 'red', 3, 1, 3, 3],
    ['malbec|mendoza', 'Malbec', 'red', 4, 1, 3, 3],
    ['shiraz|syrah|barossa', 'Shiraz', 'red', 4, 1, 3, 3],
    ['zinfandel|primitivo', 'Zinfandel', 'red', 4, 2, 3, 3],
    ['tempranillo|rioja|ribera', 'Tempranillo', 'red', 3, 1, 3, 3],
    ['sangiovese|chianti|brunello|montepulciano', 'Sangiovese', 'red', 3, 1, 4, 3],
    ['nebbiolo|barolo|barbaresco', 'Nebbiolo', 'red', 4, 1, 4, 5],
    ['carmenere', 'Carmenère', 'red', 3, 1, 3, 3],
    ['grenache|garnacha|cotes du rhone|chateauneuf', 'Grenache', 'red', 3, 1, 3, 2],
    ['valpolicella|ripasso|amarone|corvina', 'Corvina blend', 'red', 4, 1, 3, 3],
    ['tannat', 'Tannat', 'red', 5, 1, 3, 5],
    ['bonarda', 'Bonarda', 'red', 4, 1, 3, 3],
    ['bordeaux|medoc|saint emilion', 'Cabernet Sauvignon', 'red', 4, 1, 3, 4],
    ['napa', 'Cabernet Sauvignon', 'red', 4, 1, 3, 4],
    ['lambrusco', 'Lambrusco', 'red', 2, 3, 3, 2],
    ['chardonnay|chablis|meursault|pouilly fuisse', 'Chardonnay', 'white', 3, 1, 3, 1],
    ['riesling', 'Riesling', 'white', 2, 3, 4, 1],
    ['moscato|muscat|moscatel', 'Moscato', 'white', 2, 4, 3, 1],
    ['torrontes', 'Torrontés', 'white', 2, 2, 3, 1],
    ['viognier', 'Viognier', 'white', 3, 1, 3, 1],
    ['albarino|alvarinho|vinho verde', 'Albariño', 'white', 2, 1, 4, 1],
    ['blanc|bianco|blanco|white', 'White blend', 'white', 2, 1, 4, 1],
    ['rose|rosado|rosato|provence', 'Rosé', 'rose', 2, 2, 4, 1],
    ['prosecco|cava|champagne|brut|espumante|sparkling|cremant|spumante', 'Sparkling', 'sparkling', 2, 1, 4, 1],
    ['port|porto|oporto', 'Port', 'dessert', 5, 5, 3, 3]
  ];
  // Returns a pretend wine with the typical profile of the grape/region named in the query, or null.
  function guessProfile(query) {
    const q = ` ${norm(query)} `;
    for (const [words, varietal, color, body, sweetness, acidity, tannin] of TASTE) {
      const hit = words.split('|').find((wd) => q.includes(` ${wd} `));
      if (hit) {
        const sweet = /\b(sweet|dulce|doux|dolce|semi seco)\b/.test(q) ? Math.max(sweetness, 4) : sweetness;
        return { id: 'guess', name: query, varietal, color, body, sweetness: sweet, acidity, tannin, _from: varietal };
      }
    }
    return null;
  }
  // Is the best text match really the wine that was asked for? A fuzzy hit on shared words
  // ("Cloudy Bay Sauvignon Blanc" → "Oyster Bay Sauvignon Blanc") must not be shown as that wine.
  // Every distinctive word (brand, cuvée) must appear in the wine, and a named grape must be its grape.
  const GENERIC = new Set(TASTE.flatMap((t) => t[0].split('|').flatMap((p) => p.split(' ')))
    .concat('classico superiore doc docg aoc igt dop selection seleccion vintage old vines'.split(' ')));
  function isExactHit(query, w) {
    const words = new Set(w._idx.keys());
    const has = (u) => words.has(u) || [...words].some((t) => (t.length >= 4 && u.length >= 4 && (t.startsWith(u) || u.startsWith(t))) || (t.length >= 5 && editDist1(t, u)));
    if (!tokens(query).filter((u) => !GENERIC.has(u)).every(has)) return false;
    const g = guessProfile(query);
    if (!g || ['Red blend', 'White blend', 'Rosé', 'Sparkling'].includes(g.varietal)) return true;
    const text = ` ${norm(`${w.name} ${w.varietal || ''} ${w.region || ''}`)} `;
    const words2 = TASTE.find((t) => t[1] === g.varietal)[0].split('|');
    return norm(w.varietal) === norm(g.varietal) || words2.some((wd) => text.includes(` ${wd} `));
  }

  // Closest wines in stock: within the radius first; if none there, the whole island.
  function closestInStock(w, near, island, n) {
    const pick = (offers) => {
      const ids = new Set(offers.map((o) => o.wine_id));
      return state.wines.filter((x) => ids.has(x.id))
        .map((x) => ({ x, s: similarity(w, x) })).filter((r) => r.s >= 4)
        .sort((a, b) => b.s - a.s).slice(0, n)
        .map(({ x }) => ({ x, best: rankOffers(offers.filter((o) => o.wine_id === x.id))[0] }));
    };
    const local = pick(near);
    return local.length ? { list: local, island: false } : { list: pick(island), island: true };
  }
  function suggestionBlock(w, near, island, n) {
    const { list, island: wide } = closestInStock(w, near, island, n);
    if (!list.length) return [];
    return [
      ...(wide && state.radius < ISLAND_KM ? [el('p', { class: 'small muted', text: `Nothing similar within ${radiusLabel()}; closest on the island:` })] : []),
      ...list.flatMap(({ x, best }) => [
        el('div', { class: 'sub-wine' },
          el('div', { class: 'why', text: `Try instead. ${reasonFor(w, x)}:` }),
          el('div', { class: 'name', text: x.name }),
          el('div', { class: 'small muted', text: x.flavor_notes || describe(x) })),
        offerRow(best, best.price != null && !isStale(best))])
    ];
  }

  // Rank on price per 750 ml, so a 1.5 L bottle is compared fairly with a standard bottle.
  const priceKey = (o) => (o.price == null ? Infinity : o.price * 750 / (o.size_ml || 750));
  // A shelf sighting older than STALE_DAYS stays visible as "last known" (different colour, no date).
  const isStale = (o) => Date.now() - Date.parse(o.last_confirmed) > STALE_DAYS * DAY;
  const rankOffers = (list) => [...list].sort((a, b) => isStale(a) - isStale(b) || priceKey(a) - priceKey(b) || a.distance_km - b.distance_km);

  // ---------- Rendering ----------
  const sizeLabel = (ml) => ml >= 1000 ? `${String(ml / 1000).replace('.', ',')} L` : `${ml} ml`;
  const money = (o) => {
    if (o.price == null) return 'Price not listed';
    const size = o.size_ml && o.size_ml !== 750 ? ` · ${sizeLabel(o.size_ml)}` : '';
    return `${o.currency === 'USD' ? 'US$' : 'Afl.'} ${o.price.toFixed(2)}${size}`;
  };
  const km = (d) => d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`;
  function ago(o) {
    if (o.source === 'shelf') {
      const seen = isStale(o) ? 'Last known location, may no longer be in stock' : 'Seen on the shelf recently';
      if (o.price_expired) return `${seen}. Shelf price older than ${PRICE_DAYS} days, not shown`;
      return o.price != null ? `${seen}. Price from the shelf tag` : seen;
    }
    if (o.price_expired) return `Price older than ${PRICE_DAYS} days, not shown`;
    const d = Math.floor((Date.now() - Date.parse(o.price_confirmed_at || o.last_confirmed)) / DAY);
    const when = d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
    // Prices we read from a store's own website are not store-confirmed; say so.
    if (o.source === 'agent') return `Price from the store’s website, checked ${when}`;
    return `price confirmed ${when}`;
  }
  const dots = (n) => el('span', { class: 'dots', role: 'img', 'aria-label': `${n} out of 5` },
    [1, 2, 3, 4, 5].map((i) => el('i', { class: i <= n ? 'on' : '' })));
  const COLOR_LABEL = { red: 'Red', white: 'White', rose: 'Rosé', sparkling: 'Sparkling', dessert: 'Dessert' };
  function describe(w) {
    const origin = [w.region, w.country].filter(Boolean).join(', ');
    const col = COLOR_LABEL[w.color];
    // Avoid "Red Red Blend" / "Rosé Rosé Blend" when the grape name already starts with the colour.
    const what = (w.varietal && col && norm(w.varietal).startsWith(norm(col))) ? w.varietal : [col, w.varietal].filter(Boolean).join(' ');
    return origin ? `${what} from ${origin}` : what;
  }

  function offerRow(o, best) {
    const maps = `https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}`;
    const shelf = o.source === 'shelf';
    return el('div', { class: isStale(o) ? 'offer stale' : 'offer' },
      el('div', null,
        el('a', { href: maps, target: '_blank', rel: 'noopener', class: 'store', text: o.store_name }),
        el('div', { class: 'sub', text: `${km(o.distance_km)} away${o.address ? ', ' + o.address : ''}` }),
        o.hours ? el('div', { class: 'sub', text: `Open: ${o.hours}` }) : null,
        el('div', { class: shelf ? (isStale(o) ? 'sub seen old' : 'sub seen') : 'sub', text: ago(o) })),
      priceTag(o, best),
      reportBar(o));
  }
  // The shelf tag: currency small, amount in printed condensed numerals, bottle size under it when not 750 ml.
  function priceTag(o, best) {
    if (o.price == null) return el('div', { class: 'price none', text: 'No price' });
    return el('div', { class: best ? 'price best' : 'price', role: 'img', 'aria-label': best ? `${money(o)}, lowest price` : money(o) },
      el('span', { class: 'cur', text: o.currency === 'USD' ? 'US$' : 'Afl.' }),
      el('span', { class: 'amt', text: o.price.toFixed(2) }),
      o.size_ml && o.size_ml !== 750 ? el('span', { class: 'size', text: sizeLabel(o.size_ml) }) : null);
  }

  // ---------- Shopper reports: "Found it" / "Not there" (must be at the store) ----------
  function deviceId() {
    let id = store.get('ob.device', null);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
      store.set('ob.device', id);
    }
    return id;
  }
  const REPORT_MSG = {
    confirmed: 'Thanks! Marked as seen today.',
    noted: 'Thanks, noted. We’ll check it.',
    hidden: 'Thanks. Hidden until someone sees it again.',
    too_far: 'You need to be at the store to report. Try again inside.',
    already_reported: 'You already reported this today.',
    rate_limited: 'Report limit reached for today.',
    not_found: 'This listing was just updated. Search again.',
    invalid: 'Could not send the report.'
  };
  function reportBar(o) {
    const bar = el('div', { class: 'report' });
    const done = (msg) => bar.replaceChildren(el('span', { class: 'small muted', text: msg }));
    const send = (kind) => {
      if (!LIVE || !o.listing_id) return done('Reporting works in the live app.');
      if (!('geolocation' in navigator)) return done('Location is needed to report.');
      done('Checking your location…');
      navigator.geolocation.getCurrentPosition(async (p) => {
        const { data, error } = await state.sb.rpc('report_availability', {
          p_listing_id: o.listing_id, p_kind: kind, p_device: deviceId(),
          p_lat: p.coords.latitude, p_lng: p.coords.longitude
        });
        if (error) { console.error(error); return done('Could not send the report. Check your connection.'); }
        done(REPORT_MSG[data] || REPORT_MSG.invalid);
        if (data === 'confirmed' || data === 'hidden') state.offersKey = ''; // next search reloads fresh data
      }, () => done('Allow location for this site to report from the store.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    };
    bar.append(el('span', { class: 'small muted', text: 'At the store?' }),
      el('button', { class: 'rbtn', type: 'button', text: 'Found it', onclick: () => send('found') }),
      el('button', { class: 'rbtn', type: 'button', text: 'Not there', onclick: () => send('missing') }));
    return bar;
  }

  function wineCard(w, offers, allOffers, island = allOffers) {
    const mine = rankOffers(offers.filter((o) => o.wine_id === w.id));
    const card = el('article', { class: 'wine' },
      el('h3', { text: w.name }),
      el('p', { class: 'meta', text: describe(w) }),
      w.flavor_notes ? el('p', { class: 'notes', text: w.flavor_notes }) : null,
      w.partial
        ? el('p', { class: 'small muted', text: 'Read from a shelf photo; full details coming soon.' })
        : el('div', { class: 'profile' },
          el('span', null, 'Body', dots(w.body)), el('span', null, 'Sweetness', dots(w.sweetness)),
          el('span', null, 'Acidity', dots(w.acidity)), el('span', null, 'Tannin', dots(w.tannin))));

    const where = el('div', { class: 'where' });
    if (mine.length) {
      const n = mine.filter((o) => !isStale(o)).length;
      const status = n === 0
        ? el('p', { class: 'status warn', text: `Not seen recently within ${radiusLabel()}. Last known stores:` })
        : el('p', { class: 'status ok', text: n === 1 ? `1 store within ${radiusLabel()} has it.` : `${n} stores within ${radiusLabel()} have it. Cheapest first.` });
      where.append(status,
        ...mine.map((o, i) => offerRow(o, i === 0 && o.price != null && !isStale(o))));
    } else {
      // Not within the radius. 1) Show where on the island it IS, if anywhere.
      // 2) Always suggest the closest taste in stock (radius first, then island), so the
      //    shopper can choose between driving further and buying something similar nearby.
      const far = rankOffers(island.filter((o) => o.wine_id === w.id));
      if (far.length) {
        where.append(el('p', { class: 'status warn', text: `Not within ${radiusLabel()}. Nearest: ${km(Math.min(...far.map((o) => o.distance_km)))} away.` }),
          ...far.slice(0, 3).map((o, i) => offerRow(o, i === 0 && o.price != null && !isStale(o))));
      } else {
        where.append(el('p', { class: 'status warn', text: 'No store in Aruba has it right now.' }));
      }
      const subs = w.partial && !w.color ? [] : suggestionBlock(w, allOffers, island, 2);
      if (subs.length) {
        if (far.length) where.append(el('p', { class: 'small muted', text: 'Or something that tastes like it:' }));
        where.append(...subs);
      } else {
        where.append(el('p', { class: 'small muted', text: 'Nothing with a similar taste is in stock on the island yet.' }));
      }
    }
    card.append(where);

    const recipeBox = el('div');
    card.append(el('div', { class: 'pair-line' },
      el('b', { text: 'Goes well with ' }), (w.pairing || pairingFor(w)).replace(/^./, (c) => c.toLowerCase()), '. ',
      el('button', { class: 'linkbtn', type: 'button', onclick: (e) => { e.target.remove(); loadRecipes(w, recipeBox); }, text: 'Recipe ideas' }),
      recipeBox));
    return card;
  }

  const radiusLabel = () => state.radius >= 40 ? 'the whole island' : `${state.radius} km`;

  function renderEmpty(title, hint, extra) {
    $('results').replaceChildren(el('div', { class: 'empty' },
      el('p', { style: 'font-weight:600', text: title }), hint ? el('p', { class: 'small muted', text: hint }) : null, extra || null));
  }

  // A wine we don't know yet: still answer with the closest taste in stock.
  // Grape/region in the query → typical profile. Otherwise ask for the grape (one tap).
  function renderUnknown(query, guess, near, island) {
    const head = [
      el('p', { style: 'font-weight:600', text: `“${query}” isn’t in our catalog yet.` }),
      el('p', { class: 'small muted', text: LIVE ? 'We logged it and will look it up, so it can show up in future searches.' : 'Try the producer name or grape.' })
    ];
    const box = el('div', { class: 'where' });
    const show = (g) => {
      const subs = suggestionBlock(g, near, island, 3);
      box.replaceChildren(subs.length
        ? el('p', { class: 'status ok', text: `Closest in taste to a typical ${g._from}, in stock:` })
        : el('p', { class: 'status warn', text: `Nothing like a typical ${g._from} is in stock on the island yet.` }), ...subs);
    };
    if (guess) {
      show(guess);
    } else {
      const grapes = ['Cabernet Sauvignon', 'Malbec', 'Merlot', 'Pinot Noir', 'Red blend', 'Chardonnay', 'Sauvignon Blanc', 'Pinot Grigio', 'Moscato', 'Rosé', 'Prosecco'];
      box.append(el('p', { class: 'small', text: 'What grape or style is it? We’ll suggest the closest taste in stock:' }),
        el('div', { class: 'grape-list' }, grapes.map((g) => el('button', {
          class: 'chip', type: 'button', text: g, onclick: () => show(guessProfile(g))
        }))));
    }
    $('results').replaceChildren(el('div', { class: 'empty' }, ...head), el('article', { class: 'wine' }, box));
  }

  async function runSearch(query, source = 'text') {
    state.lastQuery = query; state.lastSource = source;
    const res = $('results');
    $('priceNote').hidden = !query.trim();
    if (!query.trim()) { res.replaceChildren(); return; }
    res.replaceChildren(el('div', { class: 'empty small muted', text: 'Searching…' }));
    // A search started while the catalog is still loading waits for it instead of failing silently.
    try { await state.ready; } catch { renderEmpty('Could not load the wine catalog.', 'Check your connection and reload.'); return; }
    let offers;
    try { offers = await getOffers(); } catch (e) {
      console.error(e); renderEmpty('Could not load store data.', 'Check your connection and try again.'); return;
    }
    let matches = matchWines(query);
    // Typed searches: keep only wines that really are the one asked for (label scans stay fuzzy, OCR is noisy).
    const fuzzyTop = matches[0] && matches[0].w;
    if (source === 'text') matches = matches.filter((m) => isExactHit(query, m.w));
    if (!matches.length) {
      logSearch(query, null, false, source);
      if (source === 'scan') { renderEmpty('Couldn’t recognize that label.', 'Try a sharper photo of the front label, or type the name.'); return; }
      let island = offers;
      try { island = await getIslandOffers(); } catch (e) { console.error(e); }
      // No grape/region in the query but a near-miss in the catalog: use that wine's profile as the guide.
      const guess = guessProfile(query) || (fuzzyTop && fuzzyTop.color && !fuzzyTop.partial
        ? { ...fuzzyTop, id: 'guess', _from: fuzzyTop.varietal || describe(fuzzyTop) } : null);
      renderUnknown(query, guess, offers, island);
      return;
    }
    // Order: best text match first; among equal matches, in-stock nearby first, then cheapest.
    const bestPrice = (w) => Math.min(...offers.filter((o) => o.wine_id === w.id).map(priceKey), Infinity);
    const nearby = (w) => offers.some((o) => o.wine_id === w.id);
    matches.sort((a, b) => (b.score - a.score) || (nearby(b.w) - nearby(a.w)) || (bestPrice(a.w) - bestPrice(b.w)));
    const wines = matches.map((m) => m.w);
    logSearch(query, wines[0].id, nearby(wines[0]), source);
    personalizeGuide(wines[0]);
    let island = offers;
    if (wines.some((w) => !nearby(w))) { try { island = await getIslandOffers(); } catch (e) { console.error(e); } }
    res.replaceChildren(...wines.map((w) => wineCard(w, offers, offers, island)));
    state.searches++;
    maybeInterstitial();
  }
  const refresh = () => { if (state.lastQuery) runSearch(state.lastQuery, state.lastSource); };
  function setRadius(r) {
    state.radius = Number(r); store.set('ob.radius', state.radius);
    $('radius').value = String(state.radius); refresh();
  }

  // ---------- Label scan (on-device OCR, free, no per-scan cost) ----------
  function toastScan(msg) { const s = $('scanStatus'); s.hidden = !msg; s.textContent = msg || ''; }
  async function downscale(file, max = 1600) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = el('canvas', { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    const ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(1.4)';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }
  async function handleScan(file) {
    if (!file) return;
    try {
      toastScan('Getting the label reader ready. The first scan downloads about 4 MB.');
      await loadScript(TESSERACT_JS);
      const img = await downscale(file);
      const { data } = await window.Tesseract.recognize(img, 'eng', {
        logger: (m) => { if (m.status === 'recognizing text') toastScan(`Reading label… ${Math.round(m.progress * 100)}%`); }
      });
      const text = (data.text || '').replace(/\s+/g, ' ').trim();
      toastScan(text ? `Read from label: “${text.slice(0, 80)}${text.length > 80 ? '…' : ''}”` : '');
      await runSearch(text, 'scan');
    } catch (e) {
      console.error(e);
      toastScan('The label reader could not start. Check your connection, or type the wine name instead.');
    } finally {
      $('scanInput').value = '';
    }
  }

  // ---------- Pairings & recipes ----------
  // Pairing library: food first, because that is how people decide at the shelf.
  // [dish, grapes to search for, why it works]
  const PAIRINGS = [
    ['Stobá (goat or beef stew)', ['Malbec', 'Shiraz', 'Tempranillo'], 'Slow-cooked meat and gravy need a red with body and soft tannins. A lighter wine disappears next to it.'],
    ['Keshi yena', ['Pinot Noir', 'Tempranillo', 'Chardonnay'], 'Melted Gouda and spiced filling: pick medium body and fresh acidity. Strong tannin clashes with the cheese.'],
    ['Pisca hasa (fried fish, Creole sauce)', ['Sauvignon Blanc', 'Pinot Grigio', 'Rosé'], 'Crisp acidity cuts through the frying oil and stands up to lime and onion.'],
    ['Ceviche and raw seafood', ['Sauvignon Blanc', 'Chardonnay', 'Prosecco'], 'Citrus marinades call for unoaked, high-acid whites. Chablis is Chardonnay without the oak.'],
    ['Steak and barbecue', ['Cabernet Sauvignon', 'Malbec', 'Shiraz'], 'Char and fat soften firm tannins, so this is where big reds taste best.'],
    ['Chicken and pork', ['Pinot Noir', 'Chardonnay', 'Tempranillo'], 'Lean meats suit lighter reds or fuller whites. Match the sauce more than the meat.'],
    ['Pastechi, croquettes and fried snacks', ['Prosecco', 'Cava', 'Champagne'], 'Bubbles and acidity reset your mouth between salty, fried bites.'],
    ['Spicy food (Madame Jeanette pepper)', ['Rosé', 'Lambrusco', 'Riesling'], 'A touch of sweetness calms the heat. High-alcohol reds make spice burn more.'],
    ['Pasta with tomato sauce, pizza', ['Sangiovese', 'Chianti', 'Malbec'], 'Tomato is acidic, so the wine needs at least as much acidity. Italian reds are built for it.'],
    ['Cheese board and charcuterie', ['Pinot Noir', 'Sangiovese', 'Lambrusco'], 'Acidity and moderate tannin balance salt and fat. Aged Gouda also loves a big Cabernet.'],
    ['Desserts and chocolate', ['Lambrusco', 'Mateus Rosé'], 'The wine should be sweeter than the dessert, or both will taste sour.']
  ];
  // A guide entry fits a wine when one of its grapes/styles appears in the wine's name, grape or colour.
  const fits = (g, w) => ` ${norm(`${w.name} ${w.varietal || ''} ${COLOR_LABEL[w.color] || ''}`)} `.includes(` ${norm(g)} `);
  // Popularity = searches across all users (live) plus this visitor's own searches (personal boost).
  function entryScore([, grapes]) {
    let n = 0;
    for (const w of state.wines) if (grapes.some((g) => fits(g, w))) n += (state.popularity.get(w.id) || 0) + 3 * (state.mine.get(w.id) || 0);
    return n;
  }
  function pairEntry([dish, grapes, why], open) {
    return el('details', { class: 'pair', open },
      el('summary', null, el('span', { class: 'dish', text: dish }), el('span', { class: 'wines', text: grapes.join(', ') })),
      el('div', { class: 'body' },
        el('p', { text: why }),
        el('div', { class: 'grape-list', 'aria-label': 'Find these nearby' }, grapes.map((g) =>
          el('button', { class: 'chip', type: 'button', text: `Find ${g} nearby`, onclick: () => {
            $('q').value = g; runSearch(g, 'text');
            $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
          } })))));
  }
  // focus = the wine the visitor just searched for (or null for the default, popularity-ordered guide)
  function renderGuide(focus) {
    let picked = [];
    if (focus) {
      picked = PAIRINGS.filter((p) => p[1].some((g) => fits(g, focus))).slice(0, 3);
      // Not enough library entries for this wine: use the wine's own pairing notes.
      const own = String(focus.pairing || pairingFor(focus)).split(',').map((x) => x.trim()).filter(Boolean);
      for (const dish of own) {
        if (picked.length >= 3) break;
        if (picked.some((p) => norm(p[0]).includes(norm(dish)))) continue;
        picked.push([dish.replace(/^./, (c) => c.toUpperCase()), [focus.varietal || COLOR_LABEL[focus.color]], `A good match for the style of ${focus.name}: ${describe(focus).replace(/^./, (c) => c.toLowerCase())}.`]);
      }
    }
    const rest = PAIRINGS.filter((p) => !picked.includes(p))
      .map((p, i) => ({ p, i, s: entryScore(p) }))
      .sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.p);
    const hasPopularity = rest.some((p) => entryScore(p) > 0);
    const blocks = [];
    if (picked.length) {
      blocks.push(el('p', { class: 'guide-group', text: `Picked for ${focus.name}` }), ...picked.map((p, i) => pairEntry(p, i === 0)));
      blocks.push(el('p', { class: 'guide-group', text: hasPopularity ? 'Popular pairings' : 'More pairings' }));
    } else if (hasPopularity) {
      blocks.push(el('p', { class: 'guide-group', text: 'Popular pairings' }));
    }
    blocks.push(...rest.map((p) => pairEntry(p, false)));
    $('pairings').replaceChildren(...blocks);
    $('guideSub').textContent = picked.length
      ? `Picked for ${focus.name}: ${picked.map((p) => p[0].replace(/\s*\(.*\)$/, '').toLowerCase()).join(', ')}`
      : 'What to drink with stobá, keshi yena, fresh fish and more';
  }
  function personalizeGuide(w) {
    state.mine.set(w.id, (state.mine.get(w.id) || 0) + 1);
    renderGuide(w);
  }
  function pairingFor(w) {
    if (w.color === 'red') return w.body >= 4 ? 'Grilled red meat, hard cheeses' : 'Poultry, pasta, mushrooms';
    if (w.color === 'white') return w.body >= 4 ? 'Lobster, creamy dishes' : 'Fish, seafood, salads';
    if (w.color === 'sparkling') return 'Appetizers, fried food, seafood';
    return 'Light dishes, salads, grilled fish';
  }
  function recipeIngredient(w) {
    if (w.color === 'red') return w.body >= 4 ? 'beef' : w.body >= 3 ? 'pork' : 'chicken';
    if (w.color === 'white') return w.body >= 4 ? 'chicken' : 'salmon';
    if (w.color === 'sparkling') return 'prawns';
    return 'chicken';
  }
  async function loadRecipes(w, box) {
    box.replaceChildren(el('div', { class: 'small muted', text: 'Loading recipes…' }));
    try {
      const r = await fetch(`https://www.themealdb.com/api/json/v1/1/filter.php?i=${recipeIngredient(w)}`);
      const meals = ((await r.json()).meals || []).sort(() => Math.random() - 0.5).slice(0, 3);
      box.replaceChildren(el('div', { class: 'recipes' }, meals.map((m) =>
        el('a', { class: 'recipe', href: `https://www.themealdb.com/meal/${encodeURIComponent(m.idMeal)}`, target: '_blank', rel: 'noopener' },
          el('img', { src: `${m.strMealThumb}/preview`, alt: '', loading: 'lazy' }), el('span', { text: m.strMeal })))));
    } catch {
      box.replaceChildren(el('div', { class: 'small muted', text: 'Recipes unavailable offline.' }));
    }
  }

  // ---------- Ads (house ads only; never on launch; rate-limited) ----------
  const HOUSE_ADS = [
    ['Your store here', 'List your wines and reach shoppers who are searching nearby.', 'vendor.html'],
    ['Featured placement', 'Be the first result for your best-sellers. Ask about sponsored listings.', 'vendor.html']
  ];
  function adNode([title, body, href]) {
    return [el('p', { class: 'tag', text: 'Sponsored' }),
      el('a', { href, style: 'color:inherit;text-decoration:none' }, el('b', { text: title }), '. ', body)];
  }
  function setupAds() {
    if (!CFG.ADS_ENABLED) return;
    $('adTop').replaceChildren(...adNode(HOUSE_ADS[0])); $('adTop').hidden = false;
    $('adBottom').replaceChildren(...adNode(HOUSE_ADS[1])); $('adBottom').hidden = false;
  }
  function maybeInterstitial() {
    if (!CFG.ADS_ENABLED || state.searches < (CFG.INTERSTITIAL_AFTER_SEARCHES || 3)) return;
    const last = store.get('ob.lastInterstitial', 0);
    if (Date.now() - last < (CFG.INTERSTITIAL_MIN_GAP_MIN || 20) * 60000) return;
    store.set('ob.lastInterstitial', Date.now());
    // Delay so the user sees their results first.
    setTimeout(() => {
      $('interstitialBody').replaceChildren(el('h2', { text: 'OB Sommelier Pro' }),
        el('p', { class: 'muted', text: 'No ads, saved favorite stores and price-drop alerts. Coming soon.' }));
      $('interstitial').hidden = false;
    }, 4000);
  }

  // ---------- Age gate ----------
  function ageGate() {
    return new Promise((resolve) => {
      if (store.get('ob.ageOk', false)) return resolve();
      $('minAge').textContent = CFG.MIN_AGE || 18;
      $('ageGate').hidden = false;
      $('ageYes').onclick = () => { store.set('ob.ageOk', true); $('ageGate').hidden = true; resolve(); };
      $('ageNo').onclick = () => { $('ageGate').hidden = true; $('ageBlocked').hidden = false; };
    });
  }

  // ---------- Boot ----------
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    $('staleDays').textContent = STALE_DAYS;
    $('radius').value = String(state.radius);
    $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); $('q').blur(); toastScan(''); runSearch($('q').value, 'text'); });
    $('radius').addEventListener('change', (e) => setRadius(e.target.value));
    $('locBtn').addEventListener('click', () => locate(false));
    // One button, no `capture` attribute: the phone asks "Take photo" or "Photo library / Files",
    // so shoppers can scan a bottle or use a photo they already have. No camera permission needed.
    $('scanBtn').addEventListener('click', () => { toastScan(''); $('scanInput').click(); });
    $('scanInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handleScan(f).finally(() => { e.target.value = ''; }); });
    $('interstitialClose').addEventListener('click', () => { $('interstitial').hidden = true; });
    $('suggest').replaceChildren(el('span', { class: 'chips-lead', text: 'Often searched' }), ...['Cabernet', 'Malbec', 'Pinot Noir', 'Sauvignon Blanc', 'Prosecco', 'Rosé'].map((s) =>
      el('button', { class: 'chip', type: 'button', text: s, onclick: () => { $('q').value = s; runSearch(s, 'text'); } })));

    await ageGate();
    setupAds();
    state.ready = init();
    try { await state.ready; } catch (e) {
      console.error(e); renderEmpty('Could not load the wine catalog.', 'Check your connection and reload.'); return;
    }
    renderGuide(null);
    if (store.get('ob.geoOk', false)) locate(true);
    // Deep link from the public wine pages: ?q=<wine name> runs that search straight away.
    const q0 = (new URLSearchParams(location.search).get('q') || '').trim().slice(0, 120);
    if (q0) { $('q').value = q0; runSearch(q0, 'text'); }
  }
  boot();
})();
