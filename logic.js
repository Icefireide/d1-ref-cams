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

// ---- CSV -> match JSON (used by the Set up tab) ----
// One CSV tokenizer: returns the non-empty rows as arrays of raw cell strings (header row first).
function tokenizeCsv(text) {
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
  return rows;
}

export function parseCsv(text) {
  const [head, ...rest] = tokenizeCsv(text);
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// The header row's column names (trimmed). Works for a header-only file, where parseCsv returns [].
export function parseCsvHeader(text) {
  const [head] = tokenizeCsv(text);
  return head ? head.map((h) => h.trim()) : [];
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

// ---- duplicate stream ids (used by the Set up tab) ----
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

// ---- the Set up tab: form <-> match (pure; the page only renders what these return) ----
// form = { title, game, date, teams: [{ name, players: [{ ign, link, sub }] }] }
// where link is whatever the producer typed or pasted: a VDO.Ninja view link, a bare id, or blank.
const ID_RE = /^[A-Za-z0-9_.-]+$/;

// Camera link text -> { id, ok }. Blank means "no camera" (ok); anything that does not give a usable id is not ok.
export function cameraIdFromInput(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (t === '') return { id: null, ok: true };
  let id;
  try { id = t.includes('view=') ? streamIdFromLink(t) : t; } catch { id = ''; }
  return id !== '' && ID_RE.test(id) ? { id, ok: true } : { id: null, ok: false };
}

export const cameraLinkForId = (id) => (id === null || id === undefined || id === '' ? '' : 'https://vdo.ninja/?view=' + id);

const txt = (v) => (typeof v === 'string' ? v : '');
// A row with no IGN, no link and not marked sub is an empty row, not a player.
export const isBlankPlayerRow = (p) => !p || (txt(p.ign).trim() === '' && txt(p.link).trim() === '' && !p.sub);

// Returns { match, problems, warnings, tooLong }. match is non-null only when there are no problems.
// problems: [{ kind, team, ign, ti, pi, message, others? }], kinds: noTeams, noPlayers, emptyTeam, badLink, duplicate, limits, tooLong.
// ti/pi are the row's indexes in the form (blank rows included) so the page can mark that row.
// warnings: findNoLinkPlayers of the match: [{ team, ign, sub }].
export function buildMatchFromForm(form) {
  const problems = [];
  const teams = Array.isArray(form && form.teams) ? form.teams : [];
  const teamName = (t) => txt(t && t.name).trim() || 'Team';
  const ignOf = (p) => txt(p.ign).trim();
  const who = (team, ign) => `${team}: ${ign || 'Player with no IGN'}`;
  // rows: every non-blank player with its camera id
  const rows = teams.map((t, ti) => (Array.isArray(t && t.players) ? t.players : [])
    .map((p, pi) => ({ p, ti, pi }))
    .filter((r) => !isBlankPlayerRow(r.p))
    .map((r) => ({ ...r, cam: cameraIdFromInput(txt(r.p.link)) })));
  if (teams.length === 0) problems.push({ kind: 'noTeams', team: '', ign: '', message: 'Add at least one team' });
  else if (rows.every((tr) => tr.length === 0)) problems.push({ kind: 'noPlayers', team: '', ign: '', message: 'Add at least one player' });
  // A team with a blank name and only blank rows is not a team (like a blank player row): it is left out.
  // A named team with no players is a problem.
  const kept = teams.map((t, ti) => ti).filter((ti) => !(txt(teams[ti] && teams[ti].name).trim() === '' && rows[ti].length === 0));
  for (const ti of kept) {
    if (rows[ti].length === 0) {
      problems.push({ kind: 'emptyTeam', team: teamName(teams[ti]), ign: '', ti, message: `${teamName(teams[ti])} has no players` });
    }
  }
  const dropped = new Set(); // rows with a link problem are left out of the limits check below
  for (const tr of rows) for (const r of tr) {
    if (!r.cam.ok) {
      dropped.add(r);
      problems.push({ kind: 'badLink', team: teamName(teams[r.ti]), ign: ignOf(r.p), ti: r.ti, pi: r.pi, message: `${who(teamName(teams[r.ti]), ignOf(r.p))} has a camera link that is not usable` });
    }
  }
  // Duplicates on the raw ids, keyed by row position so each one maps back to its form row.
  const keyed = { teams: rows.map((tr, ti) => ({ name: String(ti), players: tr.map((r, k) => ({ ign: String(k), id: r.cam.id })) })) };
  const dups = findDuplicatePlayers(keyed).map((d) => rows[Number(d.team)][Number(d.ign)]);
  for (const r of dups) {
    dropped.add(r);
    const others = dups.filter((o) => o !== r && o.cam.id === r.cam.id).map((o) => ({ team: teamName(teams[o.ti]), ign: ignOf(o.p) }));
    problems.push({ kind: 'duplicate', team: teamName(teams[r.ti]), ign: ignOf(r.p), ti: r.ti, pi: r.pi, others, message: `${who(teamName(teams[r.ti]), ignOf(r.p))} shares a camera with another player` });
  }
  let match = null;
  if (kept.length > 0) {
    const raw = {
      title: txt(form.title).trim(), game: txt(form.game).trim(), date: txt(form.date).trim(),
      teams: kept.map((ti) => ({
        name: txt(teams[ti].name).trim(),
        players: rows[ti].filter((r) => !dropped.has(r)).map((r) => {
          const o = { ign: ignOf(r.p), id: r.cam.id || '' };
          if (r.p.sub === true) o.sub = true;
          return o;
        }),
      })),
    };
    match = normalizeMatch(raw);
    if (!match) {
      problems.push({ kind: 'limits', team: '', ign: '', message: `Too much in the match: at most ${LIMITS.teams} teams, ${LIMITS.playersPerTeam} players per team, ${LIMITS.ign} characters per IGN and ${LIMITS.text} characters per title, game, date or team name` });
    }
  }
  const warnings = match ? findNoLinkPlayers(match) : [];
  let tooLong = false;
  if (match && problems.length === 0 && ('#m=' + encodeMatch(match)).length > LIMITS.hash) {
    // decodeHash rejects a hash longer than LIMITS.hash, so a longer link would never open
    tooLong = true;
    problems.push({ kind: 'tooLong', team: '', ign: '', message: 'Too much data for one link — remove players or shorten names.' });
  }
  return { match: problems.length === 0 ? match : null, problems, warnings, tooLong };
}

// match (normalized) -> form. The inverse of buildMatchFromForm for a valid match.
export function formFromMatch(match) {
  return {
    title: match.title, game: match.game, date: match.date,
    teams: match.teams.map((t) => ({ name: t.name, players: t.players.map((p) => ({ ign: p.ign, link: cameraLinkForId(p.id), sub: !!p.sub })) })),
  };
}

// ---- roster CSV for the Set up tab ----
export const CSV_COLUMNS = ['school', 'game', 'starter', 'IGN', 'view link'];
const isPlayerRow = (r) => /^(starter|sub)$/i.test(r.starter);
const distinct = (list) => { const out = []; for (const v of list) if (v && !out.includes(v)) out.push(v); return out; };

// rowsOrHeader: parseCsv rows (objects) or a header (array of strings from parseCsvHeader).
export function csvMissingColumns(rowsOrHeader) {
  const list = Array.isArray(rowsOrHeader) ? rowsOrHeader : [];
  const have = new Set(list.flatMap((x) => (typeof x === 'string' ? [x] : x && typeof x === 'object' ? Object.keys(x) : [])));
  return CSV_COLUMNS.filter((c) => !have.has(c));
}

export const csvGames = (rows) => distinct(rows.map((r) => r.game));
export const csvSchools = (rows, gameCode) => distinct(rows.filter((r) => r.game === gameCode && isPlayerRow(r)).map((r) => r.school));

// Form teams for the chosen schools (in the given order), from csvToMatch.
export function csvTeamsForm(rows, gameCode, schools) {
  const m = csvToMatch(rows, { title: '', game: '', date: '', code: gameCode, teams: schools.map((s) => ({ csvName: s, name: s })) });
  return m.teams.map((t) => ({ name: t.name, players: t.players.map((p) => ({ ign: p.ign, link: cameraLinkForId(p.id), sub: !!p.sub })) }));
}

// ---- connection truth from the VDO.Ninja iframe API ----
// The page asks each viewer iframe {getStreamIDs:true, cib}; the iframe answers
// {streamIDs: { <streamID>: <label|false> }, cib} listing the remote peers it currently holds a
// connection to (main.js: it iterates session.rpcs, which is deleted on disconnect). VDO events are
// only a hint to poll again; state is never inferred from them.
export const REPLY_TTL_MS = 5000;

// Viewer URL for one player's camera. Always silent: &noaudio blocks incoming audio tracks and
// disables audio playback for every stream (VDO.Ninja docs). &muted is kept from the original link.
export const VDO_ORIGIN = 'https://vdo.ninja';
export const viewUrl = (id) => `${VDO_ORIGIN}/?view=${encodeURIComponent(id)}&cleanoutput&autoplay&muted&noaudio`;

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

// ---- Load from D1 (the Set up tab): sheet link, game names, roster CSV, master sheet rows ----
// A Google Sheets link or a bare id -> the id, or null.
export function sheetIdFromInput(str) {
  const t = typeof str === 'string' ? str.trim() : '';
  const m = /\/d\/([A-Za-z0-9_-]+)/.exec(t);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(t) ? t : null;
}

const GAME_CODES = { lol: 'LoL', league: 'LoL', 'league of legends': 'LoL', rl: 'RL', 'rocket league': 'RL', val: 'VAL', valorant: 'VAL' };
export function normaliseGame(str) {
  const k = typeof str === 'string' ? str.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(GAME_CODES, k) ? GAME_CODES[k] : null;
}

const GAME_LABELS = { LoL: 'League of Legends', RL: 'Rocket League', VAL: 'Valorant' };
export const gameLabel = (code) => (Object.prototype.hasOwnProperty.call(GAME_LABELS, code) ? GAME_LABELS[code] : '');

// A school roster CSV -> { players: [{ ign, sub }] } for one game, starters first then subs, sheet order within each.
// Only the game, starter and IGN columns are read; every other column is ignored. Blank IGNs are skipped and
// exact duplicate IGNs dropped. { players: [], error: 'noHeader' } when the header or one of the three columns is missing.
export function rosterFromCsv(text, gameCode) {
  const rows = tokenizeCsv(typeof text === 'string' ? text : '');
  const hi = rows.findIndex((r) => r.some((c) => /^ign$/i.test(c.trim())));
  if (hi < 0) return { players: [], error: 'noHeader' };
  const head = rows[hi].map((c) => c.trim());
  const ic = head.findIndex((c) => /^ign$/i.test(c));
  const sc = head.findIndex((c) => /starter/i.test(c));
  // The game column is headed Title or Game. The live sheets head it with a game code instead (e.g. "RL"), so when
  // neither word is there, it is the column (not IGN, not starter) whose cells below the header are game names most often.
  let gc = head.findIndex((c) => /^(title|game)$/i.test(c));
  if (gc < 0) {
    let best = 0;
    head.forEach((_, ci) => {
      if (ci === ic || ci === sc) return;
      const n = rows.slice(hi + 1).filter((r) => normaliseGame(r[ci]) !== null).length;
      if (n > best) { best = n; gc = ci; }
    });
  }
  if (gc < 0 || sc < 0) return { players: [], error: 'noHeader' };
  const starters = [], subs = [], seen = new Set();
  for (const r of rows.slice(hi + 1)) {
    if (normaliseGame(r[gc]) !== gameCode) continue;
    const ign = (r[ic] ?? '').trim();
    if (ign === '' || seen.has(ign)) continue;
    seen.add(ign);
    const sub = !/^starter$/i.test((r[sc] ?? '').trim());
    (sub ? subs : starters).push({ ign, sub });
  }
  return { players: [...starters, ...subs] };
}

// The master sheet as arrays of cells { v, link } (v = the shown text, link = the cell's hyperlink target or empty).
// -> [{ school, rosterId, gid }] for every row below the header that has a school name and a hyperlink to a Google sheet.
// The header is the first row with a "School" cell (that column holds the names). The live master has no "School" header,
// only a "Rosters" one, with the school name in the first column, so a "Rosters" row is the fallback header.
// The link is taken from the "Rosters" column when it has one, else from the first cell in the row that links to a sheet.
export function schoolsFromMasterRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const cellText = (c) => (c && c.v != null ? String(c.v).trim() : '');
  const find = (re) => list.findIndex((r) => Array.isArray(r) && r.some((c) => re.test(cellText(c))));
  let hi = find(/^school$/i), re = /^school$/i;
  if (hi < 0) { hi = find(/^rosters?$/i); re = null; }
  if (hi < 0) return [];
  const sc = re ? list[hi].findIndex((c) => re.test(cellText(c))) : 0;
  const rc = list[hi].findIndex((c) => /^rosters?$/i.test(cellText(c)));
  // The sheet id and the tab (gid, from the query or the #fragment; '0' when absent) a link points at.
  const idOf = (c) => {
    const link = c && typeof c.link === 'string' ? c.link : '';
    const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(link);
    if (!m) return null;
    const g = /[?&#]gid=(\d+)/.exec(link);
    return { rosterId: m[1], gid: g ? g[1] : '0' };
  };
  const out = [];
  for (const r of list.slice(hi + 1)) {
    if (!Array.isArray(r)) continue;
    const school = cellText(r[sc]);
    if (!school) continue;
    let hit = rc >= 0 ? idOf(r[rc]) : null;
    if (!hit) for (const c of r) { hit = idOf(c); if (hit) break; }
    if (hit) out.push({ school, rosterId: hit.rosterId, gid: hit.gid });
  }
  return out;
}

// New form teams, with a camera link carried over from the old form when the same IGN (trimmed, any case) had one
// and the new row has none. Does not change either input.
export function mergeTeamsKeepingLinks(oldTeamsForm, newTeams) {
  const key = (s) => txt(s).trim().toLowerCase();
  const links = new Map();
  for (const t of Array.isArray(oldTeamsForm) ? oldTeamsForm : []) {
    for (const p of Array.isArray(t && t.players) ? t.players : []) {
      if (key(p.ign) !== '' && txt(p.link).trim() !== '' && !links.has(key(p.ign))) links.set(key(p.ign), p.link);
    }
  }
  return newTeams.map((t) => ({
    ...t,
    players: t.players.map((p) => (txt(p.link).trim() === '' && links.has(key(p.ign)) ? { ...p, link: links.get(key(p.ign)) } : { ...p })),
  }));
}

// The saved schools cache (raw localStorage string) -> its schools, but only when it was made from this master. Otherwise [].
export function cachedSchoolsFor(raw, masterId) {
  try {
    const c = JSON.parse(raw);
    if (!c || typeof masterId !== 'string' || masterId === '' || c.masterId !== masterId || !Array.isArray(c.schools)) return [];
    return c.schools.filter((s) => s && typeof s.school === 'string' && typeof s.rosterId === 'string');
  } catch { return []; }
}
