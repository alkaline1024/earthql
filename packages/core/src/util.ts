import type { TestStep } from './types';

export async function timedStep<T>(steps: TestStep[], name: string, fn: () => Promise<T>, detail?: (v: T) => string): Promise<T> {
  const started = Date.now();
  try {
    const v = await fn();
    steps.push({ name, ok: true, detail: detail?.(v), durationMs: Date.now() - started });
    return v;
  } catch (e) {
    steps.push({ name, ok: false, durationMs: Date.now() - started });
    throw e;
  }
}

/** Run `fn` with a timeout; rejects with an Error whose code is ETIMEDOUT. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`), { code: 'ETIMEDOUT' })), ms);
    }),
  ]);
}

/** Section status helper for permission errors while reading metadata. */
export function deniedMessage(e: unknown): string {
  return String((e as any)?.message ?? e);
}

export const MAX_COMPLETION_COLUMNS = 20000;
