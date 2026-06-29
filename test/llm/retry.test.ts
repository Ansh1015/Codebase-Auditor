import { describe, expect, it, vi } from "vitest";
import {
  isNetworkError,
  isTransientLlmError,
  retryAfterMsFromError,
  withRetry,
} from "../../src/llm/retry.js";

const noSleep = () => Promise.resolve();

describe("withRetry", () => {
  it("retries a transient failure and then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("boom"), { status: 503 });
        return "ok";
      },
      { isRetryable: isTransientLlmError, sleep: noSleep, random: () => 0.5 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw err;
        },
        { maxAttempts: 3, isRetryable: isTransientLlmError, sleep: noSleep, random: () => 0 },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(3);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    const err = Object.assign(new Error("bad request"), { status: 400 });
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw err;
        },
        { isRetryable: isTransientLlmError, sleep: noSleep },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it("honours an explicit Retry-After over computed backoff", async () => {
    const sleep = vi.fn(noSleep);
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("slow down"), { status: 429 });
        return "ok";
      },
      {
        isRetryable: isTransientLlmError,
        retryAfterMs: () => 1234,
        sleep,
        random: () => 1, // would otherwise dominate; explicit wait must win
      },
    );
    expect(sleep).toHaveBeenCalledWith(1234);
  });
});

describe("error classification", () => {
  it("treats 429/5xx as transient and 4xx (non-429) as not", () => {
    expect(isTransientLlmError({ status: 429 })).toBe(true);
    expect(isTransientLlmError({ status: 503 })).toBe(true);
    expect(isTransientLlmError({ status: 500 })).toBe(true);
    expect(isTransientLlmError({ status: 400 })).toBe(false);
    expect(isTransientLlmError({ status: 401 })).toBe(false);
    expect(isTransientLlmError({ status: 404 })).toBe(false);
  });

  it("treats network-level errors as transient", () => {
    expect(isNetworkError({ code: "ECONNRESET" })).toBe(true);
    expect(isNetworkError({ cause: { code: "ETIMEDOUT" } })).toBe(true);
    expect(isTransientLlmError({ code: "EAI_AGAIN" })).toBe(true);
    expect(isNetworkError({ code: "NOPE" })).toBe(false);
  });
});

describe("retryAfterMsFromError", () => {
  it("parses delta-seconds from a plain header record", () => {
    expect(retryAfterMsFromError({ headers: { "retry-after": "2" } })).toBe(2000);
  });

  it("parses from a Headers-like object with get()", () => {
    const headers = { get: (k: string) => (k === "retry-after" ? "5" : null) };
    expect(retryAfterMsFromError({ headers })).toBe(5000);
  });

  it("returns undefined when the header is absent", () => {
    expect(retryAfterMsFromError({ headers: {} })).toBeUndefined();
    expect(retryAfterMsFromError({})).toBeUndefined();
  });
});
