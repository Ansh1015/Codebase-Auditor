import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CachingProvider } from "../../src/cache/cache.js";
import { MockProvider } from "../../src/llm/mock.js";
import type { CompleteRequest } from "../../src/llm/types.js";

const req = (over: Partial<CompleteRequest> = {}): CompleteRequest => ({
  system: "sys",
  user: "analyze X",
  tier: "deep",
  ...over,
});

describe("CachingProvider", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "auditor-cache-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves identical requests from cache without re-calling the inner provider", async () => {
    let calls = 0;
    const inner = new MockProvider(() => `response-${calls++}`);
    const cached = new CachingProvider(inner, dir);

    const a = await cached.complete(req());
    const b = await cached.complete(req());

    expect(a.text).toBe("response-0");
    expect(b.text).toBe("response-0"); // same cached value
    expect(inner.requests).toHaveLength(1); // inner hit only once
  });

  it("misses (re-calls) when inputs differ", async () => {
    const inner = new MockProvider((_r, i) => `response-${i}`);
    const cached = new CachingProvider(inner, dir);

    await cached.complete(req({ user: "first" }));
    await cached.complete(req({ user: "second" }));

    expect(inner.requests).toHaveLength(2);
  });

  it("survives across provider instances (persisted to disk)", async () => {
    const inner1 = new MockProvider(() => "persisted");
    await new CachingProvider(inner1, dir).complete(req());

    const inner2 = new MockProvider(() => "SHOULD-NOT-BE-CALLED");
    const result = await new CachingProvider(inner2, dir).complete(req());

    expect(result.text).toBe("persisted");
    expect(inner2.requests).toHaveLength(0);
  });
});
