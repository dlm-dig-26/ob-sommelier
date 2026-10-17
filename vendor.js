/* OB Sommelier — vendor portal.
 * Email magic-link sign-in → create store (pin location) → add wines with prices → one-tap "confirm stock".
 * All writes are protected by Row Level Security: a vendor can only touch their own store and listings.
 */
(() => {
  'use strict';
  const CFG = window.OB_CONFIG || {};
  const LIVE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  const app = document.getElementById('app');
  let sb, user, stores = [], current = null, wines = [];

  // Bottle sizes offered to stores (ml). 750 is the standard bottle.
  const SIZES = [187, 375, 500, 750, 1000, 1500, 3000];
  const sizeLabel = (ml) => ml >= 1000 ? `${String(ml / 1000).replace('.', ',')} L` : `${ml} ml`;

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
    return n;
  }
  const card = (...k) => el('section', { class: 'card' }, ...k);
  const notice = (msg, kind = '') => el('div', { class: `notice ${kind}`, text: msg });
  const field = (label, input) => el('label', null, label, input);
  const sizeSelect = (value = 750) => el('select', { 'aria-label': 'Bottle size' },
    SIZES.map((ml) => el('option', { value: ml, selected: ml === value, text: sizeLabel(ml) })));
  function flash(msg, kind) {
    const n = notice(msg, kind); app.prepend(n); setTimeout(() => n.remove(), 4000);
  }
  const fail = (e) => { console.error(e); flash(e.message || 'Something went wrong.', 'err'); };

  // ---------- Boot ----------
  async function boot() {
    if (!LIVE) {
      app.replaceChildren(card(el('h2', { class: 'h2', text: 'Store portal not active yet' }),
        el('p', { class: 'muted', text: 'The vendor portal turns on once the live database is connected. The consumer app is running on demo data for now.' })));
      return;
    }
    await new Promise((res, rej) => { const s = el('script', { src: SUPABASE_JS }); s.onload = res; s.onerror = rej; document.head.append(s); });
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    sb.auth.onAuthStateChange((_e, session) => { const u = session?.user || null; if (u?.id !== user?.id) { user = u; route(); } });
    user = (await sb.auth.getSession()).data.session?.user || null;
    route();
  }

  async function route() {
    if (!user) return renderSignIn();
    try {
      const [{ data: s, error: e1 }, { data: w, error: e2 }] = await Promise.all([
        sb.rpc('my_stores'), sb.from('wines').select('id,name,producer,varietal,color').is('merged_into', null).order('name').limit(5000)
      ]);
      if (e1) throw e1; if (e2) throw e2;
      stores = s; wines = w;
      current = stores.find((x) => x.id === current?.id) || stores[0] || null;
      current ? renderStore() : renderCreateStore();
    } catch (e) { fail(e); }
  }

  // ---------- Sign in ----------
  function renderSignIn() {
    const email = el('input', { type: 'email', required: true, placeholder: 'you@yourstore.com', autocomplete: 'email' });
    const btn = el('button', { class: 'btn primary', type: 'submit', text: 'Email me a sign-in link' });
    const form = el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true;
      const { error } = await sb.auth.signInWithOtp({ email: email.value.trim(), options: { emailRedirectTo: new URL('vendor.html', location.href).href } });
      btn.disabled = false;
      if (error) return fail(error);
      form.replaceChildren(notice(`Check ${email.value} for your sign-in link.`, 'ok'));
    } }, field('Business email', email), btn);
    app.replaceChildren(card(el('h2', { class: 'h2', text: 'Store sign-in' }),
      el('p', { class: 'small muted' }, 'No password needed. Free during the pilot. ',
        el('a', { href: 'privacy.html', text: 'Privacy and terms' }), '.'), form));
  }

  // ---------- Create store ----------
  function renderCreateStore() {
    const name = el('input', { required: true, maxlength: 120, placeholder: 'Store name' });
    const address = el('input', { maxlength: 200, placeholder: 'Street, district' });
    const phone = el('input', { maxlength: 40, placeholder: '+297 …', type: 'tel' });
    const lat = el('input', { required: true, type: 'number', step: 'any', placeholder: '12.52' });
    const lng = el('input', { required: true, type: 'number', step: 'any', placeholder: '-70.03' });
    const geo = el('button', { class: 'btn', type: 'button', text: 'Use my current location (stand inside the store)', onclick: () => {
      navigator.geolocation.getCurrentPosition((p) => { lat.value = p.coords.latitude.toFixed(6); lng.value = p.coords.longitude.toFixed(6); },
        () => flash('Location blocked. Enter coordinates from Google Maps (long-press the pin).', 'err'), { enableHighAccuracy: true, timeout: 10000 });
    } });
    const form = el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const la = Number(lat.value), ln = Number(lng.value);
      if (!(la > 12.3 && la < 12.7 && ln > -70.15 && ln < -69.8)) return flash('That location is outside Aruba.', 'err');
      const { error } = await sb.from('stores').insert({
        name: name.value.trim(), address: address.value.trim() || null, phone: phone.value.trim() || null,
        location: `SRID=4326;POINT(${ln} ${la})`, owner_id: user.id
      });
      if (error) return fail(error);
      flash('Store created.', 'ok'); route();
    } }, field('Store name', name), field('Address', address), field('Phone', phone), geo,
      el('div', { class: 'grid2' }, field('Latitude', lat), field('Longitude', lng)),
      el('button', { class: 'btn primary', type: 'submit', text: 'Create store' }));
    app.replaceChildren(card(el('h2', { class: 'h2', text: 'Set up your store' }), form), signOutCard());
  }

  // ---------- Store dashboard ----------
  async function renderStore() {
    const { data: listings, error } = await sb.from('listings')
      .select('id,price,currency,size_ml,in_stock,last_confirmed,wine:wines(id,name,producer)')
      .eq('store_id', current.id).order('last_confirmed', { ascending: true });
    if (error) return fail(error);

    const picker = stores.length > 1 ? el('select', { onchange: (e) => { current = stores.find((s) => s.id === e.target.value); renderStore(); } },
      stores.map((s) => el('option', { value: s.id, selected: s.id === current.id, text: s.name }))) : null;

    const oldest = listings[0] ? Math.floor((Date.now() - Date.parse(listings[0].last_confirmed)) / 86400000) : 0;
    const head = card(
      el('h2', { class: 'h2', text: current.name }), picker,
      el('p', { class: 'small muted', text: `${listings.length} wines listed on the ${current.plan} plan.${current.is_active ? '' : ' Your store is hidden from shoppers.'}` }),
      oldest > 20 ? notice(`Some prices were last confirmed ${oldest} days ago. Listings older than ${CFG.STALE_AFTER_DAYS || 30} days are hidden from shoppers.`, 'err') : null,
      el('button', { class: 'btn primary block', type: 'button', text: 'Confirm all prices and stock are current', onclick: async () => {
        const { error: e } = await sb.from('listings').update({ in_stock: true }).eq('store_id', current.id).eq('in_stock', true);
        if (e) return fail(e); flash('All in-stock listings confirmed.', 'ok'); renderStore();
      } }));

    const rows = listings.map((l) => {
      const price = el('input', { type: 'number', step: '0.01', min: '0.01', value: l.price, 'aria-label': 'Price' });
      const stock = el('input', { type: 'checkbox' }); stock.checked = l.in_stock;
      const size = sizeSelect(l.size_ml || 750);
      const save = async () => {
        const p = Number(price.value);
        if (!(p > 0)) return flash('Enter a valid price.', 'err');
        const { error: e } = await sb.from('listings').update({ price: p, in_stock: stock.checked, size_ml: Number(size.value) }).eq('id', l.id);
        e ? fail(e) : flash('Saved.', 'ok');
      };
      price.addEventListener('change', save); stock.addEventListener('change', save); size.addEventListener('change', save);
      return el('div', { class: 'list-row' },
        el('div', null, el('div', { text: l.wine?.name || '?' }),
          el('div', { class: 'small muted', text: `${l.currency}, ${ago(l.last_confirmed)}` }), size),
        price,
        el('div', null, el('label', { class: 'toggle' }, stock, 'In stock'),
          el('button', { class: 'linkbtn small', type: 'button', text: 'Remove', onclick: async () => {
            if (!confirm(`Remove ${l.wine?.name}?`)) return;
            const { error: e } = await sb.from('listings').delete().eq('id', l.id); e ? fail(e) : renderStore();
          } })));
    });

    app.replaceChildren(head,
      card(el('h2', { class: 'h2', text: 'Your wines' }),
        rows.length ? el('div', null, rows) : el('p', { class: 'small muted', text: 'No wines yet. Add your first one below.' })),
      addListingCard(listings), newWineCard(), signOutCard());
  }
  const ago = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000); return d <= 0 ? 'confirmed today' : `confirmed ${d}d ago`; };

  function addListingCard(listings) {
    const have = new Set(listings.map((l) => l.wine?.id));
    let chosen = null;
    const q = el('input', { placeholder: 'Search catalog: name, producer, grape…' });
    const results = el('div');
    const price = el('input', { type: 'number', step: '0.01', min: '0.01', placeholder: 'Price' });
    const currency = el('select', null, el('option', { value: 'AWG', text: 'AWG (Afl.)' }), el('option', { value: 'USD', text: 'USD' }));
    const size = sizeSelect(750);
    const label = el('div', { class: 'small muted', text: 'No wine selected' });
    q.addEventListener('input', () => {
      const t = q.value.toLowerCase().trim();
      if (t.length < 2) return results.replaceChildren();
      const hits = wines.filter((w) => !have.has(w.id) && `${w.name} ${w.producer || ''} ${w.varietal || ''}`.toLowerCase().includes(t)).slice(0, 8);
      results.replaceChildren(hits.length ? el('div', { class: 'typeahead' }, hits.map((w) =>
        el('button', { type: 'button', text: `${w.name}${w.producer ? ' — ' + w.producer : ''}`, onclick: () => {
          chosen = w; label.textContent = `Selected: ${w.name}`; label.className = 'small'; results.replaceChildren(); q.value = '';
        } }))) : el('p', { class: 'small muted', text: 'Not in catalog — add it below.' }));
    });
    const form = el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      if (!chosen) return flash('Pick a wine from the catalog first.', 'err');
      const p = Number(price.value); if (!(p > 0)) return flash('Enter a valid price.', 'err');
      const { error } = await sb.from('listings').upsert({ store_id: current.id, wine_id: chosen.id, price: p, currency: currency.value, size_ml: Number(size.value), in_stock: true }, { onConflict: 'store_id,wine_id' });
      if (error) return fail(error); flash(`${chosen.name} listed.`, 'ok'); renderStore();
    } }, q, results, label, el('div', { class: 'grid2' }, price, currency), field('Bottle size', size),
      el('p', { class: 'small muted', text: 'One size per wine. If you sell two sizes, list the 750 ml bottle.' }),
      el('button', { class: 'btn primary', type: 'submit', text: 'Add to my store' }));
    return card(el('h2', { class: 'h2', text: 'Add a wine' }), form);
  }

  function newWineCard() {
    const i = (ph, max) => el('input', { placeholder: ph, maxlength: max });
    const name = i('Wine name (e.g. Catena Malbec)', 160); name.required = true;
    const producer = i('Producer', 120), varietal = i('Grape / varietal', 80), country = i('Country', 60), region = i('Region', 80);
    const color = el('select', null, ['red', 'white', 'rose', 'sparkling', 'dessert'].map((c) => el('option', { value: c, text: c })));
    const scale = (lbl, def) => { const s = el('select', null, [1, 2, 3, 4, 5].map((n) => el('option', { value: n, selected: n === def, text: n }))); return [lbl, s]; };
    const [, body] = scale('Body', 3), [, sweet] = scale('Sweet', 2), [, acid] = scale('Acidity', 3), [, tan] = scale('Tannin', 2);
    const form = el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const { error } = await sb.from('wines').insert({
        name: name.value.trim(), producer: producer.value.trim() || null, varietal: varietal.value.trim() || null,
        color: color.value, country: country.value.trim() || null, region: region.value.trim() || null,
        body: +body.value, sweetness: +sweet.value, acidity: +acid.value, tannin: +tan.value, created_by: user.id
      });
      if (error) return fail(error.code === '23505' ? new Error('That wine is already in the catalog — search for it above.') : error);
      flash('Wine added to catalog. Now list it above.', 'ok'); route();
    } }, name, el('div', { class: 'grid2' }, producer, varietal), el('div', { class: 'grid2' }, country, region),
      field('Type', color),
      el('div', { class: 'grid4' }, field('Body', body), field('Sweetness', sweet), field('Acidity', acid), field('Tannin', tan)),
      el('p', { class: 'small muted', text: 'Scales are 1 (low) – 5 (high). They power the “similar wine” suggestions.' }),
      el('button', { class: 'btn', type: 'submit', text: 'Add to catalog' }));
    return card(el('h2', { class: 'h2', text: 'Wine not in catalog?' }), form);
  }

  const signOutCard = () => el('p', { class: 'small muted', style: 'text-align:center' }, `Signed in as ${user.email}. `,
    el('button', { class: 'linkbtn', type: 'button', text: 'Sign out', onclick: () => sb.auth.signOut() }));

  boot().catch(fail);
})();
