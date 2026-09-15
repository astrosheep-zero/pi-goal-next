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
async function harness(t: any, reasons: string[], toolComplete = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-goal-timing-"));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
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
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader, settingsManager, modelRuntime, model, tools: ["update_goal"], sessionManager: SessionManager.inMemory(dir) });
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
      role: "assistant", content: toolComplete && calls === 1 ? [{ type: "toolCall", id: "finish-goal", name: "update_goal", arguments: { status: "complete" } }] : [{ type: "text", text: `response-${calls}` }], api: model.api, provider: model.provider, model: model.id,
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

test("real Pi: budget crossing before completion tool permits completion and excludes later unrelated input", async (t) => {
  const h = await harness(t, ["toolUse", "stop", "stop"], true);
  await h.session.prompt("/goal --tokens 10 finish the task");
  await h.settle();
  assert.equal(h.calls(), 1); // update_goal terminates the actual Pi tool loop
  const entries = () => h.session.sessionManager.getBranch().filter((e: any) => e.type === "custom").map((e: any) => e.data);
  assert.ok(entries().some((e: any) => e.type === "goal.transition" && e.from === "budget_limited" && e.to === "complete"), JSON.stringify(entries()));
  const usage = () => entries().filter((e: any) => e.type === "goal.usage");
  assert.equal(usage().reduce((n: number, e: any) => n + (e.input ?? 0) + (e.output ?? 0), 0), 11);
  assert.equal(usage().length, 2); // assistant tool call plus its actual tool result
  const result = h.session.sessionManager.getBranch().find((e: any) => e.message?.role === "toolResult") as any;
  assert.equal(result.message.isError, false);
  assert.match(result.message.content[0].text, /Goal marked complete/);
  await h.session.prompt("unrelated question");
  await h.settle();
  assert.equal(h.calls(), 2);
  assert.equal(usage().reduce((n: number, e: any) => n + (e.input ?? 0) + (e.output ?? 0), 0), 11);
  assert.equal(h.continuations().length, 1);
});
