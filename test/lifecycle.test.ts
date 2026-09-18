import assert from "node:assert/strict";
import test from "node:test";
import { createGoalCommit } from "../src/goal-commit.ts";
import { createAccounting } from "../src/accounting.ts";
import { createContinuation } from "../src/continuation.ts";
import { registerLifecycle } from "../src/lifecycle.ts";
import { createGoalClock } from "../src/clock.ts";
import { createFakePi } from "./support/fake-pi.ts";

for (const status of ["complete", "paused", "blocked"] as const) {
  test(`usage retains the completing run but excludes later ${status} conversations`, async () => {
    const h = setup();
    await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
    await h.fake.emit("agent_start");
    await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", usage: { input: 10 } } });
    await h.goalCommit.commit({ type: "transition", to: status, by: "user", userRequest: "stop" }, h.goalCommit.current().revision);
    await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 5 } } });
    await h.fake.emit("agent_settled");
    assert.equal(h.goalCommit.current().goal.usage.input, 15);
    await h.fake.emit("agent_start");
    await h.fake.emit("message_start", { message: { role: "user" } });
    await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 100 } } });
    await h.fake.emit("agent_settled");
    assert.equal(h.goalCommit.current().goal.usage.input, 15);
  });
}

test("goal created by a tool owns subsequent messages in the same run", async () => {
  const h = setup();
  await h.fake.emit("agent_start");
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", usage: { input: 100 } } });
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  await h.fake.emit("message_end", { message: { role: "toolResult", usage: { input: 2 } } });
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 3 } } });
  assert.equal(h.goalCommit.current().goal.usage.input, 5);
});

test("replacement goal does not inherit usage from the old running goal", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "old", objective: "work" }, 0);
  await h.fake.emit("agent_start");
  await h.goalCommit.commit({ type: "replace", id: "new", objective: "new work" }, h.goalCommit.current().revision);
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 100 } } });
  assert.equal(h.goalCommit.current().goal.usage.input, 0);
  await h.fake.emit("agent_start");
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 7 } } });
  assert.equal(h.goalCommit.current().goal.usage.input, 7);
});

for (const status of ["active", "paused", "complete"] as const) {
  test(`compaction retains Pi's default summary for ${status} goals`, async () => {
    const h = setup();
    await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
    if (status !== "active") await h.goalCommit.commit({ type: "transition", to: status, by: "user", userRequest: "stop" }, h.goalCommit.current().revision);
    const result = await h.fake.emit("session_before_compact", { preparation: { firstKeptEntryId: "tail", tokensBefore: 100000 } });
    assert.equal(result, undefined);
  });
}

test("usage retry cannot migrate to a concurrently replaced goal", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "old", objective: "work" }, 0);
  await h.fake.emit("agent_start");
  const original = h.goalCommit.commit;
  let replaced = false;
  h.goalCommit.commit = async (intent: any, revision: number) => {
    if (intent.type === "usage" && !replaced) {
      replaced = true;
      await original({ type: "replace", id: "new", objective: "new work" }, revision);
      return { kind: "conflict", snapshot: h.goalCommit.current() };
    }
    return original(intent, revision);
  };
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 100 } } });
  assert.equal(h.goalCommit.current().goal.id, "new");
  assert.equal(h.goalCommit.current().goal.usage.input, 0);
});

test("explicit resume during an unrelated run starts accounting subsequent output", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  await h.goalCommit.commit({ type: "transition", to: "paused", by: "user", userRequest: "pause" }, h.goalCommit.current().revision);
  await h.fake.emit("agent_start");
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", usage: { input: 100 } } });
  await h.goalCommit.commit({ type: "transition", to: "active", by: "user", resetContinuations: true }, h.goalCommit.current().revision);
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 5 } } });
  assert.equal(h.goalCommit.current().goal.usage.input, 5);
});

test("paused-start run cannot claim a replacement goal", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "old", objective: "work" }, 0);
  await h.goalCommit.commit({ type: "transition", to: "paused", by: "user", userRequest: "pause" }, h.goalCommit.current().revision);
  await h.fake.emit("agent_start");
  await h.goalCommit.commit({ type: "replace", id: "new", objective: "new work" }, h.goalCommit.current().revision);
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 100 } } });
  assert.equal(h.goalCommit.current().goal.usage.input, 0);
});

test("failed usage persistence retries at settlement and records once", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  await h.fake.emit("agent_start");
  const original = h.goalCommit.commit;
  let fail = true;
  h.goalCommit.commit = async (intent: any, revision: number) => intent.type === "usage" && fail ? { kind: "error", error: new Error("disk") } : original(intent, revision);
  const message = { role: "assistant", stopReason: "stop", usage: { input: 7 } };
  await h.fake.emit("message_end", { message });
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 0);
  assert.equal(h.goalCommit.current().goal.usage.input, 0);
  fail = false;
  await h.fake.emit("agent_settled");
  assert.equal(h.goalCommit.current().goal.usage.input, 7);
  await h.fake.emit("message_end", { message });
  assert.equal(h.goalCommit.current().goal.usage.input, 7);
});

