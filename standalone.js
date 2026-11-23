/* Lightz Snipes standalone: runs the same app outside Claude.
   - window.claude.use('db' | 'user' | 'downloads') is provided here, backed by the Supabase table public.docs
     (owner, col, id, data jsonb), so the app code is unchanged.
   - Sign-in gate (email + password), import of the backup file from the Claude version,
     and window.lsWrite / lsGet for the scheduled race-day runs. */
(() => {
  'use strict';
  window.LS_STANDALONE = true;
  const cfg = window.LS_CONFIG || {};
  const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'lightz-auth' } });
  const TABLE = 'docs';
  let session = null, readyRes;
  const ready = new Promise(r => { readyRes = r; });
  const uid = () => session && session.user && session.user.id;

  /* ---------- small cache so the last loaded day opens without signal ---------- */
  const QK = 'lsq:', QIDX = 'lsq-index';
  function cacheGet(k) { try { const v = localStorage.getItem(QK + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function cacheSet(k, rows) {
    try {
      const v = JSON.stringify(rows); if (v.length > 1500000) return;
      let idx = []; try { idx = JSON.parse(localStorage.getItem(QIDX) || '[]'); } catch (e) {}
      idx = idx.filter(x => x !== k).concat([k]);
      while (idx.length > 12) { localStorage.removeItem(QK + idx.shift()); }
      localStorage.setItem(QK + k, v); localStorage.setItem(QIDX, JSON.stringify(idx));
    } catch (e) { try { localStorage.removeItem(QIDX); } catch (e2) {} }
  }
  function cacheClear() { try { Object.keys(localStorage).filter(k => k.startsWith(QK) || k === QIDX).forEach(k => localStorage.removeItem(k)); } catch (e) {} }

  /* ---------- Firestore-style shim over Supabase ---------- */
  const snapOf = (rows, fromCache) => ({ docs: rows.map(r => ({ id: r.id, exists: true, data: () => r.data })), metadata: { fromCache: !!fromCache }, empty: !rows.length, size: rows.length });
  async function run(col, filters, lim) {
    const out = [], page = 1000;
    let from = 0;
    for (;;) {
      const want = Math.min(page, lim - out.length);
      if (want <= 0) break;
      let q = sb.from(TABLE).select('id,data').eq('col', col);
      for (const [f, op, v] of filters) {
        const c = 'data->>' + f, s = v == null ? null : String(v);
        if (op === '==') q = s == null ? q.is(c, null) : q.eq(c, s);
        else if (op === '!=') q = q.neq(c, s);
        else if (op === '>=') q = q.gte(c, s);
        else if (op === '>') q = q.gt(c, s);
        else if (op === '<=') q = q.lte(c, s);
        else if (op === '<') q = q.lt(c, s);
        else if (op === 'in') q = q.in(c, (v || []).map(String));
      }
      const { data, error } = await q.order('id').range(from, from + want - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < want) break;
      from += want;
    }
    return out;
  }
  const listeners = new Set();
  function bump(col) { listeners.forEach(l => { if (l.col === col) l.kick(); }); }
  function query(col, filters = [], lim = Infinity) {
    const key = col + '|' + JSON.stringify(filters) + '|' + lim;
    return {
      where: (f, op, v) => query(col, filters.concat([[f, op, v]]), lim),
      orderBy: () => query(col, filters, lim),
      limit: n => query(col, filters, n),
      async get() { await ready; const rows = await run(col, filters, lim); cacheSet(key, rows); return snapOf(rows); },
      onSnapshot(cb, err) {
        let alive = true, t = null, had = false;
        const cached = cacheGet(key);
        if (cached) { had = true; setTimeout(() => { if (alive) cb(snapOf(cached, true)); }, 0); }
        const pull = async () => {
          try { await ready; const rows = await run(col, filters, lim); if (!alive) return; had = true; cacheSet(key, rows); cb(snapOf(rows)); }
          catch (e) { if (alive && !had && err) err(e); }
        };
        const l = { col, kick: () => { clearTimeout(t); t = setTimeout(pull, 700); } };
        listeners.add(l); pull();
        const vis = () => { if (document.visibilityState === 'visible') l.kick(); };
        document.addEventListener('visibilitychange', vis);
        const iv = setInterval(() => { if (document.visibilityState === 'visible') pull(); }, 180000);
        return () => { alive = false; listeners.delete(l); clearTimeout(t); clearInterval(iv); document.removeEventListener('visibilitychange', vis); };
      },
      doc: id => ({
        async get() { await ready; const { data, error } = await sb.from(TABLE).select('id,data').eq('col', col).eq('id', id).maybeSingle(); if (error) throw error; return { id, exists: !!data, data: () => data ? data.data : undefined }; },
        async set(val) { await ready; await upsert([{ col, id, data: val }]); bump(col); },
        async update(val) { const cur = await this.get(); if (!cur.exists) throw Object.assign(new Error('not found'), { code: 'not_found' }); await this.set(Object.assign({}, cur.data(), val)); },
        async delete() { await ready; const { error } = await sb.from(TABLE).delete().eq('col', col).eq('id', id); if (error) throw error; bump(col); }
      })
    };
  }
  async function upsert(rows) {
    const now = new Date().toISOString(), o = uid();
    const { error } = await sb.from(TABLE).upsert(rows.map(r => ({ owner: o, col: r.col, id: r.id, data: r.data, updated_at: now })), { onConflict: 'owner,col,id' });
    if (error) throw error;
  }
  const DB = { collection: p => query(p), doc: p => { const i = p.lastIndexOf('/'); return query(p.slice(0, i)).doc(p.slice(i + 1)); } };
  const USER = { id: async () => { await ready; return uid(); } };
  const DL = { save: async ({ filename, data }) => { const u = URL.createObjectURL(data instanceof Blob ? data : new Blob([data])); const a = document.createElement('a'); a.href = u; a.download = filename || 'download'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); } };
  window.claude = { use: async n => n === 'db' ? DB : n === 'user' ? USER : n === 'downloads' ? DL : null };

  /* ---------- live updates ---------- */
  ready.then(() => {
    try {
      sb.channel('docs-changes').on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, p => {
        const c = (p.new && p.new.col) || (p.old && p.old.col);
        listeners.forEach(l => { if (!c || l.col === c) l.kick(); });
      }).subscribe();
    } catch (e) {}
  });

  /* ---------- for the scheduled race-day runs (signed-in tab in the Claude app browser) ---------- */
  const splitPath = p => { const i = String(p).lastIndexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };
  window.lsGet = async path => { await ready; const [col, id] = splitPath(path); const { data, error } = await sb.from(TABLE).select('data,updated_at').eq('col', col).eq('id', id).maybeSingle(); if (error) throw error; return data ? data.data : null; };
  window.lsList = async (col, field, value) => { await ready; const rows = await run(col, field ? [[field, '==', value]] : [], Infinity); return rows.map(r => r.id); };
  window.lsWrite = async ops => {
    await ready;
    const sets = [], dels = [];
    for (const op of ops) {
      const [col, id] = splitPath(op.path);
      if (op.op === 'delete') dels.push([col, id]);
      else if (op.op === 'merge' || op.op === 'update') { const cur = await window.lsGet(op.path); if (op.op === 'update' && !cur) throw new Error('missing ' + op.path); sets.push({ col, id, data: Object.assign({}, cur || {}, op.data) }); }
      else sets.push({ col, id, data: op.data });
    }
    for (let i = 0; i < sets.length; i += 200) await upsert(sets.slice(i, i + 200));
    for (const [col, id] of dels) { const { error } = await sb.from(TABLE).delete().eq('col', col).eq('id', id); if (error) throw error; }
    new Set(sets.map(s => s.col).concat(dels.map(d => d[0]))).forEach(bump);
    return { written: sets.length, deleted: dels.length };
  };
  window.lsWhoami = () => ({ signedIn: !!session, email: session && session.user && session.user.email });
  // The Sportsbet reader the race-day runs install. The current one ships with the app (tools/lsx.set.js);
  // when the saved copy is older, hand out the new one and save it, so the next run upgrades by itself.
  const READER_V = 5, rawGet = window.lsGet;
  window.lsGet = async path => {
    const d = await rawGet(path);
    if (path !== 'tools/raceday' || (d && +d.lsxv > READER_V)) return d;
    try {
      const setter = (await (await fetch('tools/lsx.set.js', { cache: 'no-cache' })).text()).trim();
      if (!setter.includes('localStorage.lsxv = "' + READER_V + '"')) return d;
      if (d && d.setter === setter) return d;
      const doc = Object.assign({}, d || {}, { setter, lsxv: String(READER_V) });
      try { await window.lsWrite([{ op: 'set', path, data: doc }]); } catch (e) {}
      return doc;
    } catch (e) { return d; }
  };

  /* ---------- import the backup file from the Claude version ---------- */
  async function importBackup(file, note) {
    const txt = await file.text();
    let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('That file isn\'t a Lightz Snipez backup'); }
    if (!j || j.app !== 'lightz-snipes' || !j.cols) throw new Error('That file isn\'t a Lightz Snipez backup');
    await ready;
    const rows = [];
    Object.entries(j.cols).forEach(([col, m]) => Object.entries(m || {}).forEach(([id, data]) => { if (data && typeof data === 'object') rows.push({ col, id, data }); }));
    Object.entries(j.user || {}).forEach(([id, data]) => { if (data !== undefined) rows.push({ col: 'data/users/' + uid(), id, data }); });
    for (let i = 0; i < rows.length; i += 150) { await upsert(rows.slice(i, i + 150)); note(`Importing… ${Math.min(rows.length, i + 150)} of ${rows.length}`); }
    cacheClear();
    return rows.length;
  }

  /* ---------- Settings card (the app calls window.lsSettingsCard) ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const standaloneMode = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
  window.lsSettingsCard = () => `<div class="card panel ls-acct">
    <h3>Your account</h3>
    <p class="d">Signed in as <b>${esc(session && session.user && session.user.email)}</b>. Race data and your bets sync to every device you sign in on.</p>
    <div class="acts"><label class="btn pri ls-file">Import backup<input type="file" accept=".json,application/json" data-sa="import" hidden></label><button class="btn" data-sa="signout">Sign out</button></div>
    <p class="d ls-imp" aria-live="polite"></p>
    ${standaloneMode() ? '' : `<p class="d">Install it: on iPhone open this page in Safari, tap Share, then Add to Home Screen. On Android tap the ⋮ menu in Chrome, then Install app or Add to Home screen.</p>`}
  </div>`;
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-sa]'); if (!t) return;
    if (t.dataset.sa === 'signout') { e.preventDefault(); cacheClear(); await sb.auth.signOut(); location.reload(); }
  });
  document.addEventListener('change', async e => {
    const t = e.target; if (!t.matches || !t.matches('[data-sa="import"]') || !t.files || !t.files[0]) return;
    const out = document.querySelector('.ls-imp'), note = m => { if (out) out.textContent = m; };
    try { note('Reading the file…'); const n = await importBackup(t.files[0], note); note(`Imported ${n} records. Reloading…`); setTimeout(() => location.reload(), 900); }
    catch (err) { note('Import didn\'t finish: ' + (err && err.message || err)); }
    t.value = '';
  });

  /* ---------- sign-in gate ---------- */
  const css = `#lsgate{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px;background:var(--navy,#0d3426);color:var(--on-navy,#f3f7f2);font-family:var(--body,system-ui)}
  #lsgate form{width:min(360px,100%);display:grid;gap:12px}
  #lsgate h1{font-family:var(--head,system-ui);font-stretch:62%;font-weight:900;font-style:italic;font-size:2.4rem;margin:0;line-height:1}
  #lsgate p{margin:0;opacity:.82;font-size:.95rem}
  #lsgate label{display:grid;gap:4px;font-size:.85rem;font-weight:600}
  #lsgate input{font:inherit;font-size:1rem;padding:11px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:inherit}
  #lsgate input:focus-visible{outline:2px solid var(--yellow,#f4b63f);outline-offset:1px}
  #lsgate .go{font:inherit;font-weight:700;font-size:1rem;padding:12px;border-radius:8px;border:0;background:var(--yellow,#f4b63f);color:var(--on-yellow,#10231a);cursor:pointer}
  #lsgate .go[disabled]{opacity:.6}
  #lsgate .sw{font:inherit;background:none;border:0;color:inherit;text-decoration:underline;cursor:pointer;padding:4px 0;justify-self:start;opacity:.85}
  #lsgate .msg{min-height:1.3em;font-size:.9rem;color:var(--yellow,#f4b63f)}
  #lsgate .rail{height:7px;margin:4px 0 6px;background:linear-gradient(to bottom,transparent 0 1px,currentColor 1px 4px,transparent 4px),repeating-linear-gradient(90deg,transparent 0 46px,currentColor 46px 48px);opacity:.85}
  #lsgate .lsg-h{display:flex;align-items:center;gap:12px}
  #lsgate .lsg-h img,#lsgate .lsg-h svg{border-radius:10px;flex:none}
  .ls-file{position:relative}`;
  let gate = null, mode = 'in';
  function showGate() {
    if (gate) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    gate = document.createElement('div'); gate.id = 'lsgate';
    gate.innerHTML = `<form novalidate>
      <h1 class="lsg-h">${window.lsLogoSvg ? window.lsLogoSvg('lg-gate', 44) : '<img src="icons/icon-192.png" alt="" width="44" height="44">'}<span>Lightz Snipez</span></h1><div class="rail" aria-hidden="true"></div>
      <p class="sub">Sign in to see your race cards, picks and bets.</p>
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <label>Password<input type="password" name="pw" autocomplete="current-password" minlength="6" required></label>
      <button class="go" type="submit">Sign in</button>
      <button class="sw" type="button">New here? Create an account</button>
      <p class="msg" role="status" aria-live="polite"></p></form>`;
    document.body.appendChild(gate);
    const f = gate.querySelector('form'), go = f.querySelector('.go'), sw = f.querySelector('.sw'), msg = f.querySelector('.msg'), sub = f.querySelector('.sub');
    const setMode = m => { mode = m; go.textContent = m === 'in' ? 'Sign in' : 'Create account'; sw.textContent = m === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'; sub.textContent = m === 'in' ? 'Sign in to see your race cards, picks and bets.' : 'Pick an email and a password of 6 or more characters.'; f.pw.autocomplete = m === 'in' ? 'current-password' : 'new-password'; msg.textContent = ''; };
    sw.addEventListener('click', () => setMode(mode === 'in' ? 'up' : 'in'));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const email = f.email.value.trim(), password = f.pw.value;
      if (!email || password.length < 6) { msg.textContent = 'Enter your email and a password of 6 or more characters.'; return; }
      go.disabled = true; msg.textContent = mode === 'in' ? 'Signing in…' : 'Creating your account…';
      try {
        if (mode === 'in') {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
        } else {
          const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (!data.session) { setMode('in'); msg.textContent = 'Account made. Open the confirmation email, tap the link, then sign in here.'; }
        }
      } catch (err) {
        const m = String(err && err.message || err);
        msg.textContent = /invalid login/i.test(m) ? 'That email and password don\'t match. Try again, or create an account.' : /not confirmed/i.test(m) ? 'Confirm your email first: tap the link in the email from Supabase, then sign in.' : m;
      } finally { go.disabled = false; }
    });
    setTimeout(() => f.email.focus(), 50);
  }
  function hideGate() { if (gate) { gate.remove(); gate = null; } }

  const splash = () => { try { if (window.lsSplash) window.lsSplash(); } catch (e) {} };
  sb.auth.onAuthStateChange((ev, s) => {
    session = s;
    if (s) { const wasGated = !!gate; hideGate(); readyRes(s); if (wasGated) splash(); }
  });
  const boot = () => sb.auth.getSession().then(({ data }) => { session = data.session; if (session) { readyRes(session); splash(); } else showGate(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  /* ---------- offline shell ---------- */
  if ('serviceWorker' in navigator && location.protocol === 'https:') window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
})();
