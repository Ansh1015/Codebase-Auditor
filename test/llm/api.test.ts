import { describe, expect, it, vi } from "vitest";
import { ApiProvider, type MessagesClient } from "../../src/llm/api.js";
import { BudgetTracker } from "../../src/llm/budget.js";
import { MODEL_IDS } from "../../src/llm/models.js";
import type { CompleteRequest } from "../../src/llm/types.js";

const req = (over: Partial<CompleteRequest> = {}): CompleteRequest => ({
  system: "you are an auditor",
  user: "analyze this",
  tier: "deep",
  ...over,
});

interface FakeMessage {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Build a client whose create() returns the given message and records args. */
function fakeClient(message: FakeMessage) {
  const create = vi.fn(async (_args: Record<string, unknown>) => message);
  const client = { messages: { create } } as unknown as MessagesClient;
  return { client, create };
}

const okMessage: FakeMessage = {
  content: [
    { type: "text", text: "hello " },
    { type: "thinking" },
    { type: "text", text: "world" },
  ],
  usage: { input_tokens: 100, output_tokens: 40 },
};

describe("ApiProvider", () => {
  it("resolves the tier model, concatenates text blocks, and records budget", async () => {
    const { client, create } = fakeClient(okMessage);
    const tracker = new BudgetTracker();
    const provider = new ApiProvider(tracker, { apiKey: "test", client });

    const res = await provider.complete(req({ tier: "synthesis" }));

    expect(res.text).toBe("hello world");
    expect(res.modelUsed).toBe(MODEL_IDS.opus); // synthesis → opus on api
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
    expect(res.costUsd).toBeGreaterThan(0);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: MODEL_IDS.opus });

    const summary = tracker.summary();
    expect(summary.calls).toBe(1);
    expect(summary.totalTokens).toBe(140);
  });

  it("retries a 429 then succeeds", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(okMessage);
    const client = { messages: { create } } as unknown as MessagesClient;
    const provider = new ApiProvider(new BudgetTracker(), { apiKey: "test", client });

    const res = await provider.complete(req());
    expect(res.text).toBe("hello world");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400 and surfaces the error", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("bad request"), { status: 400 }));
    const client = { messages: { create } } as unknown as MessagesClient;
    const provider = new ApiProvider(new BudgetTracker(), { apiKey: "test", client });

    await expect(provider.complete(req())).rejects.toThrow("bad request");
    expect(create).toHaveBeenCalledOnce();
  });
});
