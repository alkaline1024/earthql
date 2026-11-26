const TAB = 'Feedback';
const ACTIVITY_TAB = 'Activity Log';
const ACTIVITY_HEADERS = ['Received UTC', 'Event', 'Session ID', 'EarthQL', 'Installation ID', 'Username', 'macOS Version', 'Model'];
const HEADERS = ['ID', 'Received UTC', 'Type', 'Title', 'Description', 'Screenshot', 'EarthQL', 'macOS', 'Status'];
const MAX_IMAGE_BYTES = 1500000;
const MAX_BODY_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 30000;
const KEY = /^[a-f0-9]{64}$/i;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const JPEG = /^[A-Za-z0-9+/]+={0,2}$/;
const FOLDER_LINK = /^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)(?:[/?#].*)?$/i;
const SHEET_LINK = /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)(?:[/?#].*)?$/i;
const PUBLIC_PER_MINUTE = 10;
const PUBLIC_PER_DAY = 100;

// Run once from the Apps Script editor to authorize access and create the tab.
function setupFeedback() {
  const config = PropertiesService.getScriptProperties();
  if (!allowPublicSubmissions(config) && !KEY.test(config.getProperty('FEEDBACK_KEY') || '')) {
    throw new Error('Set a 64-character FEEDBACK_KEY or explicitly enable public submissions.');
  }
  if (typeof Sheets === 'undefined') throw new Error('Add the Google Sheets API advanced service under Services.');
  const folderId = googleResourceId(config.getProperty('FEEDBACK_FOLDER_ID'), FOLDER_LINK);
  if (!folderId) throw new Error('Set FEEDBACK_FOLDER_ID to the ID or URL of a Drive folder (the link contains /folders/).');
  const bookId = googleResourceId(config.getProperty('FEEDBACK_SHEET_ID'), SHEET_LINK);
  if (!bookId) throw new Error('Set FEEDBACK_SHEET_ID to the ID or URL of a Google Sheet (the link contains /spreadsheets/d/).');

  try { DriveApp.getFolderById(folderId).getName(); }
  catch (_) { throw new Error('Cannot open the Drive folder in FEEDBACK_FOLDER_ID. Check the folder link and the deploying account’s access.'); }

  let book;
  try { book = SpreadsheetApp.openById(bookId); }
  catch (_) { throw new Error('Cannot open the Google Sheet in FEEDBACK_SHEET_ID. Check the spreadsheet link and the deploying account’s access.'); }
  const sheet = book.getSheetByName(TAB) || book.insertSheet(TAB);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  requireFeedbackTab(book);
  if (activityEnabled(config)) ensureActivityTab(book);
}

// Run from the Apps Script editor to check activity configuration and create its tab.
function setupActivity() {
  const config = PropertiesService.getScriptProperties();
  if (!activityEnabled(config)) {
    throw new Error('Set ACTIVITY_ENABLED to true in Project Settings → Script properties.');
  }
  if (typeof Sheets === 'undefined') throw new Error('Add the Google Sheets API advanced service under Services.');
  const bookId = googleResourceId(config.getProperty('FEEDBACK_SHEET_ID'), SHEET_LINK);
  if (!bookId) throw new Error('Set FEEDBACK_SHEET_ID to the ID or URL of the target spreadsheet.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another request is updating the spreadsheet. Run setupActivity again.');
  try {
    const book = SpreadsheetApp.openById(bookId);
    ensureActivityTab(book);
    console.log('Activity Log is ready in ' + book.getUrl());
  } finally {
    lock.releaseLock();
  }
}

function activityEnabled(config) {
  return (config.getProperty('ACTIVITY_ENABLED') || '').trim().toLowerCase() === 'true';
}

function ensureActivityTab(book) {
  const sheet = book.getSheetByName(ACTIVITY_TAB) || book.insertSheet(ACTIVITY_TAB);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, ACTIVITY_HEADERS.length).setValues([ACTIVITY_HEADERS]);
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
    return;
  }
  // Add headers for new fields without changing earlier rows.
  const extraHeaders = ACTIVITY_HEADERS.slice(4);
  const range = sheet.getRange(1, 5, 1, extraHeaders.length);
  const headers = range.getValues()[0];
  if (headers.includes('')) {
    headers.forEach((header, index) => {
      if (!header) sheet.getRange(1, 5 + index).setValue(extraHeaders[index]);
    });
    SpreadsheetApp.flush();
  }
}

function doPost(event) {
  const body = event && event.postData && event.postData.contents;
  if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH) return feedbackResponse(false, 'INVALID');
  let input;
  try { input = JSON.parse(body); } catch (_) { return feedbackResponse(false, 'INVALID'); }
  if (!input || typeof input !== 'object') return feedbackResponse(false, 'INVALID');

  const config = PropertiesService.getScriptProperties();
  if (input.activity !== undefined) return recordActivity(input.activity, body.length, config);
  const publicEnabled = allowPublicSubmissions(config);
  const publicSubmission = publicEnabled && input.key === undefined;
  if (!publicSubmission) {
    const expectedKey = config.getProperty('FEEDBACK_KEY') || '';
    if (!publicEnabled && !KEY.test(expectedKey)) return feedbackResponse(false, 'SETUP');
    if (!KEY.test(expectedKey) || !keysMatch(input.key, expectedKey)) return feedbackResponse(false, 'UNAUTHORIZED');
  }

  const report = input.report;
  if (!validReport(report)) return feedbackResponse(false, 'INVALID');
  const screenshot = decodeScreenshot(report.screenshot);
  if (screenshot === false) return feedbackResponse(false, 'INVALID');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return feedbackResponse(false, 'BUSY');
  try {
    const bookId = googleResourceId(config.getProperty('FEEDBACK_SHEET_ID'), SHEET_LINK);
    const folderId = googleResourceId(config.getProperty('FEEDBACK_FOLDER_ID'), FOLDER_LINK);
    if (!bookId || !folderId || typeof Sheets === 'undefined') return feedbackResponse(false, 'SETUP');
    const sheet = requireFeedbackTab(SpreadsheetApp.openById(bookId));
    const lastRow = sheet.getLastRow();
    if (lastRow > 1 && sheet.getRange(2, 1, lastRow - 1, 1).createTextFinder(report.id).matchEntireCell(true).findNext()) {
      return feedbackResponse(true, report.id);
    }
    if (publicSubmission && !reservePublicSubmission(config, new Date().toISOString())) {
      return feedbackResponse(false, 'RATE_LIMIT');
    }

    let screenshotUrl = '';
    if (screenshot) {
      const folder = DriveApp.getFolderById(folderId);
      const fingerprint = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, screenshot)).replace(/=+$/, '');
      const fileName = report.id + '-' + fingerprint + '.jpg';
      // Reuse an upload if the prior attempt stopped before the row was written.
      const existing = folder.getFilesByName(fileName);
      const file = existing.hasNext() ? existing.next() : folder.createFile(Utilities.newBlob(screenshot, 'image/jpeg', fileName));
      screenshotUrl = file.getUrl();
    }
    const row = [
      report.id, new Date().toISOString(), report.kind === 'bug' ? 'Bug' : 'Suggestion',
      report.title.trim(), report.description.trim(), screenshotUrl, report.appVersion, report.osVersion, 'New',
    ];
    // RAW keeps submitted text literal, including text beginning with '='.
    Sheets.Spreadsheets.Values.append({ values: [row] }, bookId, TAB + '!A:I', {
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    });
    return feedbackResponse(true, report.id);
  } catch (_) {
    return feedbackResponse(false, 'STORAGE');
  } finally {
    lock.releaseLock();
  }
}

