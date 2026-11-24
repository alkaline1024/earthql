export const FEEDBACK_MAX_TITLE = 120;
export const FEEDBACK_MAX_DESCRIPTION = 4000;
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 1_500_000;

export type FeedbackKind = 'bug' | 'suggestion';

export interface FeedbackDraft {
  id: string;
  kind: FeedbackKind;
  title: string;
  description: string;
  screenshot?: string;
}

export interface FeedbackSettings {
  endpoint: string;
  hasKey: boolean;
  bundled: boolean;
}

export function feedbackEndpointUrl(input: string): string | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.origin !== 'https://script.google.com' || url.username || url.password || url.search || url.hash ||
      !/^\/(?:a\/macros\/[a-z0-9.-]+\/s|macros\/s)\/[\w-]+\/exec$/i.test(url.pathname)) return null;
  return url.href;
}
