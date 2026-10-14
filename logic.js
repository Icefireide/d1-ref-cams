// Pure logic, shared by the page (as an ES module) and the tests.
export const BAD_HASH_MESSAGE = 'This link is missing its match data. Ask the producer for the referee link.';

export function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function encodeMatch(match) {
  return b64urlEncode(JSON.stringify(match));
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Returns { ok:true, match } or { ok:false, message }. Never throws.
export const LIMITS = { hash: 16384, teams: 4, playersPerTeam: 16, ign: 64, text: 120 };

export function decodeHash(hash) {
  try {
    if (String(hash || '').length > LIMITS.hash) return { ok: false, message: BAD_HASH_MESSAGE };
    const m = /(?:^|[#&])m=([A-Za-z0-9_-]+)/.exec(String(hash || ''));
    if (!m) return { ok: false, message: BAD_HASH_MESSAGE };
    const raw = JSON.parse(b64urlDecode(m[1]));
    const match = normalizeMatch(raw);
    if (!match) return { ok: false, message: BAD_HASH_MESSAGE };
    return { ok: true, match };
  } catch {
    return { ok: false, message: BAD_HASH_MESSAGE };
  }
}

export function normalizeMatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.teams) || raw.teams.length === 0) return null;
  if (raw.teams.length > LIMITS.teams) return null;
  // A field that is present must have the right type; a wrong type means a broken link, never "absent".
  const optStr = (v) => v === undefined || v === null || typeof v === 'string';
  for (const k of ['title', 'game', 'date']) {
    if (!optStr(raw[k])) return null;
    if (typeof raw[k] === 'string' && raw[k].length > LIMITS.text) return null; // limits apply to the raw input
  }
  // A player with a blank or missing id is kept as { ign, id: null } (shown as 'No camera link').
  // A present but malformed id means a broken link: reject the whole match.
  let bad = false;
  const teams = raw.teams.map((t) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) { bad = true; return { name: '', players: [] }; }
    if (!optStr(t.name) || !(t.players === undefined || Array.isArray(t.players))) bad = true;
    if (typeof t.name === 'string' && t.name.length > LIMITS.text) bad = true;
    if (Array.isArray(t.players) && t.players.length > LIMITS.playersPerTeam) bad = true;
    const players = (Array.isArray(t.players) ? t.players : []).map((p) => {
      if (p && typeof p.ign === 'string' && p.ign.length > LIMITS.ign) bad = true;
      if (!p || typeof p !== 'object' || Array.isArray(p)) { bad = true; return { ign: '', id: null }; }
      if (!optStr(p.id) || !optStr(p.ign) || !(p.sub === undefined || typeof p.sub === 'boolean')) { bad = true; return { ign: '', id: null }; }
      // The id is used exactly as given: never trimmed, so " abc " is malformed, not "abc".
      const id = typeof p.id === 'string' ? p.id : '';
      if (id === '') return p.sub === true ? { ign: str(p.ign), id: null, sub: true } : { ign: str(p.ign), id: null };
      if (!/^[A-Za-z0-9_.-]+$/.test(id)) { bad = true; return { ign: '', id: null }; }
      return p.sub === true ? { ign: str(p.ign), id, sub: true } : { ign: str(p.ign), id };
    });
    return { name: str(t.name) || 'Team', players };
  });
  if (bad) return null;
  const seen = new Set();
  for (const t of teams) for (const p of t.players) { if (p.id === null) continue; if (seen.has(p.id)) return null; seen.add(p.id); }
  return { title: str(raw.title) || 'Referee Camera Check', game: str(raw.game), date: str(raw.date), teams };
}

// connected: Set of stream ids currently connected.
// Returns header + per-team counts and players sorted not-connected first (stable otherwise).
// selected (optional): Set of player keys (see playerKey); only those players are counted and listed.
export function computeStatus(match, connected, selected) {
  const teams = match.teams.map((t, ti) => {
    const players = t.players.map((p, i) => ({ ...p, i, connected: connected.has(p.id) }))
      .filter((p) => !selected || selected.has(playerKey(ti, p.i)));
    players.sort((a, b) => Number(a.connected) - Number(b.connected) || a.i - b.i);
    return { name: t.name, total: players.length, connected: players.filter((p) => p.connected).length, players };
  });
  const total = teams.reduce((n, t) => n + t.total, 0);
  const ok = teams.reduce((n, t) => n + t.connected, 0);
  return { total, connected: ok, missing: total - ok, teams };
}