function recordActivity(activity, length, config) {
  if (!activityEnabled(config)) return feedbackResponse(false, 'UNAUTHORIZED');
  if (length > 1024 || !activity || typeof activity.sessionId !== 'string' || !ID.test(activity.sessionId) ||
      (activity.installationId !== undefined && (typeof activity.installationId !== 'string' || !ID.test(activity.installationId))) ||
      (activity.username !== undefined && (typeof activity.username !== 'string' || activity.username.length > 256 || !activity.username.trim())) ||
      (activity.macosVersion !== undefined && (typeof activity.macosVersion !== 'string' || !/^\d{1,4}(?:\.\d{1,4}){0,2}$/.test(activity.macosVersion))) ||
      (activity.model !== undefined && (typeof activity.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9,._ -]{0,63}$/.test(activity.model))) ||
      (activity.event !== 'open' && activity.event !== 'heartbeat') ||
      typeof activity.appVersion !== 'string' || !/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(activity.appVersion)) {
    return feedbackResponse(false, 'INVALID');
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return feedbackResponse(false, 'BUSY');
  try {
    const bookId = googleResourceId(config.getProperty('FEEDBACK_SHEET_ID'), SHEET_LINK);
    if (!bookId || typeof Sheets === 'undefined') return feedbackResponse(false, 'SETUP');
    const time = new Date().toISOString();
    if (!reservePublicSubmission(config, time, 'ACTIVITY', 60, 5000)) return feedbackResponse(false, 'RATE_LIMIT');
    ensureActivityTab(SpreadsheetApp.openById(bookId));
    Sheets.Spreadsheets.Values.append({
      values: [[time, activity.event, activity.sessionId, activity.appVersion, activity.installationId ?? '', activity.username ?? '', activity.macosVersion ?? '', activity.model ?? '']],
    }, bookId, "'" + ACTIVITY_TAB + "'!A:H", {
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    });
    return feedbackResponse(true, activity.sessionId);
  } catch (_) {
    return feedbackResponse(false, 'STORAGE');
  } finally {
    lock.releaseLock();
  }
}

