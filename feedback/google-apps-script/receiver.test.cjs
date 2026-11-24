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
  const files = new Map();
  const state = { busy: false, failAppend: false, appendOptions: null };
  const properties = { FEEDBACK_KEY: key, FEEDBACK_SHEET_ID: 'sheet', FEEDBACK_FOLDER_ID: 'folder', ...overrides };
  const opened = { sheets: [], folders: [] };
  const sheet = {
    getLastRow: () => rows.length,
    setFrozenRows: () => {},
    getRange: (start) => ({
      getValues: () => [rows[0]],
      setValues: ([row]) => rows.push(row),
      createTextFinder: (id) => ({
        matchEntireCell: () => ({ findNext: () => rows.slice(start - 1).find(row => row[0] === id) }),
      }),
    }),
  };
  const context = vm.createContext({
    Date: class extends Date { constructor() { super(fixtureTime); } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (name) => properties[name],
      setProperties: (values) => Object.assign(properties, values),
    }) },
    SpreadsheetApp: { openById: (id) => {
      opened.sheets.push(id);
      return { getSheetByName: () => sheet };
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
      rows.push(row);
    } } } },
    LockService: { getScriptLock: () => ({ tryLock: () => !state.busy, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (body) => ({ setMimeType: () => body }) },
  });
  vm.runInContext(script, context);
  context.setupFeedback();

  return {
    rows, files, state, properties, opened,
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
