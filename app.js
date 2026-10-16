import { decodeHash, encodeMatch, formFromMatch, computeStatus, ignLabel, replyConnected, liveStatus, playerKey, defaultSelection, parseSelection, REPLY_TTL_MS, viewUrl } from './logic.js?v=3';
import { initMaker, emptyForm } from './maker.js?v=3';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Each match link remembers its own selection. The key is the full hash (no digest, so two links
// can never share a key).
const SEL_PREFIX = 'rcc-sel:';
const storageKey = (hash) => SEL_PREFIX + hash;

// Fresh unguessable token per getStreamIDs request; a reply counts only if it echoes one we sent.
function newToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return 'rcc-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// The camera check view for one match, built inside container. hashKey is the match's '#m=…' hash
// (the selection storage key). Returns unmount(), which stops every timer and listener, blanks every
// iframe and removes the view's DOM.
export function mountCameras(container, headerTotalEl, match, hashKey) {
  const connected = new Set();
  const recs = new Map(); // stream id -> { connected, repliedAt } from the iframe's own getStreamIDs replies
  const frames = new Map(); // iframe element -> stream id
  const pending = new Map(); // iframe element -> Map(token -> sentAt) of getStreamIDs requests not yet answered
  let alive = true;

  const KEY = storageKey(hashKey);
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  const selected = (stored !== null && parseSelection(stored, match)) || defaultSelection(match);
  const save = () => {
    const val = JSON.stringify([...selected]);
    try { localStorage.setItem(KEY, val); } catch {
      // storage full (long keys add up across matches): drop other matches' selections and retry once
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith(SEL_PREFIX) && k !== KEY) localStorage.removeItem(k);
        localStorage.setItem(KEY, val);
      } catch { /* storage blocked */ }
    }
  };

  container.innerHTML = `
<div class="teams"></div>
<footer>Camera boxes update live. A player turns green as soon as their camera connects. Use "Choose players" to swap a sub in or out.</footer>`;
  const teamsEl = container.querySelector('.teams');
  const totalEl = headerTotalEl;

  const poll = (iframe) => {
    if (!alive || !frames.has(iframe)) return;
    const now = Date.now();
    let toks = pending.get(iframe);
    if (!toks) pending.set(iframe, (toks = new Map()));
    for (const [t, at] of toks) if (now - at > REPLY_TTL_MS) toks.delete(t); // unanswered: expire
    const cib = newToken();
    toks.set(cib, now);
    try { iframe.contentWindow.postMessage({ getStreamIDs: true, cib }, 'https://vdo.ninja'); } catch { toks.delete(cib); }
  };

  // A tile (and its iframe) exists only while its player is selected. Once built it is never
  // moved in the DOM (that would reload the iframe); order is set with CSS.
  function addTile(s, p, i) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `<div class="cam off"><iframe title="Camera" allow="autoplay" referrerpolicy="no-referrer" loading="eager"></iframe><span class="live">LIVE</span><div class="nocam">No camera</div></div><div class="row"><div class="ign"></div><div class="pill bad">Not connected</div></div>`;
    const ign = tile.querySelector('.ign');
    ign.textContent = ignLabel(p, i);
    if (!p.ign) ign.classList.add('none');
    if (p.sub) ign.insertAdjacentHTML('beforeend', ' <span class="tag sub">Sub</span>');
    const iframe = tile.querySelector('iframe');
    if (p.id === null) {
      // No stream id: no iframe at all, the tile stays red with an explicit reason.
      iframe.remove();
      tile.querySelector('.nocam').textContent = 'No camera link';
    } else {
      iframe.addEventListener('load', () => poll(iframe));
      iframe.src = viewUrl(p.id);
      frames.set(iframe, p.id);
    }
    s.tiles.appendChild(tile);
    s.els.set(i, { tile, cam: tile.querySelector('.cam'), pill: tile.querySelector('.pill'), iframe: p.id === null ? null : iframe, id: p.id });
  }

  function removeTile(s, i) {
    const e = s.els.get(i);
    if (!e) return;
    if (e.iframe) { frames.delete(e.iframe); pending.delete(e.iframe); e.iframe.src = 'about:blank'; }
    if (e.id !== null) recs.delete(e.id);
    e.tile.remove();
    s.els.delete(i);
  }

  const sections = match.teams.map((t, ti) => {
    const sec = document.createElement('section');
    sec.className = 'team';
    sec.innerHTML = `<h2>${esc(t.name)} <span></span></h2><details class="pick"><summary></summary><div class="picks"></div></details><div class="tiles"></div><div class="empty" hidden>No players selected. Open "Choose players" to add some.</div>`;
    teamsEl.appendChild(sec);
    const s = { sec, tiles: sec.querySelector('.tiles'), els: new Map(), h2span: sec.querySelector('h2 span'), summary: sec.querySelector('summary'), empty: sec.querySelector('.empty') };
    const picks = sec.querySelector('.picks');
    t.players.forEach((p, i) => {
      const key = playerKey(ti, i);
      const row = document.createElement('label');
      row.className = 'pickrow';
      row.innerHTML = `<input type="checkbox"><span class="pname"></span><span class="tag ${p.sub ? 'sub' : 'starter'}">${p.sub ? 'Sub' : 'Starter'}</span>`;
      row.querySelector('.pname').textContent = ignLabel(p, i);
      const box = row.querySelector('input');
      box.checked = selected.has(key);
      box.addEventListener('change', () => {
        if (box.checked) { selected.add(key); if (!s.els.has(i)) addTile(s, p, i); }
        else { selected.delete(key); removeTile(s, i); }
        save();
        lastSig = null; // force a re-render: counts changed even if connections did not
        refresh();
      });
      picks.appendChild(row);
      if (selected.has(key)) addTile(s, p, i);
    });
    return s;
  });

  function render() {
    const st = computeStatus(match, connected, selected);
    totalEl.className = 'total' + (st.missing ? ' warn' : '');
    const sub = st.total === 0 ? 'No players selected' : st.missing ? `${st.missing} player${st.missing === 1 ? '' : 's'} still missing` : 'All players connected';
    totalEl.innerHTML = `${st.connected} / ${st.total} connected<small>${sub}</small>`;
    st.teams.forEach((t, ti) => {
      const s = sections[ti]; let idx = 0;
      s.h2span.textContent = `${t.connected} / ${t.total}`;
      s.summary.textContent = `Choose players (${t.total} of ${match.teams[ti].players.length})`;
      s.empty.hidden = t.total !== 0;
      t.players.forEach((p) => {
        const e = s.els.get(p.i);
        if (!e) return;
        e.cam.className = 'cam ' + (p.connected ? 'on' : 'off');
        e.pill.className = 'pill ' + (p.connected ? 'ok' : 'bad');
        e.pill.textContent = p.connected ? 'Connected' : p.id === null ? 'No link' : 'Not connected';
        e.tile.style.order = String(idx++); // CSS order: moving iframes in the DOM would reload them
      });
    });
  }

  const POLL_MS = 2000;
  let lastSig = null;
  const refresh = () => {
    if (!alive) return;
    const now = Date.now();
    const next = new Set();
    for (const [id, rec] of recs) if (liveStatus(rec, now)) next.add(id);
    const sig = [...next].sort().join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    connected.clear();
    for (const id of next) connected.add(id);
    render();
  };

  // Connection state comes only from the iframe's own reply to getStreamIDs (polled every 2 s, and
  // once right after any VDO connection event from that iframe). A reply that stops arriving for
  // 5 s means not connected. Origin and source-window are checked on every message; replies from
  // a removed (unselected) tile's iframe are ignored because it is no longer in `frames`.
  const onMessage = (ev) => {
    if (ev.origin !== 'https://vdo.ninja') return;
    let id = null;
    let frame = null;
    for (const [iframe, pid] of frames) if (iframe.contentWindow === ev.source) { id = pid; frame = iframe; break; }
    if (id === null) return;
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if ('streamIDs' in d) {
      // only a reply to a request we sent to this iframe (VDO echoes cib); each token is used once
      const toks = pending.get(frame);
      if (typeof d.cib !== 'string' || !toks || !toks.has(d.cib)) return;
      if (Date.now() - toks.get(d.cib) > REPLY_TTL_MS) { toks.delete(d.cib); return; }
      toks.delete(d.cib);
      recs.set(id, { connected: replyConnected(d, id), repliedAt: Date.now() });
      refresh();
    } else if (d.action === 'view-connection' || d.action === 'new-view-connection' || d.action === 'end-view-connection') {
      poll(frame);
    }
  };
  window.addEventListener('message', onMessage);

  let tick = 0;
  const timer = setInterval(() => {
    if (tick++ % (POLL_MS / 1000) === 0) for (const iframe of frames.keys()) poll(iframe);
    refresh();
  }, 1000);

  refresh();

  return function unmount() {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
    window.removeEventListener('message', onMessage);
    for (const iframe of container.querySelectorAll('iframe')) iframe.src = 'about:blank';
    container.textContent = '';
    frames.clear(); pending.clear(); recs.clear(); connected.clear();
    for (const s of sections) s.els.clear();
    totalEl.textContent = '';
    totalEl.className = 'total';
  };
}

