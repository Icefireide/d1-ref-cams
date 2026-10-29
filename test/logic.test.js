import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraIdFromInput, cameraLinkForId, buildMatchFromForm, formFromMatch, decodeHash, encodeMatch, LIMITS,
  parseCsv, parseCsvHeader, csvSchools, csvGames, csvTeamsForm, csvMissingColumns,
  sheetIdFromInput, normaliseGame, gameLabel, rosterFromCsv, schoolsFromMasterRows, mergeTeamsKeepingLinks,
  cachedSchoolsFor, camerasFromCsv, camerasFromSheets, schoolKey, sameSchool, applyCameraLinks, addCameraSheetPlayers, ignKey,
} from '../logic.js';

const P = (ign, link = '', sub = false) => ({ ign, link, sub });
const form = (teams, extra = {}) => ({ title: 'Maryville vs Winthrop', game: 'Valorant', date: '2026-10-16', teams, ...extra });
const kinds = (r) => r.problems.map((p) => p.kind);

test('T1 cameraIdFromInput', () => {
  assert.deepEqual(cameraIdFromInput('https://vdo.ninja/?view=mv_renz'), { id: 'mv_renz', ok: true });
  assert.deepEqual(cameraIdFromInput('https://vdo.ninja/?view=mv_renz&label=x'), { id: 'mv_renz', ok: true });
  assert.deepEqual(cameraIdFromInput('mv_renz'), { id: 'mv_renz', ok: true });
  assert.deepEqual(cameraIdFromInput('   mv_renz \t'), { id: 'mv_renz', ok: true });
  assert.deepEqual(cameraIdFromInput(''), { id: null, ok: true });
  assert.deepEqual(cameraIdFromInput('   '), { id: null, ok: true });
  assert.deepEqual(cameraIdFromInput('https://example.com/foo'), { id: null, ok: false });
  assert.deepEqual(cameraIdFromInput('https://vdo.ninja/?view='), { id: null, ok: false });
  assert.deepEqual(cameraIdFromInput('https://vdo.ninja/?view=&label=x'), { id: null, ok: false });
  assert.deepEqual(cameraIdFromInput('mv renz'), { id: null, ok: false });
  assert.deepEqual(cameraIdFromInput('mv<renz'), { id: null, ok: false });
  assert.deepEqual(cameraIdFromInput('https://vdo.ninja/?view=a%3Cb'), { id: null, ok: false });
  assert.equal(cameraLinkForId(null), '');
  assert.equal(cameraLinkForId('mv_renz'), 'https://vdo.ninja/?view=mv_renz');
});

test('T2 buildMatchFromForm happy path round-trips through the link', () => {
  const r = buildMatchFromForm(form([
    { name: 'Maryville', players: [P('RENZ', 'https://vdo.ninja/?view=mv_renz'), P('', ''), P('Chloric', 'mv_chloric')] },
    { name: 'Winthrop', players: [P('Fair', 'wu_fair'), P('grec', 'https://vdo.ninja/?view=wu_grec', true)] },
  ]));
  assert.deepEqual(r.problems, []);
  assert.equal(r.tooLong, false);
  assert.ok(r.match);
  assert.equal(r.match.teams[0].players.length, 2, 'blank row ignored');
  assert.deepEqual(r.match.teams[1].players[1], { ign: 'grec', id: 'wu_grec', sub: true }, 'sub flag kept');
  assert.equal('sub' in r.match.teams[0].players[0], false);
  const back = decodeHash('#m=' + encodeMatch(r.match));
  assert.equal(back.ok, true);
  assert.deepEqual(back.match, r.match);
});

test('T3 duplicate camera ids across teams', () => {
  const r = buildMatchFromForm(form([
    { name: 'Maryville', players: [P('RENZ', 'same_id'), P('Ange', 'mv_ange')] },
    { name: 'Winthrop', players: [P('Fair', 'https://vdo.ninja/?view=same_id')] },
  ]));
  assert.equal(r.match, null);
  const d = r.problems.filter((p) => p.kind === 'duplicate');
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((p) => [p.team, p.ign, p.ti, p.pi]), [['Maryville', 'RENZ', 0, 0], ['Winthrop', 'Fair', 1, 0]]);
  assert.deepEqual(d[0].others, [{ team: 'Winthrop', ign: 'Fair' }]);
});

