// The Set up tab: builds the match form. DOM only; every rule comes from logic.js.
import {
  LIMITS, encodeMatch, buildMatchFromForm, cameraIdFromInput, isBlankPlayerRow,
  parseCsv, parseCsvHeader, csvMissingColumns, csvGames, csvSchools, csvTeamsForm,
  sheetIdFromInput, cachedSchoolsFor, gameLabel, rosterFromCsv, schoolsFromMasterRows, mergeTeamsKeepingLinks,
  camerasFromSheets, applyCameraLinks, addCameraSheetPlayers,
} from './logic.js?v=6';

const $ = (id) => document.getElementById(id);
// Element builder. Text only ever goes in through textContent / attributes, never innerHTML.
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
};

export const emptyForm = () => ({
  title: '', game: '', date: '',
  teams: [{ name: '', players: [{ ign: '', link: '', sub: false }] }, { name: '', players: [{ ign: '', link: '', sub: false }] }],
});

export const linkForMatch = (match) => location.origin + location.pathname + '#m=' + encodeMatch(match);

// form: initial form. badHashMessage: shown as a red banner until the form makes a valid link.
// onUpdate(result, { fromUser }) runs after every change (and once at start with fromUser false).
export function initMaker({ form, badHashMessage, onUpdate }) {
  const state = structuredClone(form);
  const csv = { rows: null, file: '', game: '', ticked: new Set(), undo: null };
  const banner = $('setup-banner');
  if (badHashMessage) { banner.textContent = badHashMessage; banner.hidden = false; }

  function setStatus(el, ti, pi, res) {
    const p = state.teams[ti].players[pi];
    el.className = 'status';
    el.textContent = '';
    if (isBlankPlayerRow(p)) return;
    const cam = cameraIdFromInput(p.link);
    const dup = res.problems.find((x) => x.kind === 'duplicate' && x.ti === ti && x.pi === pi);
    if (!cam.ok) { el.classList.add('bad'); el.textContent = 'Not a VDO.Ninja view link or camera id'; }
    else if (!cam.id) { el.classList.add('warn'); el.textContent = 'No camera link'; }
    else if (dup) { el.classList.add('bad'); el.textContent = 'Same camera as ' + dup.others.map((o) => `${o.team} · ${o.ign || 'no IGN'}`).join(', '); }
    else { el.classList.add('ok'); el.append('Camera id: ', h('code', { text: cam.id })); }
  }

  function renderOutput(res) {
    const rows = state.teams.flatMap((t) => t.players.filter((p) => !isBlankPlayerRow(p)));
    const cams = rows.filter((p) => cameraIdFromInput(p.link).id).length;
    const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    $('summary').textContent = `${n(state.teams.length, 'team')} · ${n(rows.length, 'player')} · ${n(cams, 'camera')}`;
    const warnText = res.warnings.map((w) => `${w.team}: ${w.ign || 'Player with no IGN'} has no camera link${w.sub ? ' (sub)' : ''}`);
    for (const [id, list] of [['problems', res.problems.map((p) => p.message)], ['warnings', warnText]]) {
      const ul = $(id); ul.textContent = ''; ul.hidden = list.length === 0;
      for (const t of list) ul.append(h('li', { text: t }));
    }
    const out = $('result'); out.textContent = '';
    const open = $('open'), copy = $('copy');
    if (res.match) {
      const link = linkForMatch(res.match);
      const ta = h('textarea', { rows: 3, readonly: true, id: 'link-text', 'aria-label': 'Referee link' });
      ta.value = link; out.append(ta);
      open.href = link; open.removeAttribute('aria-disabled'); open.removeAttribute('tabindex');
      copy.disabled = false;
    } else {
      out.append(h('div', { class: 'blocked', text: 'Fix the problems above to get a link.' }));
      open.removeAttribute('href'); open.setAttribute('aria-disabled', 'true'); open.setAttribute('tabindex', '-1');
      copy.disabled = true;
    }
  }

  function update(fromUser) {
    const res = buildMatchFromForm(state);
    if (res.match) banner.hidden = true;
    document.querySelectorAll('#mteams .player').forEach((row) => setStatus(row.querySelector('.status'), +row.dataset.t, +row.dataset.p, res));
    renderOutput(res);
    $('add-team').disabled = state.teams.length >= LIMITS.teams;
    $('team-note').textContent = state.teams.length >= LIMITS.teams ? `${LIMITS.teams} teams max` : '';
    onUpdate(res, { fromUser });
  }

  // Any team edit other than Undo itself ends the single-level undo.
  function teamEdited() {
    if (csv.undo) { csv.undo = null; $('csv-done').hidden = true; }
    if (d1.undo) { d1.undo = null; $('d1-status').textContent = ''; }
  }

  function renderTeams() {
    const root = $('mteams'); root.textContent = '';
    state.teams.forEach((t, ti) => {
      const card = h('div', { class: 'mteam' });
      const head = h('div', { class: 'thead' });
      const name = h('input', { type: 'text', maxlength: LIMITS.text, value: t.name, 'aria-label': 'Team name', placeholder: `Team ${ti + 1}` });
      name.addEventListener('input', () => { t.name = name.value; teamEdited(); update(true); });
      head.append(name, h('button', { type: 'button', class: 'link', text: 'Remove team', onclick: () => { state.teams.splice(ti, 1); teamEdited(); renderTeams(); update(true); } }));
      card.append(head);
      t.players.forEach((p, pi) => {
        const ign = h('input', { type: 'text', maxlength: LIMITS.ign, value: p.ign, placeholder: 'IGN', 'aria-label': 'IGN' });
        const subName = (v) => `Sub: ${v.trim() || 'player ' + (pi + 1)}`;
        const sub = h('input', { type: 'checkbox', 'aria-label': subName(p.ign) }); sub.checked = !!p.sub;
        const lnk = h('input', { type: 'text', class: 'linkin', value: p.link, placeholder: 'https://vdo.ninja/?view=… or the id', 'aria-label': 'Camera link', autocomplete: 'off', spellcheck: 'false' });
        const rm = h('button', { type: 'button', class: 'btn x', text: '×', 'aria-label': `Remove player ${p.ign}`.trim(), onclick: () => { t.players.splice(pi, 1); teamEdited(); renderTeams(); update(true); } });
        ign.addEventListener('input', () => { p.ign = ign.value; rm.setAttribute('aria-label', `Remove player ${ign.value}`.trim()); sub.setAttribute('aria-label', subName(ign.value)); teamEdited(); update(true); });
        sub.addEventListener('change', () => { p.sub = sub.checked; teamEdited(); update(true); });
        lnk.addEventListener('input', () => { p.link = lnk.value; teamEdited(); update(true); });
        card.append(h('div', { class: 'player', 'data-t': ti, 'data-p': pi }, ign, h('label', { class: 'subbox' }, sub, 'Sub'), rm, lnk, h('div', { class: 'status' })));
      });
      const full = t.players.length >= LIMITS.playersPerTeam;
      card.append(h('div', { class: 'addrow' },
        h('button', { type: 'button', class: 'btn', text: 'Add player', disabled: full, onclick: () => {
          t.players.push({ ign: '', link: '', sub: false }); teamEdited(); renderTeams(); update(true);
          const ins = root.querySelectorAll('.mteam')[ti].querySelectorAll('.player');
          ins[ins.length - 1].querySelector('input').focus();
        } }),
        full ? h('span', { class: 'note', text: `${LIMITS.playersPerTeam} players max` }) : null));
      root.append(card);
    });
  }

  // ---- roster CSV ----
  function csvError(text) {
    const m = $('csv-msg'); m.textContent = '';
    if (text) m.append(h('div', { class: 'inline-err', role: 'alert', text, style: 'margin-top:8px' }));
  }
  function renderSchools() {
    const box = $('schools'); box.textContent = '';
    const full = csv.ticked.size >= LIMITS.teams;
    for (const s of csvSchools(csv.rows, csv.game)) {
      const cb = h('input', { type: 'checkbox' }); cb.checked = csv.ticked.has(s);
      cb.disabled = full && !cb.checked;
      cb.addEventListener('change', () => { if (cb.checked) csv.ticked.add(s); else csv.ticked.delete(s); renderSchools(); });
      box.append(h('label', {}, cb, s));
    }
    $('schools-note').textContent = full ? `Up to ${LIMITS.teams} teams` : '';
    $('csv-use').disabled = csv.ticked.size === 0;
  }
  function loadCsvText(text, name) {
    $('csv-done').hidden = true;
    let rows, header;
    try { rows = parseCsv(text); header = parseCsvHeader(text); } catch { rows = []; header = []; }
    const missing = csvMissingColumns(header);
    if (missing.length || !rows.length) {
      csv.rows = null; $('csv-box').hidden = true;
      csvError(missing.length ? `${name} is missing these columns: ${missing.join(', ')}.` : `${name} has no rows.`);
      return;
    }
    csvError(''); csv.rows = rows; csv.file = name; csv.ticked = new Set();
    const games = csvGames(rows);
    const sel = $('csv-game'); sel.textContent = '';
    for (const g of games) sel.append(h('option', { value: g, text: g }));
    const pref = games.find((g) => g.toLowerCase() === state.game.trim().toLowerCase());
    csv.game = pref || games[0] || ''; sel.value = csv.game;
    $('csv-box').hidden = false; renderSchools();
  }
  function readFile(f) {
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) { csvError(`${f.name} is not a .csv file.`); return; }
    f.text().then((t) => loadCsvText(t, f.name), () => csvError(`Could not read ${f.name}.`));
  }
  function useSchools() {
    let teams;
    try { teams = csvTeamsForm(csv.rows, csv.game, [...csv.ticked]); } catch { csvError(`Could not read the camera links in ${csv.file}.`); return; }
    const undo = structuredClone(state.teams);
    state.teams = teams;
    renderTeams(); update(true);
    csv.undo = undo;
    const d = $('csv-done'); d.textContent = '';
    d.append(`Replaced the teams with ${teams.length} school${teams.length === 1 ? '' : 's'} from ${csv.file}.`,
      h('button', { type: 'button', class: 'btn', text: 'Undo', onclick: () => {
        state.teams = csv.undo; csv.undo = null; d.hidden = true; renderTeams(); update(true);
      } }));
    d.hidden = false;
  }

  // ---- Load from D1 ----
  // Only the game, starter and IGN columns of a roster are ever read (rosterFromCsv); nothing else is kept, shown or stored.
  const d1 = { schools: [], checked: [], busy: false };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    remove: (k) => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: the page still works */ } },
  };
  // Setting a new status line also drops the Undo control that sat in it.
  const d1Status = (t) => { d1.undo = null; $('d1-status').textContent = t; };
  const SHEETS = 'https://docs.google.com/spreadsheets/d/';
  function d1Busy(b) {
    d1.busy = b;
    for (const id of ['d1-save', 'd1-load', 'd1-refresh', 'd1-fill', 'd1-change', 'd1-cams-save', 'd1-cams-change']) $(id).disabled = b;
    $('d1-fillcams').disabled = b || !d1Cams();
    $('d1-schools').querySelectorAll('input').forEach((cb) => { cb.disabled = b || (!cb.checked && d1.checked.length >= LIMITS.teams); });
  }
  function d1Master() { return store.get('rcc-d1-master'); }
  // The camera links sheet: stored as {id, gid}. The gid is kept from the link the producer pasted, but every worksheet is read
  // (the live sheet has one tab per school), so the whole workbook is fetched as xlsx.
  function d1Cams() {
    try { const c = JSON.parse(store.get('rcc-d1-cams')); return c && typeof c.id === 'string' && c.id ? c : null; } catch { return null; }
  }
  function d1ShowCams() {
    const has = !!d1Cams();
    $('d1-cams-set').hidden = !has; $('d1-cams-form').hidden = has;
    $('d1-fillcams').disabled = d1.busy || !has;
  }
  // Fetches the camera sheet: every worksheet as CSV, the tab name standing in for a missing school column. Throws on failure.
  async function d1FetchCams() {
    const c = d1Cams();
    if (!c || typeof XLSX === 'undefined') throw new Error('cams');
    const res = await fetch(`${SHEETS}${c.id}/export?format=xlsx`);
    if (!res.ok) throw new Error('http');
    const wb = XLSX.read(await res.arrayBuffer(), { type: 'array' });
    // A workbook with one tab: that tab's name is not necessarily a school, so it is not used as one.
    const sheets = wb.SheetNames.map((name) => ({ name: wb.SheetNames.length === 1 ? '' : name, csv: XLSX.utils.sheet_to_csv(wb.Sheets[name]) }));
    const r = camerasFromSheets(sheets);
    if (r.error) throw new Error('noHeader');
    return r.rows;
  }
  const camsText = (r, x) => `Cameras: ${r.filled} of ${r.wanted} filled${r.missing.length ? ` · ${r.missing.length} not in the camera sheet (${r.missing.map((m) => `${m.team}: ${m.ign}`).join(', ')})` : ''}${x && x.added.length ? ` · ${x.added.length} more added from the camera sheet (${x.added.map((a) => `${a.team}: ${a.ign}${a.sub ? ' (sub)' : ''}`).join(', ')})` : ''}${x && x.ambiguous.length ? ` · more than one team matches ${x.ambiguous.join(', ')}, so nothing was added from it` : ''}${x && x.over.length ? ` · ${x.over.length} did not fit under ${LIMITS.playersPerTeam} players (${x.over.map((m) => `${m.team}: ${m.ign}`).join(', ')})` : ''}`;
  function d1ShowMaster() {
    const has = !!d1Master();
    $('d1-master-set').hidden = !has; $('d1-master-form').hidden = has;
  }
  function d1RenderSchools() {
    const box = $('d1-schools'); box.textContent = '';
    const full = d1.checked.length >= LIMITS.teams;
    for (const s of d1.schools) {
      const cb = h('input', { type: 'checkbox' }); cb.checked = d1.checked.includes(s.school);
      cb.disabled = full && !cb.checked;
      cb.addEventListener('change', () => {
        if (cb.checked) { if (d1.checked.length >= LIMITS.teams) { cb.checked = false; d1Status(`Up to ${LIMITS.teams} schools at a time.`); return; } d1.checked.push(s.school); }
        else d1.checked = d1.checked.filter((x) => x !== s.school);
        d1RenderSchools();
      });
      box.append(h('label', {}, cb, s.school));
    }
    $('d1-note').textContent = full ? `Up to ${LIMITS.teams} schools` : '';
    $('d1-box').hidden = d1.schools.length === 0;
    $('d1-refresh').hidden = d1.schools.length === 0;
    $('d1-fill').disabled = d1.busy || d1.checked.length === 0;
  }
  function d1SetSchools(list) {
    d1.schools = list; d1.checked = d1.checked.filter((n) => list.some((s) => s.school === n));
    d1RenderSchools();
  }
  async function d1FetchSchools() {
    const id = d1Master();
    if (!id) { d1Status('Paste the master sheet link first.'); return; }
    d1Busy(true); d1Status('Loading…');
    try {
      if (typeof XLSX === 'undefined') throw new Error('xlsx');
      const res = await fetch(`${SHEETS}${id}/export?format=xlsx`);
      if (!res.ok) throw new Error('http');
      const wb = XLSX.read(await res.arrayBuffer(), { type: 'array' });
      // The first worksheet (in order) that yields at least one school.
      let schools = [];
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        const rng = XLSX.utils.decode_range(ws['!ref'] || 'A1');
        const rows = [];
        for (let r = rng.s.r; r <= rng.e.r; r++) {
          const row = [];
          for (let c = rng.s.c; c <= rng.e.c; c++) {
            const cell = ws[XLSX.utils.encode_cell({ r, c })];
            row.push({ v: cell ? cell.v : '', link: cell && cell.l && cell.l.Target ? cell.l.Target : '' });
          }
          rows.push(row);
        }
        schools = schoolsFromMasterRows(rows);
        if (schools.length) break;
      }
      if (!schools.length) { d1Status('No schools with roster links were found in the master sheet.'); return; }
      store.set('rcc-d1-schools', JSON.stringify({ masterId: id, at: Date.now(), schools }));
      d1SetSchools(schools);
      d1Status(`Found ${schools.length} schools.`);
    } catch {
      d1Status("Couldn't read the master sheet. Is it shared as 'Anyone with the link'?");
    } finally { d1Busy(false); d1RenderSchools(); }
  }
  async function d1Fill() {
    const code = $('d1-game').value;
    const picked = d1.checked.map((n) => d1.schools.find((s) => s.school === n)).filter(Boolean);
    if (!picked.length) return;
    d1Busy(true); d1Status('Loading…');
    const teams = [], notes = [];
    for (const s of picked) {
      let text;
      try {
        const res = await fetch(`${SHEETS}${s.rosterId}/export?format=csv&gid=${/^\d+$/.test(s.gid || '') ? s.gid : '0'}`);
        if (!res.ok) throw new Error('http');
        text = await res.text();
      } catch { notes.push(`${s.school}: couldn't read the roster sheet, skipped`); continue; }
      const r = rosterFromCsv(text, code);
      if (r.error) { notes.push(`${s.school}: roster sheet has no IGN, game and starter columns, skipped`); continue; }
      if (!r.players.length) { notes.push(`${s.school}: 0 players for ${gameLabel(code)}, skipped`); continue; }
      const players = r.players.slice(0, LIMITS.playersPerTeam);
      const subs = players.filter((p) => p.sub).length;
      notes.push(`${s.school} (${players.length - subs} starter${players.length - subs === 1 ? '' : 's'}, ${subs} sub${subs === 1 ? '' : 's'})${players.length < r.players.length ? ` - only the first ${LIMITS.playersPerTeam} kept` : ''}`);
      teams.push({ name: s.school, players: players.map((p) => ({ ign: p.ign, link: '', sub: p.sub })) });
    }
    const snapshot = { teams: structuredClone(state.teams), game: state.game };
    let merged = teams.length ? mergeTeamsKeepingLinks(state.teams, teams) : null;
    let camText = '';
    if (merged && d1Cams()) {
      try { const rows = await d1FetchCams(); const r = applyCameraLinks(merged, rows, code); const x = addCameraSheetPlayers(r.teamsForm, rows, code); merged = x.teamsForm; camText = camsText(r, x); }
      catch { camText = "Rosters filled; couldn't read the camera sheet."; }
    }
    if (merged) {
      state.teams = merged;
      state.game = gameLabel(code); $('f-game').value = state.game;
      teamEdited(); renderTeams(); update(true);
    }
    const n = teams.length;
    d1Status((n ? `Filled ${n} team${n === 1 ? '' : 's'}: ` : 'Nothing filled. ') + notes.join('; ') + (camText ? `. ${camText}` : ''));
    if (n) d1UndoButton(snapshot);
    d1Busy(false); d1RenderSchools();
  }
  // Undo for the last fill: puts back the teams and game from before it.
  function d1UndoButton(snapshot) {
    d1.undo = snapshot;
    $('d1-status').append(' ', h('button', { type: 'button', class: 'btn', text: 'Undo', onclick: () => {
      const u = d1.undo; if (!u) return;
      state.teams = u.teams; state.game = u.game; $('f-game').value = u.game;
      d1Status('Put the teams back.'); renderTeams(); update(true);
    } }));
  }
  // Fill cameras: applies the camera sheet to the teams in the form now (which may be hand-made).
  async function d1FillCams() {
    if (!d1Cams()) { d1Status('Paste the camera links sheet link first.'); return; }
    const code = $('d1-game').value;
    d1Busy(true); d1Status('Loading…');
    try {
      let rows;
      try { rows = await d1FetchCams(); } catch { d1Status("Couldn't read the camera sheet. Is it shared as 'Anyone with the link'?"); return; }
      const snapshot = { teams: structuredClone(state.teams), game: state.game };
      const r = applyCameraLinks(state.teams, rows, code);
      const x = addCameraSheetPlayers(r.teamsForm, rows, code);
      if (r.filled === 0 && x.added.length === 0) { d1Status(r.wanted === 0 ? 'Every player already has a camera link, or there are no players yet.' : camsText(r, x) + '.'); return; }
      state.teams = x.teamsForm; teamEdited(); renderTeams(); update(true);
      d1Status(camsText(r, x) + '.');
      d1UndoButton(snapshot);
    } finally { d1Busy(false); d1RenderSchools(); }
  }
  $('d1-save').addEventListener('click', () => {
    const id = sheetIdFromInput($('d1-master').value);
    if (!id) { d1Status("That isn't a Google Sheets link."); return; }
    if (id !== d1Master()) { d1.schools = []; d1.checked = []; store.remove('rcc-d1-schools'); d1RenderSchools(); }
    store.set('rcc-d1-master', id); $('d1-master').value = ''; d1ShowMaster(); d1Status('');
  });
  $('d1-change').addEventListener('click', () => { $('d1-master-set').hidden = true; $('d1-master-form').hidden = false; $('d1-master').focus(); });
  $('d1-cams-save').addEventListener('click', () => {
    const t = $('d1-cams').value;
    const id = sheetIdFromInput(t);
    if (!id) { d1Status("That isn't a Google Sheets link."); return; }
    const g = /[?&#]gid=(\d+)/.exec(t);
    store.set('rcc-d1-cams', JSON.stringify({ id, gid: g ? g[1] : '0' })); $('d1-cams').value = ''; d1ShowCams(); d1Status('');
  });
  $('d1-cams-change').addEventListener('click', () => { $('d1-cams-set').hidden = true; $('d1-cams-form').hidden = false; $('d1-fillcams').disabled = true; $('d1-cams').focus(); });
  $('d1-fillcams').addEventListener('click', d1FillCams);
  $('d1-load').addEventListener('click', () => { if (d1.schools.length) { d1RenderSchools(); d1Status(''); } else d1FetchSchools(); });
  $('d1-refresh').addEventListener('click', d1FetchSchools);
  $('d1-fill').addEventListener('click', d1Fill);
  d1.schools = cachedSchoolsFor(store.get('rcc-d1-schools'), d1Master());
  d1ShowMaster(); d1ShowCams(); d1RenderSchools();

  // ---- wiring ----
  for (const k of ['title', 'game', 'date']) {
    const el = $('f-' + k); el.value = state[k];
    el.addEventListener('input', () => { state[k] = el.value; update(true); });
  }
  $('add-team').addEventListener('click', () => {
    state.teams.push({ name: '', players: [{ ign: '', link: '', sub: false }] }); teamEdited(); renderTeams(); update(true);
    const n = $('mteams').querySelectorAll('.thead input'); n[n.length - 1].focus();
  });
  $('csv-file').addEventListener('change', (e) => { readFile(e.target.files[0]); e.target.value = ''; });
  $('csv-game').addEventListener('change', (e) => { csv.game = e.target.value; csv.ticked = new Set(); renderSchools(); });
  $('csv-use').addEventListener('click', useSchools);
  const drop = $('drop');
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => readFile(e.dataTransfer && e.dataTransfer.files[0]));
  $('open').addEventListener('click', (e) => { if ($('open').getAttribute('aria-disabled') === 'true') e.preventDefault(); });
  let copyTimer;
  $('copy').addEventListener('click', () => {
    const ta = $('link-text'); if (!ta) return;
    const note = $('copy-note'), btn = $('copy');
    const fallback = () => { ta.focus(); ta.select(); note.textContent = 'Press Ctrl+C to copy'; };
    if (!navigator.clipboard) return fallback();
    navigator.clipboard.writeText(ta.value).then(() => {
      btn.textContent = 'Copied'; note.textContent = ''; clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { btn.textContent = 'Copy link'; }, 2000);
    }, fallback);
  });
  $('csv-details').open = !state.teams.some((t) => t.players.some((p) => !isBlankPlayerRow(p)));
  renderTeams();
  update(false);
}