// ---- page: tabs, load, URL sync, camera view lifecycle ----
const TABS = ['setup', 'cams'];
let tabNow = 'setup';
let current = null; // { match, key } for the match the form makes now, or null while it is blocked
let view = null; // { key, unmount } of the mounted camera view

const totalEl = $('total');

function setHeader() {
  const m = current && current.match;
  $('h-title').textContent = m ? m.title : 'Referee Camera Check';
  $('h-meta').textContent = m ? [m.game, m.date].filter(Boolean).join(' · ') : '';
  document.title = m ? m.title + ' - Referee Camera Check' : 'Referee Camera Check';
  $('cams-dot').hidden = $('cams-sr').hidden = !!current;
}

function unmountView() {
  if (view) { view.unmount(); view = null; }
}

// Called whenever the Cameras tab is showing or the match changes while it shows.
function syncCams() {
  if (tabNow !== 'cams') { totalEl.hidden = true; return; }
  if (!current) {
    unmountView();
    $('cams-blocked').hidden = false;
    totalEl.hidden = true;
    return;
  }
  $('cams-blocked').hidden = true;
  if (view && view.key !== current.key) unmountView();
  if (!view) view = { key: current.key, unmount: mountCameras($('cams'), totalEl, current.match, current.key) };
  totalEl.hidden = false;
}