test('T4 players with no camera link are warnings, not problems', () => {
  const r = buildMatchFromForm(form([
    { name: 'Maryville', players: [P('RENZ', 'mv_renz'), P('Ange', '')] },
    { name: 'Winthrop', players: [P('grec', '', true)] },
  ]));
  assert.deepEqual(r.problems, []);
  assert.ok(r.match);
  assert.deepEqual(r.warnings, [{ team: 'Maryville', ign: 'Ange', sub: false }, { team: 'Winthrop', ign: 'grec', sub: true }]);
});

test('T5 limits', () => {
  const team = (n, k = 1) => ({ name: 'T' + n, players: Array.from({ length: k }, (_, i) => P('p' + i, `t${n}_p${i}`)) });
  const five = buildMatchFromForm(form([1, 2, 3, 4, 5].map((n) => team(n))));
  assert.equal(five.match, null);
  assert.ok(kinds(five).includes('limits'));
  assert.match(five.problems.find((p) => p.kind === 'limits').message, new RegExp(`at most ${LIMITS.teams} teams`));
  const many = buildMatchFromForm(form([team(1, 17)]));
  assert.equal(many.match, null);
  assert.ok(kinds(many).includes('limits'));
  const ok16 = buildMatchFromForm(form([team(1, 16)]));
  assert.ok(ok16.match);
  const long = buildMatchFromForm(form([{ name: 'A', players: [P('x'.repeat(65), 'a1')] }]));
  assert.equal(long.match, null);
  assert.ok(kinds(long).includes('limits'));
  const empty = buildMatchFromForm(form([]));
  assert.deepEqual(kinds(empty), ['noTeams']);
  const blank = buildMatchFromForm(form([{ name: '', players: [P('', '')] }]));
  assert.deepEqual(kinds(blank), ['noPlayers']);
  assert.equal(blank.match, null);
});

test('T6 a link too long to open is a problem', () => {
  const teams = [1, 2, 3, 4].map((n) => ({ name: 'N'.repeat(120), players: Array.from({ length: 16 }, (_, i) => P('I'.repeat(64), `id${n}_${i}_` + 'z'.repeat(150))) }));
  const r = buildMatchFromForm(form(teams, { title: 't'.repeat(120) }));
  assert.ok(('#m=' + encodeMatch(normalizeLike(teams))).length > LIMITS.hash, 'fixture really is too long');
  assert.equal(r.tooLong, true);
  assert.deepEqual(kinds(r), ['tooLong']);
  assert.equal(r.match, null);
});
function normalizeLike(teams) {
  return { title: 't'.repeat(120), game: 'Valorant', date: '2026-10-16', teams: teams.map((t) => ({ name: t.name, players: t.players.map((p) => ({ ign: p.ign, id: p.link })) })) };
}

test('T7 formFromMatch is the inverse of buildMatchFromForm', () => {
  const m = buildMatchFromForm(form([
    { name: 'Maryville', players: [P('RENZ', 'mv_renz'), P('Ange', '')] },
    { name: 'Winthrop', players: [P('grec', 'wu_grec', true), P('Fair', '', true)] },
  ])).match;
  assert.ok(m);
  const f = formFromMatch(m);
  assert.deepEqual(f.teams[1].players[0], { ign: 'grec', link: 'https://vdo.ninja/?view=wu_grec', sub: true });
  assert.deepEqual(buildMatchFromForm(f).match, m);
});

const FIXTURE = [
  'school,game,starter,IGN,view link',
  'Maryville,Valorant,Starter,RENZ,https://vdo.ninja/?view=mv_renz',
  'Maryville,Valorant,Sub,Ange,https://vdo.ninja/?view=mv_ange&label=Ange',
  'Maryville,Valorant,No,Benched,https://vdo.ninja/?view=mv_benched',
  'Winthrop,Valorant,starter,"Fair, the ""Great""",https://vdo.ninja/?view=wu_fair',
  'Winthrop,Valorant,Sub,grec,',
  'West Virginia,League of Legends,Starter,Mid,https://vdo.ninja/?view=wv_mid',
  'West Virginia,Valorant,No,Coach,',
  '',
].join('\r\n');