function setup(entries: any[] = [], now: () => number = Date.now) {
  const fake = createFakePi(entries);
  const store = { readBranch: () => fake.ctx.sessionManager.getBranch().filter((e: any) => e.type === "custom").map((e: any) => e.data), append: (entry: any) => fake.pi.appendEntry("pi-goal-next", entry) };
  let committed = createGoalCommit(store);
  const goalCommit: any = { current: () => committed.current(), commit: (i: any, r: number) => committed.commit(i, r), subscribe: (fn: any) => committed.subscribe(fn) };
  const accounting = createAccounting();
  const clock = createGoalClock(now);
  const continuation = createContinuation({
    getSnapshot: goalCommit.current, commit: (i, r) => goalCommit.commit(i, r),
    send: (m, o) => fake.pi.sendMessage(m, o), isIdle: fake.pi.isIdle, hasPendingMessages: fake.pi.hasPendingMessages, buildPrompt: () => "continue"
  });
  registerLifecycle(fake.pi, { goalCommit, accounting, clock, continuation, send: (m: any, o: any) => fake.pi.sendMessage(m, o), rebuild: () => { committed = createGoalCommit(store); } });
  return { fake, goalCommit, accounting, clock };
}

for (const stopReason of ["error", "aborted", "toolUse", undefined]) {
  test(`current ${stopReason} after prior stop cannot trigger automatic work`, async () => {
    const h = setup();
    await h.goalCommit.commit({ type: "create", id: "g", objective: "work", maxContinuations: 0 }, 0);
    h.fake.state.branch.push({ type: "message", id: "previous", message: { role: "assistant", stopReason: "stop", usage: { input: 99 } } });
    await h.fake.emit("message_end", { message: { role: "assistant", stopReason, usage: { input: 3 } } });
    await h.fake.emit("agent_settled");
    assert.equal(h.fake.sentMessages.length, 0);
    assert.equal(h.goalCommit.current().goal.usage.input, 3);
  });
}

test("settlement requires a fresh completion and is consumed once", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 0);
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await h.fake.emit("agent_settled");
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 1);
  await h.fake.emit("agent_start");
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 1);
});

for (const maxContinuations of [0, 25]) {
  test(`input during commit prevents automatic send (limit ${maxContinuations})`, async () => {
    const h = setup();
    await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
    await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    await h.goalCommit.commit({ type: "limit_config", tokenBudget: null, maxContinuations }, h.goalCommit.current().revision);
    const original = h.goalCommit.commit;
    let intercepted = false;
    h.goalCommit.commit = async (intent: any, revision: number) => {
      const result = await original(intent, revision);
      if (!intercepted) {
        intercepted = true;
        // Pi has delivered input, but hasn't queued it or started its run yet.
        await h.fake.emit("input", { source: "rpc" });
      }
      return result;
    };
    await h.fake.emit("agent_settled");
    assert.ok(intercepted);
    assert.equal(h.fake.sentMessages.length, 0);
  });
}

test("input preflight prevents old completion from sending before user message starts", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  await h.fake.emit("input", { source: "rpc" });
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 0);
  await h.fake.emit("message_start", { message: { role: "user" } });
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 1);
});

test("replays goal lifecycle: usage is journaled and completion remains final", async () => {
  const h = setup();
  await h.fake.emit("session_start");
  let s = h.goalCommit.current();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "ship" }, s?.revision ?? 0);
  h.fake.state.branch.push({ id: "m1", role: "assistant", usage: { input: 3, output: 5 } });
  await h.fake.emit("message_end", { message: { id: "m1", role: "assistant", usage: { input: 3, output: 5 } } });
  s = h.goalCommit.current();
  assert.equal(s?.goal.usage.output, 5);
  await h.goalCommit.commit({ type: "transition", to: "complete", by: "agent" }, s!.revision);
  await h.fake.emit("agent_settled");
  assert.equal(h.goalCommit.current()?.goal.status, "complete");
});

test("message_end uses current event before persistence, never previous branch usage", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "ship" }, 0);
  h.fake.state.branch.push({ id: "m1", role: "assistant", usage: { input: 7, output: 2 } });
  await h.fake.emit("message_end", { message: { role: "assistant", usage: { input: 11, output: 9 } } });
  assert.equal(h.goalCommit.current()?.goal.usage.input, 11);
  assert.equal(h.goalCommit.current()?.goal.usage.output, 9);
});

