import test from "node:test";
import assert from "node:assert/strict";
import { parseGoalCommand, registerGoalCommands } from "../src/commands.ts";
import { createGoalCommit, type GoalSnapshot } from "../src/goal-commit.ts";
import { createContinuation } from "../src/continuation.ts";
import type { Entry } from "../src/goal.ts";

const goal = { id: "g", objective: "ship", status: "active" as const, tokenBudget: null, maxContinuations: 25, continuationSeq: 0, createdAt: 0, updatedAt: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 } };
function setup(snapshot: GoalSnapshot | null = { goal, revision: 4 }) {
  const calls: any[] = []; const sent: any[] = []; let kicks = 0; let command: any;
  registerGoalCommands({ registerCommand: (_name, c) => { command = c; } }, {
    goalCommit: { current: () => snapshot, commit: async (intent, revision) => { calls.push({ intent, revision }); return { kind: "ok", snapshot }; } },
    summarize: s => s ? `SHOW ${s.goal.id}` : "EMPTY",
    send: (message, options) => sent.push({ message, options }),
    kick: async () => { kicks++; }
  });
  return { command, calls, sent, kicks: () => kicks };
}

test("parses status, token suffixes, and limits", () => {
  assert.deepEqual(parseGoalCommand(""), { kind: "status" });
  assert.deepEqual(parseGoalCommand("--tokens 2K ship it"), { kind: "create", objective: "ship it", tokenBudget: 2000 });
  assert.deepEqual(parseGoalCommand("--tokens 3m ship it"), { kind: "create", objective: "ship it", tokenBudget: 3000000 });
  assert.deepEqual(parseGoalCommand("budget none"), { kind: "budget", tokenBudget: null });
  assert.deepEqual(parseGoalCommand("turns 12"), { kind: "turns", value: 12 });
});

test("clear, pause, and resume commit user flows", async () => {
  const { command, calls, kicks } = setup();
  assert.equal(await command.handler("pause"), "Goal paused.");
  assert.deepEqual(calls[0], { intent: { type: "transition", to: "paused", by: "user", userRequest: '"/goal pause"' }, revision: 4 });
  assert.equal(await command.handler("resume"), "Goal resumed.");
  assert.deepEqual(calls[1].intent, { type: "transition", to: "active", by: "user", resetContinuations: true });
  assert.equal(kicks(), 1);
  assert.equal(await command.handler("clear"), "Goal cleared.");
  assert.deepEqual(calls[2].intent, { type: "clear" });
});

for (const status of ["paused", "budget_limited", "blocked", "active"] as const) {
  test(`resume from ${status} renews allowance, sends immediately, and survives replay`, async () => {
    const original = { ...goal, status, continuationSeq: 25, tokenBudget: 100, usage: { ...goal.usage, input: 10, output: 5 } };
    const entries: Entry[] = [{ type: "goal.created", version: 1, seq: 1, goal: original }];
    const store = { readBranch: () => entries, append: (e: Entry) => { entries.push(e); } };
    const goalCommit = createGoalCommit(store);
    const sent: any[] = [];
    const continuation = createContinuation({ getSnapshot: goalCommit.current, commit: goalCommit.commit, send: (m) => sent.push(m), isIdle: () => true, hasPendingMessages: () => false, buildPrompt: () => "continue" });
    let command: any;
    registerGoalCommands({ registerCommand: (_name, c) => { command = c; } }, { goalCommit, send: () => {}, kick: continuation.onSettled });
    assert.equal(await command.handler("resume"), "Goal resumed.");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.seq, 1);
    const restored = createGoalCommit(store).current()!.goal;
    assert.deepEqual(restored, { ...original, status: "active", continuationSeq: 1 });
    assert.equal(entries.length, 3);
  });
}

test("exhausted token budget refuses resume without resetting usage or kicking", async () => {
  const h = setup({ goal: { ...goal, tokenBudget: 10, usage: { ...goal.usage, input: 10 } }, revision: 4 });
  assert.match(await h.command.handler("resume"), /token budget exhausted/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.kicks(), 0);
});

test("zero continuation allowance refuses resume explicitly", async () => {
  const h = setup({ goal: { ...goal, maxContinuations: 0 }, revision: 4 });
  assert.match(await h.command.handler("resume"), /allowance is zero/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.kicks(), 0);
});

test("create and edit kick and steer the model", async () => {
  const created = setup(null);
  assert.equal(await created.command.handler("brand new"), "Goal created.");
  assert.equal(created.kicks(), 1);
  assert.equal(created.sent.length, 0);
  const initial = { ...goal, tokenBudget: 5000, maxContinuations: 7 };
  const edited = setup({ goal: initial, revision: 4 });
  assert.equal(await edited.command.handler("edit revised"), "Goal edited.");
  assert.deepEqual(edited.calls[1].intent, { type: "create", id: edited.calls[1].intent.id, objective: "revised", tokenBudget: 5000, maxContinuations: 7 });
  assert.equal(edited.sent.length, 1);
  assert.equal(edited.sent[0].message.customType, "pi-goal-next/objective_updated");
  assert.deepEqual(edited.sent[0].message.details, { goalId: "g" });
  assert.deepEqual(edited.sent[0].options, { triggerTurn: true });
});