function googleResourceId(value, pattern) {
  const text = (value || '').trim();
  if (/^[\w-]+$/.test(text)) return text;
  const match = text.match(pattern);
  return match ? match[1] : '';
}

function allowPublicSubmissions(config) {
  return config.getProperty('FEEDBACK_PUBLIC_SUBMISSIONS') === 'true';
}

// Called with the script lock held. Reserve before touching Drive or attempting a Sheet write.
function reservePublicSubmission(config, isoDate, prefix = 'FEEDBACK_PUBLIC', perMinute = PUBLIC_PER_MINUTE, perDay = PUBLIC_PER_DAY) {
  const countFor = (property, window) => {
    const [name, count] = (config.getProperty(property) || '').split('|');
    return name === window ? Number(count) || 0 : 0;
  };
  const minute = isoDate.slice(0, 16);
  const day = isoDate.slice(0, 10);
  const minuteKey = prefix + '_MINUTE';
  const dayKey = prefix + '_DAY';
  const minuteCount = countFor(minuteKey, minute);
  const dayCount = countFor(dayKey, day);
  if (minuteCount >= perMinute || dayCount >= perDay) return false;
  config.setProperties({
    [minuteKey]: minute + '|' + (minuteCount + 1),
    [dayKey]: day + '|' + (dayCount + 1),
  });
  return true;
}

function requireFeedbackTab(book) {
  const sheet = book.getSheetByName(TAB);
  const header = sheet && sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (!header || !HEADERS.every((label, i) => label === header[i])) {
    throw new Error('Run setupFeedback and keep the Feedback tab headers in their original order.');
  }
  return sheet;
}

function keysMatch(provided, expected) {
  if (typeof provided !== 'string' || !KEY.test(provided)) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function validReport(report) {
  const text = (value, max) => typeof value === 'string' && value.length <= max && value.trim().length > 0;
  return report && typeof report.id === 'string' && ID.test(report.id) &&
    (report.kind === 'bug' || report.kind === 'suggestion') && text(report.title, 120) && text(report.description, 4000) &&
    text(report.appVersion, 64) && text(report.osVersion, 64);
}

function decodeScreenshot(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.length % 4 !== 0 || !JPEG.test(value)) return false;
  try {
    const bytes = Utilities.base64Decode(value);
    return bytes.length >= 5 && bytes.length <= MAX_IMAGE_BYTES &&
      (bytes[0] & 255) === 255 && (bytes[1] & 255) === 216 && (bytes[2] & 255) === 255 &&
      (bytes[bytes.length - 2] & 255) === 255 && (bytes[bytes.length - 1] & 255) === 217 ? bytes : false;
  } catch (_) { return false; }
}

function feedbackResponse(ok, value) {
  return ContentService.createTextOutput(JSON.stringify(ok ? { ok: true, id: value } : { ok: false, code: value }))
    .setMimeType(ContentService.MimeType.JSON);
}
