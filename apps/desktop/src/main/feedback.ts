import { app, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import {
  FEEDBACK_MAX_DESCRIPTION, FEEDBACK_MAX_SCREENSHOT_BYTES, FEEDBACK_MAX_TITLE, feedbackEndpointUrl,
  type FeedbackDraft, type FeedbackSettings,
} from '../shared/feedback';
import { loadFeedbackEndpoint, writeFeedbackEndpoint } from './store';

declare const __EARTHQL_FEEDBACK_URL__: string;
const bundledEndpoint = __EARTHQL_FEEDBACK_URL__;

const KEY_PATTERN = /^[a-f0-9]{64}$/i;
const ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const JPEG_PREFIX = 'data:image/jpeg;base64,';

function endpointUrl(input: string): string {
  const endpoint = feedbackEndpointUrl(input);
  if (!endpoint) throw new Error('Enter the deployed Google Apps Script Web App URL ending in /exec.');
  return endpoint;
}

function keyEntry(endpoint: string): Entry {
  return new Entry('EarthQL', `feedback:${createHash('sha256').update(endpoint).digest('hex')}`);
}

function readKey(endpoint: string): string | null {
  try { return keyEntry(endpoint).getPassword(); } catch { return null; }
}

export function feedbackSettings(): FeedbackSettings {
  if (bundledEndpoint) return { endpoint: bundledEndpoint, bundled: true, hasKey: false };
  const endpoint = loadFeedbackEndpoint();
  const key = endpoint ? readKey(endpoint) : null;
  return { endpoint, bundled: false, hasKey: !!key && KEY_PATTERN.test(key) };
}

export function saveFeedbackSettings(url: string, key: string): FeedbackSettings {
  if (bundledEndpoint) throw new Error('This build uses a built-in feedback inbox.');
  const endpoint = endpointUrl(url);
  const previous = loadFeedbackEndpoint();
  const candidate = key.trim();
  if (candidate) {
    if (!KEY_PATTERN.test(candidate)) throw new Error('Use the 64-character feedback key from your Apps Script setup.');
    keyEntry(endpoint).setPassword(candidate);
  } else if (previous !== endpoint || !feedbackSettings().hasKey) {
    throw new Error('Enter a feedback key for this deployment.');
  }
  writeFeedbackEndpoint(endpoint);
  return { endpoint, bundled: false, hasKey: true };
}

export async function captureFeedbackScreenshot(contents: WebContents): Promise<string> {
  let image = await contents.capturePage();
  const { width, height } = image.getSize();
  const ratio = Math.min(1, 1600 / Math.max(width, height));
  if (image.isEmpty()) throw new Error('The app window could not be captured.');
  if (ratio < 1) image = image.resize({ width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) });
  return JPEG_PREFIX + image.toJPEG(85).toString('base64');
}

function screenshotBytes(screenshot: string | undefined): string | undefined {
  if (screenshot === undefined) return undefined;
  if (typeof screenshot !== 'string' || !screenshot.startsWith(JPEG_PREFIX) ||
      screenshot.length > JPEG_PREFIX.length + Math.ceil(FEEDBACK_MAX_SCREENSHOT_BYTES / 3) * 4) {
    throw new Error('The screenshot must be a JPEG under 1.5 MB. Crop it or send the feedback without it.');
  }
  const data = screenshot.slice(JPEG_PREFIX.length);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length < 5 || bytes.length > FEEDBACK_MAX_SCREENSHOT_BYTES || bytes.toString('base64') !== data ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error('The screenshot could not be read. Remove it and send the feedback again.');
  }
  return data;
}

const errorMessages: Record<string, string> = {
  UNAUTHORIZED: 'The feedback key was rejected. Check the submission key in Feedback Settings.',
  INVALID: 'The report could not be accepted. Check the title, description and screenshot size.',
  BUSY: 'The feedback inbox is busy. Try sending again in a moment.',
  RATE_LIMIT: 'The feedback inbox has reached its submission limit. Please try again later.',
  SETUP: 'The feedback inbox has not been configured. Check the Apps Script properties and setup.',
  STORAGE: 'Google Sheets or Drive could not save the report. Check the deployment setup or try again.',
};

export async function submitFeedback(draft: FeedbackDraft): Promise<{ id: string }> {
  if (!draft || typeof draft.id !== 'string' || !ID_PATTERN.test(draft.id) || (draft.kind !== 'bug' && draft.kind !== 'suggestion') ||
      typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > FEEDBACK_MAX_TITLE ||
      typeof draft.description !== 'string' || !draft.description.trim() || draft.description.length > FEEDBACK_MAX_DESCRIPTION) {
    throw new Error('Select a feedback type and enter a title and description.');
  }
  const { endpoint, hasKey, bundled } = feedbackSettings();
  const key = !bundled && hasKey ? readKey(endpoint) : null;
  if (!bundled && !key) throw new Error('Configure the URL and submission key in Feedback Settings first.');
  const url = endpointUrl(endpoint);
  const body = JSON.stringify({
    key: key ?? undefined,
    report: {
      id: draft.id, kind: draft.kind, title: draft.title.trim(), description: draft.description.trim(),
      screenshot: screenshotBytes(draft.screenshot), appVersion: app.getVersion(), osVersion: process.getSystemVersion(),
    },
  });

  let response: Response;
  const signal = AbortSignal.timeout(20_000);
  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'manual', signal });
    // Apps Script serves ContentService responses via a separate one-time URL. Fetch it without the key or report.
    if (response.status === 302 || response.status === 303) {
      const location = new URL(response.headers.get('location') ?? '', url);
      if (location.origin !== 'https://script.googleusercontent.com' || location.username || location.password) {
        throw new Error('Unexpected Apps Script redirect');
      }
      response = await fetch(location, { redirect: 'error', signal });
    }
  } catch {
    throw new Error('EarthQL could not confirm delivery. Check the network and /exec URL, then try again.');
  }

  const result = await response.json().catch(() => null) as { ok?: unknown; id?: unknown; code?: unknown } | null;
  if (!response.ok || !result) throw new Error('The feedback endpoint did not return a usable response. Check the Web App deployment.');
  if (result.ok === true && result.id === draft.id) return { id: draft.id };
  if (bundled && result.code === 'UNAUTHORIZED') throw new Error('This feedback inbox is not accepting public submissions.');
  const message = typeof result.code === 'string' && Object.hasOwn(errorMessages, result.code) ? errorMessages[result.code] : undefined;
  throw new Error(message ?? 'EarthQL could not confirm the report. Try sending again.');
}
