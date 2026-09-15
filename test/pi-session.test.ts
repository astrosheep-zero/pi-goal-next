import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import goalExtension from "../src/index.ts";

// Exercise the real Pi 0.85 event dispatcher, session persistence, input queue,
// and sendMessage implementation. Only model inference is replaced; no network.
async function harness(t: any, reasons: string[], compaction: { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number } = { enabled: false }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-goal-timing-"));
  const settingsManager = SettingsManager.inMemory({ compaction, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json") });
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
  assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, "isolated-test-key");
  const beforePersist: boolean[] = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [goalExtension, (pi) => {
      pi.on("message_end", (event, ctx) => {
        if (event.message.role === "assistant") beforePersist.push(!ctx.sessionManager.getBranch().some((e: any) => e.message === event.message));
      });
    }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader, settingsManager, modelRuntime, model, tools: [], sessionManager: SessionManager.inMemory(dir) });
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (e) => errors.push(e) });
  let calls = 0;
  let beforeResponse: ((call: number, signal?: AbortSignal) => Promise<void>) | undefined;
  session.agent.streamFunction = async (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    let stopReason = reasons[calls++] ?? "aborted";
    await beforeResponse?.(calls, options?.signal);
    if (options?.signal?.aborted) stopReason = "aborted";
    const message: any = {
      role: "assistant", content: [{ type: "text", text: `response-${calls}` }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: calls * 10, output: calls, cacheRead: 0, cacheWrite: 0, totalTokens: calls * 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, timestamp: Date.now(),
    };
    stream.push(stopReason === "error" || stopReason === "aborted" ? { type: "error", reason: stopReason, error: message } : { type: "done", reason: stopReason as any, message });
    stream.end();
    return stream;
  };
  const settle = async () => {
    // sendMessage intentionally starts an independent run; drain its event work.
    for (let i = 0; i < 100; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (session.isIdle) return;
    }
    assert.fail("session failed to settle");
  };
  t.after(async () => { session.dispose(); await rm(dir, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const continuations = () => session.sessionManager.getBranch().filter((e: any) => e.type === "custom_message" && e.customType === "pi-goal-next/continuation");
  return { session, settle, continuations, beforePersist, calls: () => calls, beforeResponse: (handler: typeof beforeResponse) => { beforeResponse = handler; } };
}

for (const boundary of ["message_end", "agent_end"] as const) {
  test(`real Pi: abort at ${boundary} after normal output prevents restart`, { timeout: 5000 }, async (t) => {
    const h = await harness(t, ["stop"]);
    let stopping: Promise<void> | undefined;
    h.session.subscribe((event) => {
      if (event.type === boundary && !stopping && (event.type !== "message_end" || event.message.role === "assistant")) stopping = h.session.abort();
    });
    await h.session.prompt("/goal work");
    await h.settle();
    await stopping;
    assert.equal(h.calls(), 1);
    assert.equal(h.continuations().length, 1);
    assert.ok(h.session.isIdle);
  });
}

for (const action of ["abort", "steer"] as const) {
  test(`real Pi: ${action} during continuation does not attach another prompt`, { timeout: 5000 }, async (t) => {
    const h = await harness(t, ["stop", "stop", "aborted"]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.beforeResponse(async (call, signal) => {
      if (call !== 2) return;
      entered.resolve();
      if (action === "abort") {
        if (!signal?.aborted) await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      } else await release.promise;
    });
    await h.session.prompt("/goal work");
    await entered.promise;
    assert.equal(h.continuations().length, 2);
    if (action === "abort") await h.session.abort();
    else {
      await h.session.prompt("new direction", { source: "rpc", streamingBehavior: "steer" });
      assert.equal(h.continuations().length, 2);
      release.resolve();
    }
    await h.settle();
    assert.equal(h.continuations().length, 2);
    assert.equal(h.calls(), action === "abort" ? 2 : 3);
    assert.ok(h.session.isIdle);
  });
}

for (const reason of ["error", "aborted"]) {
  test(`real Pi: previous normal response cannot authorize continuation after ${reason}`, async (t) => {
    const h = await harness(t, ["stop", reason]);
    await h.session.prompt("/goal work");
    await h.settle();
    assert.equal(h.calls(), 2);
    assert.equal(h.continuations().length, 2); // explicit create + one normal completion
    assert.deepEqual(h.beforePersist, [true, true]);
    const usage = h.session.sessionManager.getBranch().filter((e: any) => e.type === "custom" && e.data.type === "goal.usage").map((e: any) => e.data);
    assert.equal(usage.length, 2);
    assert.equal(usage.reduce((n: number, e: any) => n + e.input, 0), 30);
  });
}

test("real Pi: new user input has no continuation attached; normal reply can continue once", async (t) => {
  const h = await harness(t, ["error", "stop", "aborted"]);
  await h.session.prompt("/goal work");
  await h.settle();
  assert.equal(h.continuations().length, 1);
  let atUserStart = -1;
  h.session.subscribe((e) => { if (e.type === "message_start" && e.message.role === "user") atUserStart = h.continuations().length; });
  await h.session.prompt("change direction", { source: "rpc" });
  await h.settle();
  assert.equal(atUserStart, 1);
  assert.equal(h.continuations().length, 2);
  assert.equal(h.calls(), 3);
});

test("real Pi: manual compaction uses Pi's default summary with a paused goal", async (t) => {
  const h = await harness(t, ["error", "error", "error"], { enabled: false, reserveTokens: 1, keepRecentTokens: 1 });
  await h.session.prompt("/goal Preserve the migration decision");
  await h.settle();
  await h.session.prompt("/goal pause");
  await h.settle();
  await h.session.prompt("Conversation detail: the migration keeps the old schema readable.");
  await h.settle();
  await h.session.prompt("Conversation detail: verify the rollback before release.");
  await h.settle();

  const session = h.session as any;
  const defaultCompaction = session._runDefaultCompaction;
  const calls: any[][] = [];
  session._runDefaultCompaction = async (...args: any[]) => {
    calls.push(args);
    const preparation = args[0];
    return {
      summary: "Conversation detail: migration rollback is verified. Goal is present and paused.",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    };
  };
  t.after(() => { session._runDefaultCompaction = defaultCompaction; });

  const result = await h.session.compact();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][7], "manual");
  assert.match(result.summary, /migration rollback is verified/);
  assert.match(result.summary, /Goal is present and paused/);
  assert.ok(calls[0][0].messagesToSummarize.some((message: any) => JSON.stringify(message).includes("old schema readable")));
  assert.ok(h.session.sessionManager.getBranch().some((entry: any) => entry.type === "custom" && entry.customType === "pi-goal-next" && entry.data.type === "goal.transition" && entry.data.to === "paused"));
});