export function ignLabel(p, index) {
  return p.ign ? p.ign : (p.sub ? 'Sub' : 'Starter') + ' (no IGN listed)';
}

// ---- who the referee monitors (starters by default, subs can be swapped in) ----
export const playerKey = (ti, i) => `${ti}:${i}`;

export function defaultSelection(match) {
  const sel = new Set();
  match.teams.forEach((t, ti) => t.players.forEach((p, i) => { if (!p.sub) sel.add(playerKey(ti, i)); }));
  return sel;
}

// stored: the raw localStorage string. Returns a Set of valid keys for this match, or null when the
// stored value is missing or unusable (caller falls back to defaultSelection).
export function parseSelection(stored, match) {
  try {
    const arr = JSON.parse(stored);
    if (!Array.isArray(arr)) return null;
    const sel = new Set();
    for (const k of arr) {
      const m = typeof k === 'string' && /^(\d+):(\d+)$/.exec(k);
      if (!m) return null;
      const t = match.teams[Number(m[1])];
      if (!t || Number(m[2]) >= t.players.length) return null;
      sel.add(playerKey(Number(m[1]), Number(m[2])));
    }
    return sel;
  } catch {
    return null;
  }
}

// ---- CSV -> match JSON (used by make-links.mjs) ----
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

export function streamIdFromLink(link) {
  const m = /[?&]view=([^&#\s]+)/.exec(link || '');
  return m ? decodeURIComponent(m[1]) : '';
}

// def: {title, game, date, teams:[{csvName, name}]}, game code in def.code
export function csvToMatch(rows, def) {
  const teams = def.teams.map((t) => ({
    name: t.name,
    players: rows
      .filter((r) => r.school === t.csvName && r.game === def.code && /^(starter|sub)$/i.test(r.starter))
      .map((r) => {
        const p = { ign: r.IGN || '', id: streamIdFromLink(r['view link']) || null };
        return /^sub$/i.test(r.starter) ? { ...p, sub: true } : p;
      }),
  }));
  return { title: def.title, game: def.game, date: def.date, teams };
}

// ---- duplicate stream ids (for make-links warnings) ----
// Returns [{ team, ign }] for every player whose stream id appears more than once in the match.
// Returns [{ team, ign, sub }] for players with no stream id (blank or missing view link).
export function findNoLinkPlayers(match) {
  return match.teams.flatMap((t) => t.players.filter((p) => p.id === null).map((p) => ({ team: t.name, ign: p.ign, sub: !!p.sub })));
}

export function findDuplicatePlayers(match) {
  const count = new Map();
  for (const t of match.teams) for (const p of t.players) if (p.id !== null) count.set(p.id, (count.get(p.id) || 0) + 1);
  return match.teams.flatMap((t) => t.players.filter((p) => p.id !== null && count.get(p.id) > 1).map((p) => ({ team: t.name, ign: p.ign })));
}

// ---- connection truth from the VDO.Ninja iframe API ----
// The page asks each viewer iframe {getStreamIDs:true, cib}; the iframe answers
// {streamIDs: { <streamID>: <label|false> }, cib} listing the remote peers it currently holds a
// connection to (main.js: it iterates session.rpcs, which is deleted on disconnect). VDO events are
// only a hint to poll again; state is never inferred from them.
export const REPLY_TTL_MS = 5000;

// Pure: reply data + the tile's stream id -> connected? Anything missing, malformed or for another
// stream id is "not connected".
export function replyConnected(data, streamId) {
  if (typeof streamId !== 'string' || streamId === '') return false;
  if (!data || typeof data !== 'object') return false;
  const ids = data.streamIDs;
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return false;
  return Object.prototype.hasOwnProperty.call(ids, streamId);
}

// rec: { connected: boolean, repliedAt: ms timestamp of the last accepted reply }.
// A reply that is older than ttl (the iframe stopped answering) means not connected.
export function liveStatus(rec, now, ttl = REPLY_TTL_MS) {
  return !!rec && rec.connected === true && typeof rec.repliedAt === 'number' && now - rec.repliedAt <= ttl;
}
