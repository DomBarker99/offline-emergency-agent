// Chat: the shared agent answers, offline goes to the local model, and a failing online model falls back
// to the local one. The model servers are replaced by a fake fetch that answers like Chat Completions.
import test from "node:test";
import assert from "node:assert/strict";
import { answerChat, ChatRequest } from "../src/chat.ts";

/** Installs a fake model server; `online` decides whether calls to OpenRouter succeed. */
function fakeModels(online: boolean) {
  const calls: { url: string; messages: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const href = String(url instanceof Request ? url.url : url);
    const body = JSON.parse(String(options?.body ?? (await (url as Request).text())));
    calls.push({ url: href, messages: JSON.stringify(body.messages) });
    if (href.includes("openrouter") && !online) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({
      id: "t", object: "chat.completion", created: 0, model: "test",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Test reply [C1]." } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("offline questions go to the local model, with the shared agent's rules", async () => {
  assert.equal(ChatRequest.safeParse({ text: "", mode: "local", context: null, history: [] }).success, false);
  const fake = fakeModels(true);
  try {
    const result = await answerChat({ text: "Explain flood protection", mode: "local", context: null, history: [] });
    assert.match(fake.calls[0].url, /127.0.0.1:8080/);
    assert.match(fake.calls[0].messages, /calm emergency companion/);
    assert.match(fake.calls[0].messages, /not a medical provider/); // the medical limit is in the system rules
    assert.doesNotMatch(fake.calls[0].messages, /handling facts only/); // no medical reminder on a non-health question
    assert.match(fake.calls[0].messages, /Mention calling 911 at most once/);
    await answerChat({ text: "Maria's insulin got warm. What now?", mode: "local", context: null, history: [] });
    assert.match(fake.calls[1].messages, /handling facts only/); // health question: the reminder is right before it
    assert.match(fake.calls[0].messages, /offline right now/);
    assert.equal(result.provider, "local");
    assert.equal(result.fallback, false);
    assert.equal(result.answer, "Test reply."); // citation tags are not shown
  } finally {
    fake.restore();
  }
});

test("the server's offline view wins over the page's", async () => {
  const fake = fakeModels(true);
  process.env.AGENT_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY ||= "test-key";
  try {
    const result = await answerChat({ text: "What now?", mode: "connected", context: null, history: [] }, false);
    assert.equal(result.provider, "local");
    assert.ok(fake.calls.every((c) => !c.url.includes("openrouter")));
  } finally {
    fake.restore();
  }
});

test("when the online model fails, the question is answered locally", async () => {
  const fake = fakeModels(false);
  process.env.AGENT_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY ||= "test-key";
  try {
    const result = await answerChat({ text: "Water is rising. What do I do?", mode: "connected", context: null, history: [] }, true);
    assert.equal(result.provider, "local");
    assert.equal(result.fallback, true);
    assert.ok(fake.calls.some((c) => c.url.includes("openrouter")));
    assert.match(fake.calls.at(-1)!.url, /127.0.0.1:8080/);
  } finally {
    fake.restore();
  }
});