test('T8 roster CSV helpers', () => {
  const rows = parseCsv(FIXTURE);
  assert.deepEqual(csvGames(rows), ['Valorant', 'League of Legends']);
  assert.deepEqual(csvSchools(rows, 'Valorant'), ['Maryville', 'Winthrop']);
  assert.deepEqual(csvSchools(rows, 'League of Legends'), ['West Virginia']);
  const teams = csvTeamsForm(rows, 'Valorant', ['Winthrop', 'Maryville']);
  assert.deepEqual(teams, [
    { name: 'Winthrop', players: [{ ign: 'Fair, the "Great"', link: 'https://vdo.ninja/?view=wu_fair', sub: false }, { ign: 'grec', link: '', sub: true }] },
    { name: 'Maryville', players: [{ ign: 'RENZ', link: 'https://vdo.ninja/?view=mv_renz', sub: false }, { ign: 'Ange', link: 'https://vdo.ninja/?view=mv_ange', sub: true }] },
  ]);
  assert.deepEqual(csvMissingColumns(rows), []);
  assert.deepEqual(csvMissingColumns(parseCsvHeader(FIXTURE)), []);
  const noLink = 'school,game,starter,IGN\nMaryville,Valorant,Starter,RENZ\n';
  assert.deepEqual(csvMissingColumns(parseCsv(noLink)), ['view link']);
  const headerOnly = 'school,game,IGN\n';
  assert.deepEqual(parseCsv(headerOnly), []);
  assert.deepEqual(csvMissingColumns(parseCsvHeader(headerOnly)), ['starter', 'view link']);
  assert.deepEqual(csvMissingColumns(parseCsvHeader('')), ['school', 'game', 'starter', 'IGN', 'view link']);
});

// parseCsv exactly as it was at a820e31, before the tokenizer was shared with parseCsvHeader.
function originalParseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
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

test('T9 parseCsv output is unchanged from a820e31', () => {
  for (const text of [FIXTURE, '﻿' + FIXTURE.replace(/\r\n/g, '\n'), 'a,b\n"x\ny",2\n,,\n3', 'a,b\n', '']) {
    assert.deepEqual(parseCsv(text), originalParseCsv(text));
  }
});

test('a link built by a820e31 still decodes', () => {
  // encodeMatch output from a820e31 for the match below (pinned string, do not regenerate)
  const OLD = 'eyJ0aXRsZSI6Ik1hcnl2aWxsZSB2cyBXaW50aHJvcCIsImdhbWUiOiJWYWxvcmFudCIsImRhdGUiOiIyMDI2LTEwLTE2IiwidGVhbXMiOlt7Im5hbWUiOiJNYXJ5dmlsbGUiLCJwbGF5ZXJzIjpbeyJpZ24iOiJSRU5aIiwiaWQiOiJtdl9yZW56In0seyJpZ24iOiJBbmdlIiwiaWQiOm51bGwsInN1YiI6dHJ1ZX1dfSx7Im5hbWUiOiJXaW50aHJvcCIsInBsYXllcnMiOlt7ImlnbiI6IkZhaXIiLCJpZCI6Ind1X2ZhaXIifV19XX0';
  const r = decodeHash('#m=' + OLD);
  assert.equal(r.ok, true);
  assert.deepEqual(r.match, {
    title: 'Maryville vs Winthrop', game: 'Valorant', date: '2026-10-16',
    teams: [
      { name: 'Maryville', players: [{ ign: 'RENZ', id: 'mv_renz' }, { ign: 'Ange', id: null, sub: true }] },
      { name: 'Winthrop', players: [{ ign: 'Fair', id: 'wu_fair' }] },
    ],
  });
});

test('T10 blank teams are ignored; a named team with no players is a problem', () => {
  const mv = { name: 'Maryville', players: [P('RENZ', 'mv_renz')] };
  const blankTeam = { name: '  ', players: [P('', '')] };
  const r = buildMatchFromForm(form([mv, blankTeam, { name: '', players: [] }]));
  assert.deepEqual(r.problems, []);
  assert.equal(r.match.teams.length, 1, 'blank teams left out of the link');
  assert.equal(r.match.teams[0].name, 'Maryville');
  const named = buildMatchFromForm(form([mv, { name: 'Winthrop', players: [P('', '')] }]));
  assert.equal(named.match, null);
  assert.deepEqual(named.problems.map((p) => [p.kind, p.message]), [['emptyTeam', 'Winthrop has no players']]);
  assert.deepEqual(kinds(buildMatchFromForm(form([]))), ['noTeams']);
  const allBlank = buildMatchFromForm(form([blankTeam, { name: '', players: [] }]));
  assert.deepEqual(kinds(allBlank), ['noPlayers']);
  assert.equal(allBlank.match, null);
});

// ---- Load from D1 (all data below is made up) ----
const HEAD = ',School,Title,Starter or Sub,"First name, Last name",Student Email,IGN,Riot ID,Discord ID,Primary Role,Class';
const line = (school, game, st, ign) => `,${school},${game},${st},"Fa, La",x@example.test,${ign},rid,did,Top,Senior`;
const csv = (...rows) => ['', HEAD, ...rows].join('\n');

