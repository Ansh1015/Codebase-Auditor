/**
 * Transient-failure retry with exponential backoff + full jitter.
 *
 * Every audit makes dozens of provider calls; a single 429, 5xx, or network
 * blip must not abort the whole run. The content-addressed cache makes already-
 * completed calls free on resume, but an in-flight call needs to survive a
 * transient failure here. The helper is pure and its `sleep`/`random` are
 * injectable, so backoff is unit-tested without real time or flakiness.
 */

export interface RetryInfo {
  /** 1-based index of the attempt that just failed. */
  readonly attempt: number;
  readonly delayMs: number;
  readonly err: unknown;
}

export interface RetryOptions {
  /** Total attempts including the first. Default 4. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Decides whether a thrown error is worth retrying. */
  readonly isRetryable: (err: unknown) => boolean;
  /** Server-advised wait (e.g. from a Retry-After header), in ms, if any. */
  readonly retryAfterMs?: (err: unknown) => number | undefined;
  readonly onRetry?: (info: RetryInfo) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Hard ceiling on an honoured Retry-After, so a hostile header can't hang us. */
const RETRY_AFTER_CEILING_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !opts.isRetryable(err)) throw err;
      const explicit = opts.retryAfterMs?.(err);
      const backoff = Math.min(cap, base * 2 ** (attempt - 1));
      const delayMs = Math.ceil(
        explicit !== undefined
          ? Math.min(Math.max(explicit, 0), RETRY_AFTER_CEILING_MS)
          : backoff * random(), // full jitter
      );
      opts.onRetry?.({ attempt, delayMs, err });
      await sleep(delayMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Error classification — shared by the api (SDK) and subscription (CLI) backends.
// ---------------------------------------------------------------------------

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENETUNREACH",
  "EPIPE",
]);

function asRecord(err: unknown): Record<string, unknown> | undefined {
  return typeof err === "object" && err !== null ? (err as Record<string, unknown>) : undefined;
}

export function httpStatusOf(err: unknown): number | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  if (typeof e.status === "number") return e.status;
  const response = asRecord(e.response);
  if (response && typeof response.status === "number") return response.status;
  return undefined;
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function errorCodeOf(err: unknown): string | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  if (typeof e.code === "string") return e.code;
  const cause = asRecord(e.cause);
  if (cause && typeof cause.code === "string") return cause.code;
  return undefined;
}

export function isNetworkError(err: unknown): boolean {
  const code = errorCodeOf(err);
  return code !== undefined && NETWORK_CODES.has(code);
}

/** Transient = retryable HTTP status (429/5xx/408/409) or a network-level error. */
export function isTransientLlmError(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status !== undefined) return isRetryableHttpStatus(status);
  return isNetworkError(err);
}

function headerGet(headers: unknown, name: string): string | undefined {
  if (headers == null) return undefined;
  const h = headers as { get?: (k: string) => string | null | undefined };
  if (typeof h.get === "function") {
    const v = h.get(name);
    return v == null ? undefined : v;
  }
  const rec = asRecord(headers);
  if (!rec) return undefined;
  const v = rec[name] ?? rec[name.toLowerCase()];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) from an SDK error. */
export function retryAfterMsFromError(err: unknown): number | undefined {
  const e = asRecord(err);
  const raw = headerGet(e?.headers, "retry-after");
  if (raw === undefined) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