test("usage commit retries a conflict", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "ship" }, 0);
  h.fake.state.branch.push({ id: "m1", role: "assistant", usage: { input: 3, output: 4 } });
  const original = h.goalCommit.commit;
  let conflicted = false;
  h.goalCommit.commit = async (intent: any, revision: number) => { if (!conflicted && intent.type === "usage") { conflicted = true; return { kind: "conflict", snapshot: h.goalCommit.current() }; } return original(intent, revision); };
  await h.fake.emit("message_end", { message: { id: "m1", role: "assistant", usage: { input: 3, output: 4 } } });
  assert.equal(h.goalCommit.current()?.goal.usage.output, 4);
});

test("session_start pauses a restored active goal", async () => {
  const h = setup();
  const seed = createGoalCommit({ readBranch: () => [], append: () => undefined });
  await seed.commit({ type: "create", id: "restored", objective: "resume me" }, 0);
  const entry = (seed as any).current().goal;
  h.fake.state.branch.push({ type: "custom", customType: "pi-goal-next", data: { type: "goal.created", version: 1, seq: 1, goal: entry } });
  await h.fake.emit("session_start");
  assert.equal(h.goalCommit.current()?.goal.status, "paused");
});

test("tree invalidates and rebuilds against the selected branch", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "a", objective: "branch a" }, 0);
  await h.fake.emit("session_before_tree");
  h.fake.createBranchedState([]);
  await h.fake.emit("input", { source: "extension" });
  assert.equal(h.goalCommit.current(), null);
});

test("user input blocks continuation and stale generation is accepted without another send", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  h.fake.setPendingMessages(true);
  await h.fake.emit("input", { source: "user" });
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 0);
  h.fake.setPendingMessages(false);
  await h.fake.emit("session_before_tree");
  await h.fake.emit("message_start", { message: { role: "custom", customType: "pi-goal-next/continuation", details: { goalId: "g", generation: 0 } } });
  assert.equal(h.fake.sentMessages.length, 0);
});

test("error turn skips continuation; a later normal turn recovers", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  h.fake.state.branch.push({ id: "m1", role: "assistant", usage: { input: 1 }, stopReason: "error" });
  await h.fake.emit("message_end", { message: { id: "m1", role: "assistant", usage: { input: 1 }, stopReason: "error" } });
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 0);
  h.fake.state.branch.push({ id: "m2", role: "assistant", usage: { input: 2, output: 3 }, stopReason: "stop" });
  await h.fake.emit("message_end", { message: { id: "m2", role: "assistant", usage: { input: 2, output: 3 }, stopReason: "stop" } });
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 1);
  assert.equal(h.fake.sentMessages[0].message.customType, "pi-goal-next/continuation");
});

test("aborted turn skips continuation", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  h.fake.state.branch.push({ id: "m1", role: "assistant", usage: { input: 1 }, stopReason: "aborted" });
  await h.fake.emit("message_end", { message: { id: "m1", role: "assistant", usage: { input: 1 }, stopReason: "aborted" } });
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 0);
});

test("wrapped session entries preserve identity, usage, and cancellation", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "ship", tokenBudget: 5 }, 0);
  const message = { role: "assistant", usage: { input: 5, output: 2 }, stopReason: "aborted" };
  h.fake.state.branch.push({ type: "message", id: "outer-id", message });
  await h.fake.emit("message_end", { message });
  await h.fake.emit("message_end", { message });
  assert.equal(h.goalCommit.current()?.goal.usage.input, 5);
  assert.equal(h.goalCommit.current()?.goal.usage.output, 2);
  await h.fake.emit("agent_settled");
  assert.equal(h.fake.sentMessages.length, 0);
});

for (const status of ["paused", "blocked", "complete"] as const) {
  test(`${status} goal remains unchanged at continuation limit`, async () => {
    const h = setup();
    await h.goalCommit.commit({ type: "create", id: "g", objective: "ship", maxContinuations: 0 }, 0);
    await h.goalCommit.commit({ type: "transition", to: status, by: "user", userRequest: "stop" }, h.goalCommit.current().revision);
    await h.fake.emit("agent_settled");
    assert.equal(h.goalCommit.current()?.goal.status, status);
    assert.equal(h.fake.sentMessages.length, 0);
  });
}

for (const stopReason of ["aborted", "error"]) {
  test(`${stopReason} at continuation limit sends no budget prompt`, async () => {
    const h = setup();
    await h.goalCommit.commit({ type: "create", id: "g", objective: "ship", maxContinuations: 0 }, 0);
    const message = { role: "assistant", usage: { input: 0, output: 0 }, stopReason };
    h.fake.state.branch.push({ type: "message", id: "outer", message });
    await h.fake.emit("message_end", { message });
    await h.fake.emit("agent_settled");
    assert.equal(h.fake.sentMessages.length, 0);
  });
}

