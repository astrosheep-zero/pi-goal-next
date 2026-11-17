import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import goalExtension from "../src/index.ts";

// Exercise the real Pi 1.1 event dispatcher, session persistence, input queue,
// and sendMessage implementation. Only model inference is replaced; no network.
async function harness(t: any, reasons: string[], toolNames: string[] = []) {
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
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader, settingsManager, modelRuntime, model, tools: ["get_goal", "update_goal"], sessionManager: SessionManager.inMemory(dir) });
  const errors: unknown[] = [];
  const notifications: string[] = [];
  await session.bindExtensions({ onError: (e) => errors.push(e), uiContext: { notify: (message: string) => notifications.push(message), setStatus: () => {} } as any });
  let calls = 0;
  const requests: unknown[] = [];
  let beforeResponse: ((call: number, signal?: AbortSignal) => Promise<void>) | undefined;
  session.agent.streamFunction = async (_model, context, options) => {
    requests.push(structuredClone(context));
    const stream = createAssistantMessageEventStream();
    let stopReason = reasons[calls++] ?? "aborted";
    await beforeResponse?.(calls, options?.signal);
    if (options?.signal?.aborted) stopReason = "aborted";
    const message: any = {
      role: "assistant", content: toolNames.length && calls === 1 ? toolNames.map((name, i) => ({ type: "toolCall", id: `tool-${i}`, name, arguments: name === "update_goal" ? { status: "complete" } : {} })) : [{ type: "text", text: `response-${calls}` }], api: model.api, provider: model.provider, model: model.id,
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
  return { session, settle, continuations, beforePersist, notifications, requests, calls: () => calls, beforeResponse: (handler: typeof beforeResponse) => { beforeResponse = handler; } };
}

test("real Pi: bare /goal reports exhausted budget through UI without starting inference or changing the journal", async (t) => {
  const h = await harness(t, ["stop", "stop"]);
  await h.session.prompt("/goal --tokens 10 verify this task");
  await h.settle();
  const calls = h.calls();
  const branch = h.session.sessionManager.getBranch();
  await h.session.prompt("/goal");
  const message = h.notifications.at(-1)!;
  assert.match(message, /Status: budget_limited/);
  assert.match(message, /Objective: verify this task/);
  assert.match(message, /Tokens: 11 used \/ 10 budget/);
  assert.equal(calls, 1); // A final response crossing the budget does not start a closure run.
  assert.equal(branch.some((e: any) => e.customType === "pi-goal-next/budget_limit"), false);
  assert.match(message, /Limit: token budget/);
  assert.match(message, /0 left/);
  assert.match(message, /Continuations: 1\/32/);
  assert.match(message, /Active time: \d+s/);
  assert.equal(h.calls(), calls);
  assert.deepEqual(h.session.sessionManager.getBranch(), branch);
  await h.session.prompt("/goal budget nonsense");
  assert.match(h.notifications.at(-1)!, /Invalid.*Usage/);
  assert.equal(h.calls(), calls);
  assert.deepEqual(h.session.sessionManager.getBranch(), branch);
});

test("real Pi: continuation exhaustion sends the correct closure and recovery details with tokens still available", async (t) => {
  const h = await harness(t, ["stop", "stop"]);
  h.beforeResponse(async (call) => { if (call === 1) await h.session.prompt("/goal turns 1"); });
  await h.session.prompt("/goal --tokens 1000 verify this task");
  await h.settle();
  const closure = h.session.sessionManager.getBranch().find((e: any) => e.type === "custom_message" && e.customType === "pi-goal-next/budget_limit") as any;
  assert.ok(closure);
  assert.match(closure.content, /automatic continuation limit, not its token budget/);
  assert.doesNotMatch(closure.content, /has reached its token budget/);
  await h.session.prompt("/goal");
  assert.match(h.notifications.at(-1)!, /Limit: continuations/);
  assert.match(h.notifications.at(-1)!, /Next: \/goal resume/);
  assert.match(h.notifications.at(-1)!, /967 left/);
  assert.equal(h.calls(), 2);
});

test("real Pi: token exhaustion steers after the tool batch before the closing response, in the same run", async (t) => {
  const h = await harness(t, ["toolUse", "stop"], ["get_goal", "get_goal"]);
  let starts = 0;
  h.session.subscribe(event => { if (event.type === "agent_start") starts++; });
  await h.session.prompt("/goal --tokens 10 verify this task");
  await h.settle();
  assert.equal(h.calls(), 2);
  assert.equal(starts, 1);
  const branch = h.session.sessionManager.getBranch() as any[];
  const closures = branch.filter(e => e.type === "custom_message" && e.customType === "pi-goal-next/budget_limit");
  assert.equal(closures.length, 1);
  assert.equal(closures[0].display, false);
  assert.match(closures[0].content, /Tokens used: 11/);
  assert.match(JSON.stringify(h.requests[1]), /has reached its token budget/);
  assert.equal(branch.filter(e => e.message?.role === "toolResult").length, 2);
  const closureIndex = branch.indexOf(closures[0]);
  assert.ok(branch.findLastIndex(e => e.message?.role === "toolResult") < closureIndex);
  assert.ok(closureIndex < branch.findLastIndex(e => e.message?.role === "assistant"));
  await h.session.prompt("/goal");
  assert.match(h.notifications.at(-1)!, /Tokens: 33 used \/ 10 budget/);
  assert.equal(h.continuations().length, 1);
});

test("real Pi: abort after tool completion suppresses budget steering and does not restart", async (t) => {
  const h = await harness(t, ["toolUse"], ["get_goal"]);
  let stopping: Promise<void> | undefined;
  let starts = 0;
  h.session.subscribe(event => {
    if (event.type === "agent_start") starts++;
    if (event.type === "tool_execution_end" && !stopping) stopping = h.session.abort();
  });
  await h.session.prompt("/goal --tokens 10 verify this task");
  await h.settle();
  await stopping;
  assert.equal(starts, 1);
  const branch = h.session.sessionManager.getBranch() as any[];
  assert.equal(branch.findLast(e => e.message?.role === "assistant").message.stopReason, "aborted");
  assert.equal(branch.some(e => e.customType === "pi-goal-next/budget_limit"), false);
});

test("real Pi: budget crossing before completion tool permits completion; final reply counts and later unrelated input does not", async (t) => {
  const h = await harness(t, ["toolUse", "stop", "stop"], ["update_goal"]);
  await h.session.prompt("/goal --tokens 10 finish the task");
  await h.settle();
  // No terminate flag: after update_goal succeeds the model still writes its closing reply.
  assert.equal(h.calls(), 2);
  const entries = () => h.session.sessionManager.getBranch().filter((e: any) => e.type === "custom").map((e: any) => e.data);
  assert.ok(entries().some((e: any) => e.type === "goal.transition" && e.from === "budget_limited" && e.to === "complete"), JSON.stringify(entries()));
  const usage = () => entries().filter((e: any) => e.type === "goal.usage");
  assert.equal(usage().length, 3); // tool-call assistant, its tool result, and the closing reply
  const result = h.session.sessionManager.getBranch().find((e: any) => e.message?.role === "toolResult") as any;
  assert.equal(result.message.isError, false);
  assert.match(result.message.content[0].text, /Goal complete\. Tokens 11 total/);
  await h.session.prompt("unrelated question");
  await h.settle();
  assert.equal(h.calls(), 3);
  // completing turn (11 + closing reply 22) counts; the unrelated run (33) does not.
  assert.equal(usage().reduce((n: number, e: any) => n + (e.input ?? 0) + (e.output ?? 0), 0), 33);
  assert.equal(h.continuations().length, 1);
});
