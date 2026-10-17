/* OB Sommelier: contributor + admin page.
 * Contributors (invite-only, emailed sign-in link) pick the store they are in and upload shelf photos.
 * Photos go to private storage; a daily Claude task reads them and records the wines as "seen on the shelf".
 * Admins (contributors.role = 'admin') invite/deactivate contributors and can undo any submission.
 */
(() => {
  'use strict';
  const CFG = window.OB_CONFIG || {};
  const LIVE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  const MAX_PHOTOS = 12;
  const app = document.getElementById('app');
  let sb, user, role = null;

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
  function flash(msg, kind) { const n = notice(msg, kind); app.prepend(n); n.scrollIntoView({ block: 'nearest' }); setTimeout(() => n.remove(), 5000); }
  const fail = (e) => { console.error(e); flash(e.message || 'Something went wrong. Try again.', 'err'); };
  const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const STATUS = { uploaded: 'Waiting to be read', processed: 'Done', failed: 'Could not be read', undone: 'Undone by admin' };

  async function boot() {
    if (!LIVE) {
      app.replaceChildren(card(el('h2', { class: 'h2', text: 'Not available in demo mode' }),
        el('p', { class: 'muted', text: 'This page works once the app is connected to the live database.' })));
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
    const { data, error } = await sb.rpc('my_role');
    if (error) return fail(error);
    role = data;
    if (!role) {
      app.replaceChildren(card(el('h2', { class: 'h2', text: 'You are not on the contributor list yet' }),
        el('p', null, `You are signed in as ${user.email}. Ask the OB Sommelier team to add this email, then reload this page.`)), signOutLine());
      return;
    }
    const parts = [await visitCard(), await mySubmissionsCard()];
    if (role === 'admin') parts.push(await adminContributorsCard(), await adminSubmissionsCard());
    parts.push(signOutLine());
    app.replaceChildren(...parts);
  }

  // ---------- Sign in ----------
  function renderSignIn() {
    const email = el('input', { type: 'email', required: true, placeholder: 'you@example.com', autocomplete: 'email', id: 'email' });
    const btn = el('button', { class: 'btn primary', type: 'submit', text: 'Email me a sign-in link' });
    const form = el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true;
      const { error } = await sb.auth.signInWithOtp({ email: email.value.trim().toLowerCase(), options: { emailRedirectTo: new URL('contribute.html', location.href).href } });
      btn.disabled = false;
      if (error) return fail(error);
      form.replaceChildren(notice(`Check ${email.value} for your sign-in link. Open it on this phone.`, 'ok'));
    } }, field('Your email', email), btn);
    app.replaceChildren(card(el('h2', { class: 'h2', text: 'Contributor sign-in' }),
      el('p', { class: 'small muted' }, 'Invite only. Use the email the OB Sommelier team added. ',
        el('a', { href: 'privacy.html', text: 'Privacy and terms' }), '.'), form));
  }

  // ---------- New shelf visit ----------
  async function downscale(file, max = 1800) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
  }

  async function visitCard() {
    let pos = null, storeId = null;
    const status = el('p', { class: 'small muted', text: 'Stand inside the store, then find it.' });
    const storeList = el('div', { class: 'grid-tight' });
    const newName = el('input', { id: 'newStoreName', maxlength: 120, placeholder: 'Store name, e.g. Ling & Sons' });
    const newAddr = el('input', { id: 'newStoreAddr', maxlength: 200, placeholder: 'Area or street (optional)' });
    const newBox = el('div', { class: 'form', hidden: true }, field('Store name', newName), field('Address', newAddr));

    function choose(id, label) {
      storeId = id; newBox.hidden = id !== 'new';
      for (const b of storeList.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
      status.textContent = id === 'new' ? 'New store: add its name below.' : `Store: ${label}`;
    }
    const findBtn = el('button', { class: 'btn', type: 'button', text: 'Find the store I am in', onclick: () => {
      status.textContent = 'Getting your location…';
      navigator.geolocation.getCurrentPosition(async (p) => {
        pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        const { data, error } = await sb.rpc('stores_near', { p_lat: pos.lat, p_lng: pos.lng, p_radius_m: 400 });
        if (error) return fail(error);
        storeList.replaceChildren(
          ...data.map((s) => el('button', { class: 'chip', type: 'button', 'data-id': s.id, 'aria-pressed': 'false',
            text: `${s.name} (${Math.round(s.distance_m)} m)`, onclick: () => choose(s.id, s.name) })),
          el('button', { class: 'chip', type: 'button', 'data-id': 'new', 'aria-pressed': 'false', text: 'Store not listed', onclick: () => choose('new') }));
        status.textContent = data.length ? 'Pick the store you are in.' : 'No known store here yet. Add it as a new store.';
        if (!data.length) choose('new');
      }, () => { status.textContent = 'Location is blocked. Allow location for this site in your browser settings, then try again.'; },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    } });

    const files = [];
    const preview = el('div', { class: 'thumbs' });
    const photoInput = el('input', { id: 'photos', class: 'vh', type: 'file', accept: 'image/*', multiple: true, tabindex: '-1', 'aria-hidden': 'true' });
    const camInput = el('input', { id: 'camera', class: 'vh', type: 'file', accept: 'image/*', capture: 'environment', tabindex: '-1', 'aria-hidden': 'true' });
    function addFiles(list) {
      for (const f of list) if (files.length < MAX_PHOTOS && f.type.startsWith('image/')) files.push(f);
      preview.replaceChildren(...files.map((f, i) => el('figure', null,
        el('img', { src: URL.createObjectURL(f), alt: `Photo ${i + 1}` }),
        el('button', { class: 'linkbtn small', type: 'button', text: 'Remove', onclick: () => { files.splice(i, 1); addFiles([]); } }))));
      count.textContent = `${files.length} of ${MAX_PHOTOS} photos`;
    }
    photoInput.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    camInput.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    const count = el('span', { class: 'small muted', text: `0 of ${MAX_PHOTOS} photos` });
    const note = el('input', { id: 'note', maxlength: 300, placeholder: 'Anything we should know? (optional)' });
    const send = el('button', { class: 'btn primary block', type: 'button', text: 'Send photos' });

    send.addEventListener('click', async () => {
      if (!pos) return flash('Find the store first, so we know where the photos were taken.', 'err');
      if (!storeId) return flash('Pick the store you are in.', 'err');
      if (storeId === 'new' && newName.value.trim().length < 2) return flash('Add the store name.', 'err');
      if (!files.length) return flash('Add at least one shelf photo.', 'err');
      send.disabled = true;
      try {
        let sid = storeId;
        if (sid === 'new') {
          send.textContent = 'Adding the store…';
          const { data, error } = await sb.rpc('contributor_create_store', { p_name: newName.value, p_address: newAddr.value, p_lat: pos.lat, p_lng: pos.lng });
          if (error) throw error;
          sid = data;
        }
        const batch = crypto.randomUUID();
        const paths = [];
        for (let i = 0; i < files.length; i++) {
          send.textContent = `Uploading photo ${i + 1} of ${files.length}…`;
          const blob = await downscale(files[i]);
          const path = `${user.id}/${batch}/${i + 1}.jpg`;
          const { error } = await sb.storage.from('shelf-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
          if (error) throw error;
          paths.push(path);
        }
        const { error } = await sb.from('shelf_submissions').insert({ store_id: sid, photo_paths: paths, lat: pos.lat, lng: pos.lng, note: note.value.trim() || null });
        if (error) throw error;
        flash(`Sent ${paths.length} photos. The wines will show in the app within a day.`, 'ok');
        route();
      } catch (e) { fail(e); send.disabled = false; send.textContent = 'Send photos'; }
    });

    return card(el('h2', { class: 'h2', text: 'New shelf visit' }),
      el('div', { class: 'form' },
        findBtn, status, storeList, newBox,
        el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
          photoInput, camInput,
          el('button', { class: 'btn', type: 'button', text: 'Take a photo', onclick: () => camInput.click() }),
          el('button', { class: 'btn', type: 'button', text: 'Choose from gallery', onclick: () => photoInput.click() }),
          count),
        preview, field('Note', note),
        el('div', { class: 'small muted' },
          el('b', { text: 'Photos that work best: ' }),
          'hold the phone sideways (landscape), 2 shelves per photo, with the price-tag rail in the frame. Stand straight in front of the shelf, about 1 m away. Use the normal 1x lens, not 0.5x wide. Move left to right with a little overlap, and add one close-up for any bottle whose variety you can’t read. Ask the manager before you start.'),
        send));
  }

  // ---------- My submissions ----------
  async function mySubmissionsCard() {
    const { data, error } = await sb.from('shelf_submissions')
      .select('id, created_at, status, wines_recorded, summary, photo_paths, stores(name)')
      .eq('contributor_email', user.email.toLowerCase()).order('created_at', { ascending: false }).limit(20);
    if (error) { fail(error); return card(); }
    return card(el('h2', { class: 'h2', text: 'Your recent visits' }),
      data.length ? data.map((s) => el('div', { class: 'list-row sub-row' },
        el('div', null, el('div', { text: s.stores?.name || 'Store' }),
          el('div', { class: 'small muted', text: `${fmtDate(s.created_at)}, ${s.photo_paths.length} photos` }),
          el('div', { class: 'small', style: 'font-weight:700', text: STATUS[s.status] + (s.wines_recorded != null ? `, ${s.wines_recorded} wines` : '') }),
          s.summary ? el('div', { class: 'small', text: s.summary }) : null),
        el('span'), el('span')))
      : el('p', { class: 'small muted', text: 'Nothing sent yet.' }));
  }

  // ---------- Admin ----------
  async function adminContributorsCard() {
    const { data, error } = await sb.from('contributors').select('*').order('added_at');
    if (error) { fail(error); return card(); }
    const email = el('input', { id: 'inviteEmail', type: 'email', required: true, placeholder: 'contributor@email.com' });
    const name = el('input', { id: 'inviteName', maxlength: 80, placeholder: 'Name (optional)' });
    const roleSel = el('select', { id: 'inviteRole' }, el('option', { value: 'contributor', text: 'Contributor' }), el('option', { value: 'admin', text: 'Admin' }));
    const form = el('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const { error: err } = await sb.from('contributors').upsert({ email: email.value.trim().toLowerCase(), display_name: name.value.trim() || null, role: roleSel.value, active: true });
      if (err) return fail(err);
      flash(`Added ${email.value}. Send them this page's address; they sign in with that email.`, 'ok'); route();
    } }, el('div', { class: 'grid2' }, email, name), roleSel, el('button', { class: 'btn primary', type: 'submit', text: 'Add contributor' }));
    const rows = data.map((c) => {
      const tog = el('input', { type: 'checkbox' }); tog.checked = c.active;
      tog.disabled = c.email === user.email.toLowerCase();
      tog.addEventListener('change', async () => {
        const { error: err } = await sb.from('contributors').update({ active: tog.checked }).eq('email', c.email);
        if (err) { tog.checked = !tog.checked; return fail(err); }
        flash(tog.checked ? `${c.email} can contribute again.` : `${c.email} can no longer contribute.`, 'ok');
      });
      return el('div', { class: 'list-row' },
        el('div', null, el('div', { text: c.display_name || c.email }), el('div', { class: 'small muted', text: `${c.email}, ${c.role}` })),
        el('span'), el('label', { class: 'toggle' }, tog, 'Active'));
    });
    return card(el('h2', { class: 'h2', text: 'Contributors' }), form, el('div', null, rows));
  }

  async function adminSubmissionsCard() {
    const { data, error } = await sb.from('shelf_submissions')
      .select('id, created_at, contributor_email, status, wines_recorded, summary, photo_paths, stores(name)')
      .order('created_at', { ascending: false }).limit(40);
    if (error) { fail(error); return card(); }
    const pending = data.filter((s) => s.status === 'uploaded').length;
    return card(el('h2', { class: 'h2', text: 'All submissions' }),
      el('p', { class: 'small muted', text: `${pending} waiting to be read. Photos are read once a day.` }),
      data.map((s) => el('div', { class: 'list-row sub-row' },
        el('div', null, el('div', { text: `${s.stores?.name || 'Store'}, ${fmtDate(s.created_at)}` }),
          el('div', { class: 'small muted', text: `${s.contributor_email}, ${s.photo_paths.length} photos, ${STATUS[s.status]}${s.wines_recorded != null ? `, ${s.wines_recorded} wines` : ''}` }),
          s.summary ? el('div', { class: 'small', text: s.summary }) : null),
        el('span'),
        s.status === 'processed' ? undoButton(s) : el('span'))));
  }
  function undoButton(s) {
    const b = el('button', { class: 'linkbtn small', type: 'button', text: 'Undo' });
    b.addEventListener('click', async () => {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to undo'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Undo'; }, 4000); return; }
      const { data, error } = await sb.rpc('undo_shelf_submission', { p_submission: s.id });
      if (error) return fail(error);
      flash(`Undone. ${data} shelf sightings were hidden.`, 'ok'); route();
    });
    return b;
  }

  const signOutLine = () => el('p', { class: 'small muted', style: 'text-align:center' }, `Signed in as ${user.email}${role ? ` (${role})` : ''}. `,
    el('button', { class: 'linkbtn', type: 'button', text: 'Sign out', onclick: () => sb.auth.signOut() }));

  boot().catch(fail);
})();
