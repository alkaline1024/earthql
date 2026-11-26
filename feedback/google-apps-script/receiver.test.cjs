const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const script = readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const key = 'ab'.repeat(32); // Fixture only.
const fixtureTime = '2026-01-15T10:30:00.000Z';
const draft = {
  id: 'de305d54-75b4-431b-adb2-eb6b9e546014', kind: 'bug', title: '=1+2',
  description: 'หน้าต่างยังเปิดอยู่', appVersion: '0.1.0', osVersion: '15.0.0',
};
const jpeg = Buffer.from([255, 216, 255, 224, 0, 255, 217]).toString('base64');

function fixture(overrides = {}) {
  const rows = [];
  const activityRows = [];
  const files = new Map();
  const state = { busy: false, failAppend: false, appendOptions: null };
  const properties = { FEEDBACK_KEY: key, FEEDBACK_SHEET_ID: 'sheet', FEEDBACK_FOLDER_ID: 'folder', ...overrides };
  const opened = { sheets: [], folders: [] };
  const makeSheet = (rows) => ({
    getLastRow: () => rows.length,
    setFrozenRows: () => {},
    getRange: (start, column = 1, _height = 1, width = 1) => ({
      getValues: () => [Array.from({ length: width }, (_, offset) => rows[start - 1]?.[column - 1 + offset] ?? '')],
      getValue: () => rows[start - 1]?.[column - 1] ?? '',
      setValue: (value) => { rows[start - 1][column - 1] = value; },
      setValues: ([row]) => rows.push(Array.from(row)),
      createTextFinder: (id) => ({
        matchEntireCell: () => ({ findNext: () => rows.slice(start - 1).find(row => row[0] === id) }),
      }),
    }),
  });
  const sheet = makeSheet(rows);
  let activitySheet;
  const context = vm.createContext({
    Date: class extends Date { constructor() { super(fixtureTime); } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (name) => properties[name],
      setProperties: (values) => Object.assign(properties, values),
    }) },
    SpreadsheetApp: { flush: () => {}, openById: (id) => {
      opened.sheets.push(id);
      return {
        getSheetByName: (name) => name === 'Activity Log' ? activitySheet : sheet,
        insertSheet: () => (activitySheet = makeSheet(activityRows)),
        getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id,
      };
    } },
    DriveApp: { getFolderById: (id) => {
      if (id === 'unavailable-folder') throw new Error('Invalid argument: id');
      opened.folders.push(id);
      return {
        getName: () => 'Private folder',
        getFilesByName: (name) => ({ hasNext: () => files.has(name), next: () => files.get(name) }),
        createFile: ({ name }) => {
          const file = { getUrl: () => 'https://drive.google.com/file/d/fixture/view' };
          files.set(name, file);
          return file;
        },
      };
    } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      base64Decode: (text) => Buffer.from(text, 'base64'),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
      computeDigest: (algorithm, bytes) => createHash(algorithm).update(bytes).digest(),
      newBlob: (_bytes, _type, name) => ({ name }),
    },
    Sheets: { Spreadsheets: { Values: { append: ({ values: [row] }, _id, _range, options) => {
      state.appendOptions = options;
      if (state.failAppend) throw new Error('Temporary upstream failure');
      (_range.includes('Activity Log') ? activityRows : rows).push(row);
    } } } },
    LockService: { getScriptLock: () => ({ tryLock: () => !state.busy, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (body) => ({ setMimeType: () => body }) },
  });
  vm.runInContext(script, context);
  context.setupFeedback();

  return {
    rows, activityRows, files, state, properties, opened,
    setupActivity: () => context.setupActivity(),
    post: (body) => context.doPost({ postData: { contents: body } }),
  };
}

test('setup and intake accept copied Google links and pass just IDs to the services', () => {
  const inbox = fixture({
    FEEDBACK_FOLDER_ID: ' https://drive.google.com/drive/u/0/folders/folder-1_2?usp=sharing ',
    FEEDBACK_SHEET_ID: 'https://docs.google.com/spreadsheets/d/book-1_2/edit#gid=0',
  });
  const body = JSON.stringify({ key, report: { ...draft, screenshot: jpeg } });
  assert.deepEqual(JSON.parse(inbox.post(body)), { ok: true, id: draft.id });
  assert.deepEqual(inbox.opened.folders, ['folder-1_2', 'folder-1_2']);
  assert.deepEqual(inbox.opened.sheets, ['book-1_2', 'book-1_2']);
  inbox.properties.FEEDBACK_FOLDER_ID = 'https://drive.google.com/file/d/not-a-folder/view';
  assert.deepEqual(JSON.parse(inbox.post(body)), { ok: false, code: 'SETUP' });
});