test("usage-journal budget flip steers exactly once", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "ship", tokenBudget: 5 }, 0);
  h.fake.state.branch.push({ id: "m1", role: "assistant", usage: { input: 5 } });
  await h.fake.emit("message_end", { message: { id: "m1", role: "assistant", usage: { input: 5 }, stopReason: "stop" } });
  assert.equal(h.goalCommit.current()?.goal.status, "budget_limited");
  await h.fake.emit("agent_settled");
  const steers = () => h.fake.sentMessages.filter((m: any) => m.message.customType === "pi-goal-next/budget_limit");
  assert.equal(steers().length, 1);
  assert.deepEqual(h.fake.sentMessages[0].options, { triggerTurn: true });
  await h.fake.emit("agent_settled");
  assert.equal(steers().length, 1);
});

test("verdict-commit budget flip steers exactly once", async () => {
  const h = setup();
  await h.goalCommit.commit({ type: "create", id: "g", objective: "ship", maxContinuations: 0 }, 0);
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 1 } } });
  await h.fake.emit("agent_settled");
  assert.equal(h.goalCommit.current()?.goal.status, "budget_limited");
  const steers = () => h.fake.sentMessages.filter((m: any) => m.message.customType === "pi-goal-next/budget_limit");
  assert.equal(steers().length, 1);
  await h.fake.emit("agent_settled");
  assert.equal(steers().length, 1);
});

test("active run journals accrued wall-clock time on its first usage commit", async () => {
  let now = 0;
  const h = setup([], () => now);
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  await h.fake.emit("agent_start");
  now = 3000;
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 1 } } });
  const usage = () => h.fake.state.branch.filter((e: any) => e.type === "custom" && e.data.type === "goal.usage").map((e: any) => e.data);
  assert.equal(usage().at(-1).seconds, 3);
  assert.equal(h.goalCommit.current().goal.timeUsedSeconds, 3);

  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 2 } } });
  assert.equal(usage().at(-1).seconds, 0);
  assert.equal(h.goalCommit.current().goal.timeUsedSeconds, 3);
});

test("paused gaps are excluded after subscribed pause and resume commits", async () => {
  let now = 0;
  const h = setup([], () => now);
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  await h.goalCommit.commit({ type: "transition", to: "paused", by: "user", userRequest: "pause" }, h.goalCommit.current().revision);
  now = 10000;
  await h.goalCommit.commit({ type: "transition", to: "active", by: "user", resetContinuations: true }, h.goalCommit.current().revision);
  now = 12800;
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 1 } } });
  assert.equal(h.goalCommit.current().goal.timeUsedSeconds, 2);
});

test("user message_start journals idle active time without token usage", async () => {
  let now = 0;
  const h = setup([], () => now);
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  now = 2200;
  await h.fake.emit("message_start", { message: { role: "user" } });
  const entry = h.fake.state.branch.findLast((e: any) => e.type === "custom" && e.data.type === "goal.usage")?.data;
  assert.equal(entry.seconds, 2);
  assert.deepEqual({ input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite, unknownMessages: entry.unknownMessages }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 });
  assert.equal(h.goalCommit.current().goal.timeUsedSeconds, 2);
});

test("failed usage persistence keeps the full clock delta for retry", async () => {
  let now = 0;
  const h = setup([], () => now);
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work" }, 0);
  await h.fake.emit("agent_start");
  now = 4100;
  const original = h.goalCommit.commit;
  let fail = true;
  h.goalCommit.commit = async (intent: any, revision: number) => intent.type === "usage" && fail ? { kind: "error", error: new Error("disk") } : original(intent, revision);
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 1 } } });
  assert.equal(h.goalCommit.current().goal.timeUsedSeconds, 0);
  fail = false;
  await h.fake.emit("agent_settled");
  assert.equal(h.goalCommit.current().goal.timeUsedSeconds, 4);
  const usage = h.fake.state.branch.filter((e: any) => e.type === "custom" && e.data.type === "goal.usage").map((e: any) => e.data);
  assert.equal(usage.at(-1).seconds, 4);
});

test("budget-limit steering prompt reports accumulated wall-clock time", async () => {
  let now = 0;
  const h = setup([], () => now);
  await h.goalCommit.commit({ type: "create", id: "g", objective: "work", tokenBudget: 5 }, 0);
  await h.fake.emit("agent_start");
  now = 2500;
  await h.fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 5 } } });
  await h.fake.emit("agent_settled");
  const prompt = h.fake.sentMessages.find((m: any) => m.message.customType === "pi-goal-next/budget_limit");
  assert.match(prompt.message.content, /Time spent pursuing goal: 2 seconds/);
});
