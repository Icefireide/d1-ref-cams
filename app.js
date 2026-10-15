import { decodeHash, computeStatus, ignLabel, replyConnected, liveStatus, playerKey, defaultSelection, parseSelection, REPLY_TTL_MS, viewUrl } from './logic.js?v=2';

const app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showMessage(text) {
  app.innerHTML = `<div class="msg">${esc(text)}</div>`;
}

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

function start() {
  const res = decodeHash(location.hash);
  if (!res.ok) return showMessage(res.message);
  const match = res.match;
  const connected = new Set();
  const recs = new Map(); // stream id -> { connected, repliedAt } from the iframe's own getStreamIDs replies
  const frames = new Map(); // iframe element -> stream id
  const pending = new Map(); // iframe element -> Map(token -> sentAt) of getStreamIDs requests not yet answered

  const KEY = storageKey(location.hash);
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

  document.title = match.title + ' - Referee Camera Check';
  const meta = [match.game, match.date].filter(Boolean).join(' · ');
  app.innerHTML = `
<header>
  <div><h1>${esc(match.title)}</h1><div class="meta">${esc(meta)}</div></div>
  <div class="total" id="total"></div>
</header>
<div class="teams" id="teams"></div>
<footer>Camera boxes update live. A player turns green as soon as their camera connects. Use "Choose players" to swap a sub in or out.</footer>`;
  const teamsEl = document.getElementById('teams');
  const totalEl = document.getElementById('total');

  const poll = (iframe) => {
    if (!frames.has(iframe)) return;
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
  window.addEventListener('message', (ev) => {
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
  });

  let tick = 0;
  setInterval(() => {
    if (tick++ % (POLL_MS / 1000) === 0) for (const iframe of frames.keys()) poll(iframe);
    refresh();
  }, 1000);

  refresh();
}

// A different match link pasted into the same tab changes only the hash: reload so the page,
// its iframes and its stored selection all belong to the new match.
window.addEventListener('hashchange', () => location.reload());

start();
