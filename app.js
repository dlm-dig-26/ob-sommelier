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

  async function getOffers() {
    const key = `${state.pos.lat.toFixed(4)},${state.pos.lng.toFixed(4)},${state.radius}`;
    if (key === state.offersKey) return state.offers;
    let rows;
    if (LIVE) {
      const { data, error } = await state.sb.rpc('nearby_offers_v3', {
        p_lat: state.pos.lat, p_lng: state.pos.lng, p_radius_km: state.radius, p_stale_days: STALE_DAYS
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
        .filter((o) => o.distance_km <= state.radius);
    }
    state.offers = rows.map((o) => ({ ...o, price: o.price == null ? null : Number(o.price), distance_km: Number(o.distance_km), source: o.source || 'vendor', size_ml: Number(o.size_ml) || 750 }));
    state.offersKey = key;
    return state.offers;
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
  // Rank on price per 750 ml, so a 1.5 L bottle is compared fairly with a standard bottle.
  const priceKey = (o) => (o.price == null ? Infinity : o.price * 750 / (o.size_ml || 750));
  // A shelf sighting older than STALE_DAYS stays visible as "last known" (different colour, no date).
  const isStale = (o) => o.source === 'shelf' && Date.now() - Date.parse(o.last_confirmed) > STALE_DAYS * DAY;
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
      return o.price != null ? `${seen}. Price from the shelf tag` : seen;
    }
    const d = Math.floor((Date.now() - Date.parse(o.last_confirmed)) / DAY);
    return `price confirmed ${d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`}`;
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
        el('div', { class: shelf ? (isStale(o) ? 'sub seen old' : 'sub seen') : 'sub', text: ago(o) }),
        reportBar(o)),
      el('div', { class: o.price == null ? 'price none' : best ? 'price best' : 'price', 'aria-label': best && o.price != null ? `${money(o)}, lowest price` : money(o) }, money(o)));
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
    bar.append(el('span', { class: 'small muted', text: 'At the store? ' }),
      el('button', { class: 'linkbtn', type: 'button', text: 'Found it', onclick: () => send('found') }), ' · ',
      el('button', { class: 'linkbtn', type: 'button', text: 'Not there', onclick: () => send('missing') }));
    return bar;
  }

  function wineCard(w, offers, allOffers) {
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
      // Fallback: most similar wines that ARE available within the radius.
      const availIds = new Set(allOffers.map((o) => o.wine_id));
      const subs = state.wines
        .filter((x) => availIds.has(x.id))
        .map((x) => ({ x, s: similarity(w, x) }))
        .filter((r) => r.s >= 4)
        .sort((a, b) => b.s - a.s)
        .slice(0, 2);
      where.append(el('p', { class: 'status warn', text: `No store within ${radiusLabel()} has it right now.` }));
      if (subs.length) {
        subs.forEach(({ x }) => {
          const best = rankOffers(allOffers.filter((o) => o.wine_id === x.id))[0];
          where.append(el('div', { class: 'sub-wine' },
            el('div', { class: 'why', text: `Try instead. ${reasonFor(w, x)}:` }),
            el('div', { class: 'name', text: x.name }),
            el('div', { class: 'small muted', text: x.flavor_notes || '' })),
          offerRow(best, best.price != null && !isStale(best)));
        });
      } else {
        where.append(el('p', { class: 'small muted', text: 'Nothing similar is in stock nearby either.' }));
      }
      if (state.radius < 40) {
        where.append(el('p', { class: 'small' },
          el('button', { class: 'linkbtn', type: 'button', onclick: () => setRadius(40), text: 'Search the whole island' })));
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

  async function runSearch(query, source = 'text') {
    state.lastQuery = query; state.lastSource = source;
    const res = $('results');
    if (!query.trim()) { res.replaceChildren(); return; }
    res.replaceChildren(el('div', { class: 'empty small muted', text: 'Searching…' }));
    // A search started while the catalog is still loading waits for it instead of failing silently.
    try { await state.ready; } catch { renderEmpty('Could not load the wine catalog.', 'Check your connection and reload.'); return; }
    let offers;
    try { offers = await getOffers(); } catch (e) {
      console.error(e); renderEmpty('Could not load store data.', 'Check your connection and try again.'); return;
    }
    const matches = matchWines(query);
    if (!matches.length) {
      logSearch(query, null, false, source);
      renderEmpty(source === 'scan' ? 'Couldn’t recognize that label.' : `“${query}” isn’t in our catalog yet.`,
        source === 'scan' ? 'Try a sharper photo of the front label, or type the name.' :
          (LIVE ? 'We logged the request so stores know there’s demand. ' : '') + 'Try the producer name or grape.');
      return;
    }
    // Order: best text match first; among equal matches, in-stock nearby first, then cheapest.
    const bestPrice = (w) => Math.min(...offers.filter((o) => o.wine_id === w.id).map(priceKey), Infinity);
    const nearby = (w) => offers.some((o) => o.wine_id === w.id);
    matches.sort((a, b) => (b.score - a.score) || (nearby(b.w) - nearby(a.w)) || (bestPrice(a.w) - bestPrice(b.w)));
    const wines = matches.map((m) => m.w);
    logSearch(query, wines[0].id, nearby(wines[0]), source);
    personalizeGuide(wines[0]);
    res.replaceChildren(...wines.map((w) => wineCard(w, offers, offers)));
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
    // The button opens the phone camera through the file picker (no separate camera permission needed).
    $('scanBtn').addEventListener('click', () => { toastScan(''); $('scanInput').click(); });
    $('scanInput').addEventListener('change', (e) => handleScan(e.target.files[0]));
    // Same label reader for a photo already on the phone (gallery / files, no camera).
    $('pickBtn').addEventListener('click', () => { toastScan(''); $('pickInput').click(); });
    $('pickInput').addEventListener('change', (e) => { handleScan(e.target.files[0]).finally(() => { e.target.value = ''; }); });
    $('interstitialClose').addEventListener('click', () => { $('interstitial').hidden = true; });
    $('suggest').replaceChildren(...['Cabernet', 'Malbec', 'Pinot Noir', 'Sauvignon Blanc', 'Prosecco', 'Rosé'].map((s) =>
      el('button', { class: 'chip', type: 'button', text: s, onclick: () => { $('q').value = s; runSearch(s, 'text'); } })));

    await ageGate();
    setupAds();
    state.ready = init();
    try { await state.ready; } catch (e) {
      console.error(e); renderEmpty('Could not load the wine catalog.', 'Check your connection and reload.'); return;
    }
    renderGuide(null);
    if (store.get('ob.geoOk', false)) locate(true);
  }
  boot();
})();