function showTab(name, focus) {
  tabNow = name;
  for (const t of TABS) {
    const sel = t === name;
    $('tab-' + t).setAttribute('aria-selected', String(sel));
    $('tab-' + t).tabIndex = sel ? 0 : -1;
    $('panel-' + t).hidden = !sel;
  }
  syncCams();
  if (focus) $('tab-' + name).focus();
}

for (const t of TABS) {
  $('tab-' + t).addEventListener('click', () => showTab(t));
  $('tab-' + t).addEventListener('keydown', (e) => {
    const i = TABS.indexOf(t);
    const to = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length]
      : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS[TABS.length - 1] : null;
    if (to) { e.preventDefault(); showTab(to, true); }
  });
}

const initialHash = location.hash;
const decoded = initialHash ? decodeHash(initialHash) : null;
const fromLink = !!(decoded && decoded.ok);

function onUpdate(res, { fromUser }) {
  if (!fromUser) {
    // First render. A valid link keeps its own hash as the key, so a link made before this page
    // existed keeps its saved selection; the URL is only rewritten once the producer edits.
    current = fromLink ? { match: decoded.match, key: initialHash } : res.match ? { match: res.match, key: '#m=' + encodeMatch(res.match) } : null;
  } else if (res.match) {
    const key = '#m=' + encodeMatch(res.match);
    if (key !== location.hash) history.replaceState(null, '', key);
    current = { match: res.match, key };
  } else {
    current = null; // blocked: the hash stays as it was
  }
  if (view && (!current || view.key !== current.key)) unmountView();
  setHeader();
  syncCams();
}

initMaker({
  form: fromLink ? formFromMatch(decoded.match) : emptyForm(),
  badHashMessage: initialHash && !fromLink ? decoded.message : '',
  onUpdate,
});
showTab(fromLink ? 'cams' : 'setup');

// A different match link pasted into the same tab changes only the hash: reload so the page,
// its iframes and its stored selection all belong to the new match. (replaceState never fires this.)
window.addEventListener('hashchange', () => location.reload());
