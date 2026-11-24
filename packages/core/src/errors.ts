import type { DriverId, ErrorCategory, ErrorInfo } from './types';

export class EarthQLError extends Error {
  readonly category: ErrorCategory;
  readonly code?: string;
  readonly hint?: string;
  readonly driver?: DriverId;

  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = 'EarthQLError';
    this.category = info.category;
    this.code = info.code;
    this.hint = info.hint;
    this.driver = info.driver;
  }

  toInfo(): ErrorInfo {
    return { category: this.category, message: this.message, code: this.code, hint: this.hint, driver: this.driver };
  }
}

export function isEarthQLError(e: unknown): e is EarthQLError {
  return e instanceof EarthQLError;
}

export const CATEGORY_HINTS: Partial<Record<ErrorCategory, string>> = {
  network: 'Check the host, port, VPN and firewall. The server could not be reached or the connection dropped.',
  tls: 'Check the TLS mode and certificate settings for this profile.',
  auth: 'The server rejected the credentials. Check the username and password / token in the profile.',
  permission: 'The account is signed in but is not allowed to do this. Ask an administrator for the needed privilege.',
  not_found: 'The database or object does not exist, or this account cannot see it.',
  syntax: 'The SQL could not be parsed by the server.',
  cancelled: 'The database confirmed the statement was cancelled.',
  timeout: 'The operation took too long. Try again or check the network.',
  outcome_unknown:
    'The connection was lost after the statement was sent. The database may or may not have applied it — check the data before running it again.',
};

/**
 * Replace every occurrence of the given secrets in a string.
 * Secrets shorter than 4 characters are still redacted (we never want to leak them),
 * but we skip empty strings.
 */
export function redact(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join('••••••');
    // Also catch URL-encoded variants (connection strings in error messages).
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join('••••••');
  }
  // Generic token shapes that may come back from HTTP layers.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1••••••');
  out = out.replace(/\bdapi[a-f0-9]{20,}\b/gi, 'dapi••••••');
  out = out.replace(/(client_secret=)[^&\s]+/gi, '$1••••••');
  out = out.replace(/(password=)[^;&\s]+/gi, '$1••••••');
  return out;
}

export function redactInfo(info: ErrorInfo, secrets: Array<string | undefined | null>): ErrorInfo {
  return { ...info, message: redact(info.message, secrets), hint: info.hint ? redact(info.hint, secrets) : info.hint };
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'PROTOCOL_CONNECTION_LOST',
  'ESOCKET',
  'ECONNCLOSED',
]);

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'HPE_INVALID_CONSTANT',
]);

/** Classify generic Node.js socket / TLS errors. Returns undefined when not recognised. */
export function classifyNodeError(e: any): ErrorCategory | undefined {
  const code: string | undefined = e?.code ?? e?.cause?.code ?? e?.originalError?.code;
  const msg = String(e?.message ?? '');
  if (code && TLS_CODES.has(code)) return 'tls';
  if (/certificate|self[- ]signed|SSL|TLS|handshake/i.test(msg) && !/password/i.test(msg)) return 'tls';
  if (code && NETWORK_CODES.has(code)) return 'network';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|socket hang up|Connection terminated|connection lost|getaddrinfo/i.test(msg))
    return 'network';
  return undefined;
}

export function toErrorInfo(e: unknown, driver?: DriverId): ErrorInfo {
  if (isEarthQLError(e)) return e.toInfo();
  const anyE = e as any;
  const category = classifyNodeError(anyE) ?? 'unknown';
  return {
    category,
    message: String(anyE?.message ?? e ?? 'Unknown error'),
    code: anyE?.code ? String(anyE.code) : undefined,
    hint: CATEGORY_HINTS[category],
    driver,
  };
}

export function makeError(category: ErrorCategory, message: string, extra: Partial<ErrorInfo> = {}): EarthQLError {
  return new EarthQLError({ category, message, hint: CATEGORY_HINTS[category], ...extra });
}