test('setup names the property when a folder link is missing, wrong or inaccessible', () => {
  assert.throws(() => fixture({ FEEDBACK_FOLDER_ID: '' }), /Set FEEDBACK_FOLDER_ID/);
  assert.throws(() => fixture({ FEEDBACK_FOLDER_ID: 'https://drive.google.com/file/d/fixture/view' }), /Set FEEDBACK_FOLDER_ID/);
  assert.throws(() => fixture({ FEEDBACK_FOLDER_ID: 'unavailable-folder' }), /Cannot open the Drive folder in FEEDBACK_FOLDER_ID/);
  assert.throws(() => fixture({ FEEDBACK_SHEET_ID: 'https://docs.google.com/document/d/fixture/edit' }), /Set FEEDBACK_SHEET_ID/);
});

test('HTTP intake checks the key, stores literal text and returns the same receipt on retry', async (t) => {
  const { rows, files, state, post } = fixture();
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('content-type', 'application/json');
    response.end(post(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/exec`;
  const submit = async (key, report) => (await fetch(url, { method: 'POST', body: JSON.stringify({ key, report }) })).json();

  assert.deepEqual(await submit('cd'.repeat(32), { ...draft, screenshot: jpeg }), { ok: false, code: 'UNAUTHORIZED' });
  assert.equal(rows.length, 1);
  assert.equal(files.size, 0);
  assert.deepEqual(await submit(key, { ...draft, screenshot: 'bm90IGFuIGltYWdl' }), { ok: false, code: 'INVALID' });
  assert.deepEqual(await submit(key, { ...draft, screenshot: jpeg }), { ok: true, id: draft.id });
  assert.deepEqual(await submit(key, { ...draft, screenshot: jpeg }), { ok: true, id: draft.id });
  assert.equal(rows.length, 2);
  assert.equal(files.size, 1);
  assert.equal(rows[1][3], '=1+2');
  assert.equal(rows[1][4], draft.description);
  assert.equal(rows[1][8], 'New');
  assert.equal(state.appendOptions.valueInputOption, 'RAW');
});

test('retry after a Sheet failure reuses the existing attachment and inserts one row', () => {
  const { rows, files, state, post } = fixture();
  const body = JSON.stringify({ key, report: { ...draft, screenshot: jpeg } });
  state.busy = true;
  assert.deepEqual(JSON.parse(post(body)), { ok: false, code: 'BUSY' });
  assert.equal(files.size, 0);
  state.busy = false;
  state.failAppend = true;
  assert.deepEqual(JSON.parse(post(body)), { ok: false, code: 'STORAGE' });
  assert.equal(files.size, 1);
  assert.equal(rows.length, 1);
  state.failAppend = false;
  assert.deepEqual(JSON.parse(post(body)), { ok: true, id: draft.id });
  assert.equal(files.size, 1);
  assert.equal(rows.length, 2);
});

test('a bundled app can submit without credentials only when the owner enables public intake', () => {
  const body = JSON.stringify({ report: draft });
  const privateInbox = fixture();
  assert.deepEqual(JSON.parse(privateInbox.post(body)), { ok: false, code: 'UNAUTHORIZED' });
  assert.equal(privateInbox.rows.length, 1);

  const published = fixture({ FEEDBACK_KEY: '', FEEDBACK_PUBLIC_SUBMISSIONS: 'true' });
  assert.deepEqual(JSON.parse(published.post(body)), { ok: true, id: draft.id });
  assert.equal(published.rows.length, 2);
  assert.equal(published.files.size, 0);
});

test('public limits bound new uploads without blocking an existing receipt', () => {
  const day = fixtureTime.slice(0, 10);
  const bundled = fixture({ FEEDBACK_PUBLIC_SUBMISSIONS: 'true', FEEDBACK_PUBLIC_DAY: day + '|99' });
  const submit = (report) => JSON.parse(bundled.post(JSON.stringify({ report: { ...report, screenshot: jpeg } })));
  const newReport = { ...draft, id: 'de305d54-75b4-431b-adb2-eb6b9e546015' };
  assert.deepEqual(submit(draft), { ok: true, id: draft.id });
  assert.deepEqual(submit(draft), { ok: true, id: draft.id });
  assert.deepEqual(submit(newReport), { ok: false, code: 'RATE_LIMIT' });
  assert.equal(bundled.rows.length, 2);
  assert.equal(bundled.files.size, 1);

  bundled.properties.FEEDBACK_PUBLIC_DAY = '2000-01-01|100';
  bundled.properties.FEEDBACK_PUBLIC_MINUTE = fixtureTime.slice(0, 16) + '|10';
  assert.deepEqual(submit(newReport), { ok: false, code: 'RATE_LIMIT' });
  bundled.properties.FEEDBACK_PUBLIC_MINUTE = '2000-01-01T00:00|10';
  assert.deepEqual(submit(newReport), { ok: true, id: newReport.id });
});

test('activity is opt-in server-side and writes only allowed fields to a separate tab', () => {
  const activity = { sessionId: draft.id, event: 'open', appVersion: '0.3.0' };
  const body = JSON.stringify({ activity: { ...activity, username: 'earthql-test', computerName: 'ignored' } });
  assert.deepEqual(JSON.parse(fixture().post(body)), { ok: false, code: 'UNAUTHORIZED' });
  const inbox = fixture({ ACTIVITY_ENABLED: 'true' });
  assert.deepEqual(Array.from(inbox.activityRows[0]), ['Received UTC', 'Event', 'Session ID', 'EarthQL', 'Installation ID', 'Username', 'macOS Version', 'Model']);
  assert.deepEqual(JSON.parse(inbox.post(body)), { ok: true, id: draft.id });
  assert.deepEqual(Array.from(inbox.activityRows[1]), [fixtureTime, 'open', draft.id, '0.3.0', '', 'earthql-test', '', '']);
  assert.equal(inbox.rows.length, 1);
  const invalid = JSON.stringify({ activity: { ...activity, appVersion: '=IMPORTXML(...)' } });
  assert.deepEqual(JSON.parse(inbox.post(invalid)), { ok: false, code: 'INVALID' });
  inbox.properties.ACTIVITY_MINUTE = fixtureTime.slice(0, 16) + '|60';
  assert.deepEqual(JSON.parse(inbox.post(body)), { ok: false, code: 'RATE_LIMIT' });
  assert.deepEqual(JSON.parse(inbox.post(JSON.stringify({ key, report: draft }))), { ok: true, id: draft.id });
});

test('activity setup reports missing config and first activity creates a missing tab', () => {
  const inbox = fixture();
  assert.throws(inbox.setupActivity, /Set ACTIVITY_ENABLED/);
  assert.equal(inbox.activityRows.length, 0);
  inbox.properties.ACTIVITY_ENABLED = ' true ';
  const activity = { sessionId: draft.id, event: 'heartbeat', appVersion: '0.3.0' };
  assert.deepEqual(JSON.parse(inbox.post(JSON.stringify({ activity }))), { ok: true, id: draft.id });
  assert.equal(inbox.activityRows.length, 2);
  inbox.setupActivity();
  assert.equal(inbox.activityRows.length, 2);
});

test('activity upgrades the existing tab and accepts only UUID installation IDs', () => {
  const inbox = fixture({ ACTIVITY_ENABLED: 'true' });
  inbox.activityRows[0].length = 4;
  inbox.activityRows.push([fixtureTime, 'open', draft.id, '0.3.0']);
  const installationId = '8fc06a92-32ba-4bee-84a5-e2d856a037c0';
  const activity = { sessionId: draft.id, event: 'heartbeat', appVersion: '0.3.0', installationId, macosVersion: '26.1', model: 'Mac14,3' };
  assert.deepEqual(JSON.parse(inbox.post(JSON.stringify({ activity }))), { ok: true, id: draft.id });
  assert.equal(inbox.activityRows[0][4], 'Installation ID');
  assert.equal(inbox.activityRows[0][5], 'Username');
  assert.equal(inbox.activityRows[1].length, 4);
  assert.equal(inbox.activityRows[2][4], installationId);
  assert.deepEqual(Array.from(inbox.activityRows[2]).slice(6), ['26.1', 'Mac14,3']);
  activity.installationId = 'computer-username';
  assert.deepEqual(JSON.parse(inbox.post(JSON.stringify({ activity }))), { ok: false, code: 'INVALID' });
});