test('D1 sheetIdFromInput: url, bare id, junk', () => {
  const id = 'AbC123_-AbC123_-AbC123_-AbC';
  assert.equal(sheetIdFromInput(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(sheetIdFromInput(`  ${id}  `), id);
  assert.equal(sheetIdFromInput('short'), null);
  assert.equal(sheetIdFromInput('https://example.com/nothing'), null);
  assert.equal(sheetIdFromInput('has spaces and is long enough to pass'), null);
  assert.equal(sheetIdFromInput(''), null);
  assert.equal(sheetIdFromInput(undefined), null);
});

test('D2 normaliseGame and gameLabel', () => {
  for (const [s, c] of [['lol', 'LoL'], [' League ', 'LoL'], ['League of Legends', 'LoL'], ['RL', 'RL'], ['rocket league', 'RL'], ['VAL', 'VAL'], ['Valorant', 'VAL']]) assert.equal(normaliseGame(s), c);
  assert.equal(normaliseGame('chess'), null);
  assert.equal(normaliseGame(''), null);
  assert.equal(normaliseGame(null), null);
  assert.equal(normaliseGame('constructor'), null);
  assert.equal(gameLabel('LoL'), 'League of Legends');
  assert.equal(gameLabel('RL'), 'Rocket League');
  assert.equal(gameLabel('VAL'), 'Valorant');
  assert.equal(gameLabel('nope'), '');
});

test('D3 rosterFromCsv: header on row 2, University variant, game variants, starter casing', () => {
  const text = ['Team roster,,,', ',University,Title,Starter or Sub,Name,Email,IGN',
    ',Maryville,League of Legends,Starter,n,e,Ann', ',Maryville,LoL,SUB,n,e,Bob', ',Maryville,lol,sub,n,e,Cy', ',Maryville,Valorant,Starter,n,e,Dee', ',Maryville,Rocket League,starter,n,e,Eve'].join('\n');
  const lol = rosterFromCsv(text, 'LoL');
  assert.equal(lol.error, undefined);
  assert.deepEqual(lol.players, [{ ign: 'Ann', sub: false }, { ign: 'Bob', sub: true }, { ign: 'Cy', sub: true }]);
  assert.deepEqual(rosterFromCsv(text, 'VAL').players, [{ ign: 'Dee', sub: false }]);
  assert.deepEqual(rosterFromCsv(text, 'RL').players, [{ ign: 'Eve', sub: false }]);
  assert.deepEqual(rosterFromCsv(csv(line('Winthrop', 'VAL', 'STARTER', 'Fay')), 'VAL').players, [{ ign: 'Fay', sub: false }]);
});

test('D4 rosterFromCsv: blank IGN skipped, duplicate IGN dropped, only ign and sub kept', () => {
  const r = rosterFromCsv(csv(line('M', 'VAL', 'Starter', 'Ann'), line('M', 'VAL', 'Starter', '  '), line('M', 'VAL', 'SUB', 'Ann'), line('M', 'VAL', 'SUB', 'ann')), 'VAL');
  assert.deepEqual(r.players, [{ ign: 'Ann', sub: false }, { ign: 'ann', sub: true }]);
  assert.deepEqual(Object.keys(r.players[0]), ['ign', 'sub']);
});

test('D5 rosterFromCsv: a missing IGN, game or starter column is noHeader', () => {
  assert.equal(rosterFromCsv(',School,Title,Starter or Sub\n,M,VAL,Starter', 'VAL').error, 'noHeader');
  assert.equal(rosterFromCsv('School,Starter,IGN\nM,Starter,Ann', 'VAL').error, 'noHeader');
  assert.equal(rosterFromCsv('School,Title,IGN\nM,VAL,Ann', 'VAL').error, 'noHeader');
  assert.equal(rosterFromCsv('', 'VAL').error, 'noHeader');
  assert.deepEqual(rosterFromCsv('', 'VAL').players, []);
});

test('D6 rosterFromCsv: starters come before subs, sheet order within each group', () => {
  const r = rosterFromCsv(csv(line('M', 'RL', 'SUB', 'S1'), line('M', 'RL', 'Starter', 'A1'), line('M', 'RL', 'sub', 'S2'), line('M', 'RL', 'Starter', 'A2')), 'RL');
  assert.deepEqual(r.players.map((p) => p.ign), ['A1', 'A2', 'S1', 'S2']);
  assert.deepEqual(r.players.map((p) => p.sub), [false, false, true, true]);
});

test('D7 schoolsFromMasterRows: with and without links', () => {
  const c = (v, link) => ({ v, link });
  const rows = [
    [c('D1 Member Info')],
    [c('School'), c('Contact'), c('Rosters')],
    [c('Maryville'), c('x'), c('Roster', 'https://docs.google.com/spreadsheets/d/idMaryville123/edit')],
    [c('Winthrop'), c('x'), c('Roster', 'https://docs.google.com/spreadsheets/d/idWinthrop456/edit#gid=0')],
    [c('NoLink'), c('x'), c('Roster')],
    [c('OtherLink'), c('x'), c('Roster', 'https://example.com/page')],
    [c(''), c('x'), c('Roster', 'https://docs.google.com/spreadsheets/d/idNoSchool789/edit')],
  ];
  assert.deepEqual(schoolsFromMasterRows(rows), [{ school: 'Maryville', rosterId: 'idMaryville123', gid: '0' }, { school: 'Winthrop', rosterId: 'idWinthrop456', gid: '0' }]);
  assert.deepEqual(schoolsFromMasterRows([[c('Nothing here')]]), []);
  assert.deepEqual(schoolsFromMasterRows([]), []);
});

test('D8 mergeTeamsKeepingLinks keeps the link on a case-insensitive IGN match', () => {
  const old = [{ name: 'A', players: [P('Ann', 'https://vdo.ninja/?view=ann1'), P('Bob', '')] }, { name: 'B', players: [P('Cy', 'cy1')] }];
  const nu = [{ name: 'Maryville', players: [P(' ANN '), P('Bob'), P('Cy', 'mine')] }];
  const out = mergeTeamsKeepingLinks(old, nu);
  assert.equal(out[0].players[0].link, 'https://vdo.ninja/?view=ann1');
  assert.equal(out[0].players[1].link, '');
  assert.equal(out[0].players[2].link, 'mine');
  assert.equal(nu[0].players[0].link, '');
});

test('D9 mergeTeamsKeepingLinks drops the link when no IGN matches', () => {
  const out = mergeTeamsKeepingLinks([{ name: 'A', players: [P('Ann', 'ann1')] }], [{ name: 'W', players: [P('Zed', '', true)] }]);
  assert.deepEqual(out, [{ name: 'W', players: [{ ign: 'Zed', link: '', sub: true }] }]);
  assert.deepEqual(mergeTeamsKeepingLinks([], [{ name: 'W', players: [P('Zed')] }]), [{ name: 'W', players: [P('Zed')] }]);
});

test('D10 rosterFromCsv: game column headed with a game code instead of Title', () => {
  const text = ['', ',University,RL,Starter or Sub,Name,IGN', ',M,Valorant,Starter,n,Ann', ',M,Valorant,SUB,n,Bob', ',M,Rocket League,Starter,n,Cy'].join('\n');
  assert.deepEqual(rosterFromCsv(text, 'VAL').players, [{ ign: 'Ann', sub: false }, { ign: 'Bob', sub: true }]);
  assert.deepEqual(rosterFromCsv(text, 'RL').players, [{ ign: 'Cy', sub: false }]);
  assert.deepEqual(rosterFromCsv(text, 'LoL').players, []);
});

test('D11 schoolsFromMasterRows: no School header uses Rosters header and the first column; Rosters column link wins', () => {
  const c = (v, link) => ({ v, link });
  const rows = [
    [c('Column 1'), c('Logo'), c('Rosters')],
    [c('Maryville'), c('Logo', 'https://docs.google.com/spreadsheets/d/idLogoSheet000/edit'), c('Roster', 'https://docs.google.com/spreadsheets/d/idMaryville123/edit')],
    [c('Winthrop'), c('Logo'), c('Roster', 'https://docs.google.com/spreadsheets/d/idWinthrop456/edit')],
    [c('Third'), c('Logo', 'https://docs.google.com/spreadsheets/d/idElsewhere999/edit'), c('Roster')],
  ];
  assert.deepEqual(schoolsFromMasterRows(rows), [
    { school: 'Maryville', rosterId: 'idMaryville123', gid: '0' }, { school: 'Winthrop', rosterId: 'idWinthrop456', gid: '0' }, { school: 'Third', rosterId: 'idElsewhere999', gid: '0' }]);
});

test('D12 schoolsFromMasterRows: gid from the fragment, from the query, or 0', () => {
  const c = (v, link) => ({ v, link });
  const u = 'https://docs.google.com/spreadsheets/d/';
  const rows = [[c('School'), c('Rosters')],
    [c('A'), c('r', u + 'idAAAAAAAA1/edit#gid=123')], [c('B'), c('r', u + 'idBBBBBBBB2/edit?gid=5&x=1')], [c('C'), c('r', u + 'idCCCCCCCC3/edit')], [c('D'), c('r', u + 'idDDDDDDDD4/edit?usp=sharing#gid=77')]];
  assert.deepEqual(schoolsFromMasterRows(rows).map((s) => s.gid), ['123', '5', '0', '77']);
});

test('D13 cachedSchoolsFor only trusts a cache made from the same master', () => {
  const raw = JSON.stringify({ masterId: 'm1', at: 1, schools: [{ school: 'A', rosterId: 'r1', gid: '0' }, { school: 5 }] });
  assert.deepEqual(cachedSchoolsFor(raw, 'm1'), [{ school: 'A', rosterId: 'r1', gid: '0' }]);
  assert.deepEqual(cachedSchoolsFor(raw, 'm2'), []);
  assert.deepEqual(cachedSchoolsFor(JSON.stringify({ at: 1, schools: [{ school: 'A', rosterId: 'r1' }] }), 'm1'), []);
  assert.deepEqual(cachedSchoolsFor(raw, null), []);
  assert.deepEqual(cachedSchoolsFor(JSON.stringify({ masterId: null, schools: [{ school: 'A', rosterId: 'r1' }] }), null), []);
  assert.deepEqual(cachedSchoolsFor('junk', 'm1'), []);
  assert.deepEqual(cachedSchoolsFor(null, 'm1'), []);
});

// ---- camera links sheet ----
const VIEW = (id) => 'https://vdo.ninja/?view=' + id;

test('C1 camerasFromCsv: header not on row 1, blank rows and preamble ignored', () => {
  const text = ['Camera sheet,,,', ',,,', 'Game,Starter/Sub,Name,IGN,Camera link', 'VAL,Starter,Some One,Ann,https://vdo.ninja/?push=ann1&webcam', 'VAL,Sub,Other,Bob,bob2'].join('\n');
  assert.deepEqual(camerasFromCsv(text, { defaultSchool: 'Maryville' }).rows, [
    { school: 'Maryville', game: 'VAL', ign: 'Ann', id: 'ann1' }, { school: 'Maryville', game: 'VAL', ign: 'Bob', id: 'bob2', sub: true }]);
});

test('C2 camerasFromCsv: each header variant, school and game columns', () => {
  const ign = ['IGN', 'name', 'Player', 'Gamer Tag', 'In-Game Name'];
  const link = ['Camera Link', 'VDO Link', 'vdo.ninja link', 'VDO Ninja Link', 'camera url', 'camera', 'cam', 'cam link'];
  for (const a of ign) assert.deepEqual(camerasFromCsv(`${a},Camera link\nAnn,ann1`).rows, [{ school: '', game: null, ign: 'Ann', id: 'ann1' }], a);
  for (const b of link) assert.deepEqual(camerasFromCsv(`IGN, ${b} \nAnn,ann1`).rows, [{ school: '', game: null, ign: 'Ann', id: 'ann1' }], b);
  for (const s of ['School Name', 'school', 'Team', 'team name', 'University']) {
    assert.equal(camerasFromCsv(`${s},Game,IGN,Camera\nWinthrop,Valorant,Ann,ann1`).rows[0].school, 'Winthrop', s);
  }
  for (const g of ['Game', 'Title']) assert.equal(camerasFromCsv(`${g},IGN,Camera\nRocket League,Ann,ann1`).rows[0].game, 'RL', g);
  assert.equal(camerasFromCsv('IGN,Camera\nAnn,ann1', { defaultGame: 'LoL' }).rows[0].game, 'LoL');
  assert.equal(camerasFromCsv('School,IGN,Camera\n,Ann,ann1', { defaultSchool: 'Tab' }).rows[0].school, 'Tab');
});

test('C3 camerasFromCsv: view URL, push URL, bare id, junk, blank; no header', () => {
  const text = ['IGN,Camera link', 'A,' + VIEW('a1') + '&label=x', 'B,https://vdo.ninja/?push=b2&webcam', 'C,c3', 'D,https://example.com/x', 'E,two words', 'F,', ',f6', 'G,https://vdo.ninja/?push='].join('\n');
  assert.deepEqual(camerasFromCsv(text).rows.map((r) => [r.ign, r.id]), [['A', 'a1'], ['B', 'b2'], ['C', 'c3']]);
  assert.deepEqual(camerasFromCsv('Foo,Bar\n1,2'), { rows: [], error: 'noHeader' });
  assert.deepEqual(camerasFromCsv('IGN\nAnn'), { rows: [], error: 'noHeader' });
  assert.deepEqual(camerasFromCsv(null), { rows: [], error: 'noHeader' });
});

test('C4 camerasFromSheets: the tab name is the school; a tab with no header is skipped', () => {
  const r = camerasFromSheets([{ name: 'Maryville', csv: 'Game,IGN,Camera link\nVAL,Ann,ann1' }, { name: 'Notes', csv: 'hello\nthere' }, { name: 'Winthrop', csv: 'Game,IGN,Camera link\nRL,Bob,bob2' }]);
  assert.deepEqual(r.rows, [{ school: 'Maryville', game: 'VAL', ign: 'Ann', id: 'ann1' }, { school: 'Winthrop', game: 'RL', ign: 'Bob', id: 'bob2' }]);
  assert.deepEqual(camerasFromSheets([{ name: 'x', csv: 'nope' }]), { rows: [], error: 'noHeader' });
  assert.deepEqual(camerasFromSheets(null), { rows: [], error: 'noHeader' });
});

test('C5 schoolKey and sameSchool', () => {
  assert.equal(schoolKey('Maryville University'), schoolKey('Maryville'));
  assert.equal(schoolKey('The University of Winthrop'), schoolKey('winthrop'));
  assert.equal(schoolKey('St. Mary’s  College'), schoolKey('st mary s'));
  assert.ok(sameSchool('Ball State', 'Ball State University'));
  assert.ok(sameSchool('East Tennessee State', 'ETSU'));
  assert.ok(sameSchool('Keiser University', 'Keiser'));
  assert.ok(sameSchool('Grand Canyon University', 'Grand Canyon'));
  assert.ok(sameSchool('Stony Brook University', 'Stony Brook'));
  assert.ok(!sameSchool('Grand Canyon', 'Grand View'));
  assert.ok(!sameSchool('Maryville', 'Mary'));
  assert.ok(!sameSchool('Maryville', 'Winthrop'));
  assert.ok(!sameSchool('', ''));
  assert.ok(!sameSchool('University', 'College'));
});

test('C6 applyCameraLinks fills by school + IGN, filters by game, never overwrites a link', () => {
  const rows = [
    { school: 'Maryville', game: 'VAL', ign: 'Ann', id: 'mv_ann' }, { school: 'Maryville', game: 'RL', ign: 'Ann', id: 'mv_ann_rl' },
    { school: 'Winthrop', game: 'VAL', ign: 'Ann', id: 'wu_ann' }, { school: 'Winthrop', game: 'VAL', ign: 'Bob', id: 'wu_bob' },
    { school: 'Maryville', game: 'VAL', ign: 'Cy', id: 'mv_cy' }];
  const teams = [
    { name: 'Maryville University', players: [P(' ann '), P('Cy', 'typed'), P('Zed'), P('', '')] },
    { name: 'Winthrop', players: [P('ANN', '', true), P('Bob')] }];
  const before = JSON.stringify(teams);
  const r = applyCameraLinks(teams, rows, 'VAL');
  assert.equal(JSON.stringify(teams), before, 'input unchanged');
  assert.deepEqual(r.teamsForm[0].players.map((p) => p.link), [VIEW('mv_ann'), 'typed', '', '']);
  assert.deepEqual(r.teamsForm[1].players, [P('ANN', VIEW('wu_ann'), true), P('Bob', VIEW('wu_bob'))]);
  assert.equal(r.filled, 3);
  assert.equal(r.wanted, 4);
  assert.deepEqual(r.missing, [{ team: 'Maryville University', ign: 'Zed' }]);
  assert.equal(applyCameraLinks(teams, rows, 'RL').teamsForm[0].players[0].link, VIEW('mv_ann_rl'));
});

test('C7 applyCameraLinks: rows with no school match on IGN alone, only when that IGN is unique', () => {
  const rows = [{ school: '', game: 'VAL', ign: 'Ann', id: 'a1' }, { school: '', game: 'VAL', ign: 'Bob', id: 'b1' }, { school: '', game: 'VAL', ign: 'bob', id: 'b2' }, { school: '', game: 'RL', ign: 'Bob', id: 'b3' }];
  const teams = [{ name: 'Any', players: [P('Ann'), P('Bob')] }];
  const r = applyCameraLinks(teams, rows, 'VAL');
  assert.equal(r.teamsForm[0].players[0].link, VIEW('a1'));
  assert.equal(r.teamsForm[0].players[1].link, '', 'ambiguous IGN is not filled');
  assert.deepEqual(r.missing, [{ team: 'Any', ign: 'Bob' }]);
  assert.equal(applyCameraLinks(teams, rows, 'RL').teamsForm[0].players[1].link, VIEW('b3'));
});

test('C8 applyCameraLinks: a school row never fills another school, and conflicting rows are not guessed', () => {
  const rows = [{ school: 'Winthrop', game: 'VAL', ign: 'Ann', id: 'w1' }, { school: 'Maryville', game: 'VAL', ign: 'Bob', id: 'm1' }, { school: 'Maryville', game: 'VAL', ign: 'Bob', id: 'm2' }, { school: 'Maryville', game: 'VAL', ign: 'Dee', id: 'd1' }, { school: 'Maryville', game: 'VAL', ign: 'Dee', id: 'd1' }];
  const r = applyCameraLinks([{ name: 'Maryville', players: [P('Ann'), P('Bob'), P('Dee')] }], rows, 'VAL');
  assert.deepEqual(r.teamsForm[0].players.map((p) => p.link), ['', '', VIEW('d1')]);
  assert.deepEqual(r.missing.map((m) => m.ign), ['Ann', 'Bob']);
  assert.deepEqual(applyCameraLinks(null, null, 'VAL'), { teamsForm: [], filled: 0, wanted: 0, missing: [] });
});

test('C9 applyCameraLinks: tolerant IGN (accents, spaces, punctuation, #TAG) and school spelling (Grand View / Grandview)', () => {
  const rows = [
    { school: 'Grand View', game: 'LoL', ign: 'Teddy#gap', id: 't1' }, { school: 'Grand View', game: 'LoL', ign: 'Dancing with the bl', id: 'd1' },
    { school: 'Grand View', game: 'LoL', ign: 'Beatless', id: 'b1' }, { school: 'Grand View', game: 'LoL', ign: 'Ann', id: 'a1' }, { school: 'Grand View', game: 'LoL', ign: 'Ann-', id: 'a2' }];
  const r = applyCameraLinks([{ name: 'Grandview', players: [P('Teddy'), P('Dancing With The Bl '), P('\u00dfeatless'.replace('\u00df', 'B')), P('Ann'), P('A.n.n')] }], rows, 'LoL');
  assert.deepEqual(r.teamsForm[0].players.map((p) => p.link), [VIEW('t1'), VIEW('d1'), VIEW('b1'), VIEW('a1'), '']);
  assert.equal(ignKey('R\u00e9nz #NA1'), 'renz');
});

test('C10 addCameraSheetPlayers adds every camera-sheet player the team lacks, subs marked, none twice, capped', () => {
  const rows = [
    { school: 'Winthrop', game: 'LoL', ign: 'A', id: 'a' }, { school: 'Winthrop', game: 'LoL', ign: 'B', id: 'b', sub: true },
    { school: 'Winthrop', game: 'RL', ign: 'R', id: 'r' }, { school: 'Maryville', game: 'LoL', ign: 'M', id: 'm' }];
  const teams = [{ name: 'Winthrop', players: [P('a-ish', VIEW('a'))] }];
  const before = JSON.stringify(teams);
  const x = addCameraSheetPlayers(teams, rows, 'LoL');
  assert.equal(JSON.stringify(teams), before);
  assert.deepEqual(x.teamsForm[0].players, [P('a-ish', VIEW('a')), P('B', VIEW('b'), true)]);
  assert.deepEqual(x.added, [{ team: 'Winthrop', ign: 'B', sub: true }]);
  const many = Array.from({ length: 18 }, (_, i) => ({ school: 'W', game: 'LoL', ign: 'p' + i, id: 'id' + i }));
  const y = addCameraSheetPlayers([{ name: 'W', players: [] }], many, 'LoL');
  assert.equal(y.teamsForm[0].players.length, LIMITS.playersPerTeam);
  assert.equal(y.over.length, 2);
});

test('C11 camerasFromCsv reads a Starter/Sub column', () => {
  const r = camerasFromCsv('Game,Starter/Sub,IGN,Camera link\nLoL,Starter,A,a1\nLoL,Sub,B,b1');
  assert.deepEqual(r.rows.map((x) => !!x.sub), [false, true]);
});

test('C12 camerasFromCsv keeps a blank-IGN row under the Name column', () => {
  const r = camerasFromCsv('Game,Starter/Sub,Name,IGN,Camera link\nLoL,Starter,Jo Bloggs,,https://vdo.ninja/?push=x1&webcam\nLoL,Starter,,,x2');
  assert.deepEqual(r.rows.map((x) => [x.ign, x.id]), [['Jo Bloggs', 'x1']]);
});
