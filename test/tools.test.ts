import test from "node:test";
import assert from "node:assert/strict";
import { registerGoalTools } from "../src/tools.ts";
import { createGoalCommit, type GoalSnapshot } from "../src/goal-commit.ts";
import type { Entry } from "../src/goal.ts";

const goal = { id: "g", objective: "ship", status: "active" as const, tokenBudget: null, maxContinuations: 25, continuationSeq: 0, createdAt: 0, updatedAt: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 } };
function setup(snapshot: GoalSnapshot | null = { goal, revision: 3 }, response: any = { kind: "ok", snapshot: { goal, revision: 4 } }) {
  const tools: any[] = []; const calls: any[] = [];
  registerGoalTools({ registerTool: tool => tools.push(tool) }, { goalCommit: { current: () => snapshot, getRevision: () => snapshot?.revision ?? 0, commit: async (intent, revision) => { calls.push({ intent, revision }); return response; } } });
  return { tools, calls };
}
const invoke = (tool: any, params: any) => tool.execute("call", params);
const body = async (tool: any, params: any) => (await invoke(tool, params)).content[0].text;

test("registers the Codex tool schemas", () => {
  const { tools } = setup();
  assert.deepEqual(tools.map(t => t.name), ["get_goal", "create_goal", "update_goal"]);
  assert.equal((tools[0].parameters as any).type, "object");
  assert.deepEqual(Object.keys((tools[1].parameters as any).properties), ["objective", "token_budget"]);
  assert.equal((tools[1].parameters as any).properties.token_budget.minimum, 1);
  assert.deepEqual(Object.keys((tools[2].parameters as any).properties), ["status"]);
  assert.deepEqual(((tools[2].parameters as any).properties.status.anyOf ?? []).map((s: any) => s.const), ["complete", "blocked"]);
  assert.equal((tools[1].parameters as any).properties.objective.description, "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.");
  assert.equal((tools[1].parameters as any).properties.token_budget.description, "Positive token budget for the new goal. Omit unless explicitly requested.");
  assert.match((tools[2].parameters as any).properties.status.description, /at least three consecutive goal turns/);
});

test("get_goal reports remaining budget and elapsed seconds", async () => {
  const { tools } = setup({ goal: { ...goal, tokenBudget: 100, usage: { ...goal.usage, input: 30 } }, revision: 3 });
  const out = JSON.parse(await body(tools[0], {}));
  assert.equal(out.revision, 3);
  assert.equal(out.remainingBudget, 70);
  assert.equal(typeof out.elapsedSeconds, "number");
  assert.equal(JSON.parse(await body(setup().tools[0], {})).remainingBudget, null);
  assert.equal(await body(setup(null).tools[0], {}), "No active goal.");
});

test("create_goal refuses a second unfinished goal", async () => {
  const { tools } = setup();
  assert.match(await body(tools[1], { objective: "another" }), /unfinished/);
});

test("update_goal uses the current revision and never terminates the turn", async () => {
  const conflict = setup({ goal, revision: 7 }, { kind: "conflict", snapshot: { goal, revision: 8 } });
  assert.match(await body(conflict.tools[2], { status: "blocked" }), /conflict/);
  assert.equal(conflict.calls[0].revision, 7);
  const complete = setup();
  const result = await invoke(complete.tools[2], { status: "complete" });
  assert.match(result.content[0].text, /Final token usage/);
  assert.equal("terminate" in result, false);
  assert.equal(complete.calls[0].intent.to, "complete");
  const blocked = await invoke(setup().tools[2], { status: "blocked" });
  assert.equal(blocked.content[0].text, "Goal marked blocked.");
  assert.equal("terminate" in blocked, false);
});

test("paused is outside the schema enum and never commits", async () => {
  const { tools, calls } = setup();
  const out = await invoke(tools[2], { status: "paused" });
  assert.doesNotMatch(out.content[0].text, /Goal marked/);
  assert.equal(calls.length, 0);
});

test("create_goal recreates after clear using the current revision", async () => {
  const entries: Entry[] = [{ type: "goal.created", version: 1, seq: 1, goal }];
  const goalCommit = createGoalCommit({ readBranch: () => entries, append: entry => { entries.push(entry); } });
  await goalCommit.commit({ type: "clear" }, goalCommit.getRevision());
  const tools: any[] = [];
  registerGoalTools({ registerTool: tool => tools.push(tool) }, { goalCommit });
  assert.equal(await body(tools[1], { objective: "again" }), "Goal created.");
  assert.equal(goalCommit.current()?.goal.objective, "again");
});

test("update_goal completes budget-limited goals but refuses paused and blocked goals", async () => {
  for (const status of ["budget_limited", "paused", "blocked"] as const) {
    const entries: Entry[] = [{ type: "goal.created", version: 1, seq: 1, goal: { ...goal, status } }];
    const goalCommit = createGoalCommit({ readBranch: () => entries, append: entry => { entries.push(entry); } });
    const tools: any[] = [];
    registerGoalTools({ registerTool: tool => tools.push(tool) }, { goalCommit });
    const response = await invoke(tools[2], { status: "complete" });
    if (status === "budget_limited") assert.match(response.content[0].text, /Final token usage/);
    else assert.match(response.content[0].text, /only an active or budget-limited goal/);
    assert.equal(goalCommit.current()?.goal.status, status === "budget_limited" ? "complete" : status);
  }
});
