import test from "node:test";
import assert from "node:assert/strict";
import { createGoalCommit } from "../src/goal-commit.ts";
import type { Entry } from "../src/goal.ts";

const create = { type: "create" as const, id: "g1", objective: "ship it" };

test("bootstrap from branch and CAS conflict", async () => {
  const seed = { type: "goal.created" as const, version: 1 as const, seq: 4, goal: {
    id: "old", objective: "existing", status: "active" as const, tokenBudget: null, maxContinuations: 25,
    continuationSeq: 0, createdAt: 1, updatedAt: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 }
  } };
  const c = createGoalCommit({ readBranch: () => [seed], append: async () => {} });
  assert.equal(c.current()?.goal.id, "old");
  const conflict = await c.commit({ type: "transition", to: "paused", by: "user", userRequest: "stop" }, 1);
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.snapshot?.revision, 0);
});

test("pending slot refuses second commit", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const c = createGoalCommit({ readBranch: () => [], append: async () => gate });
  const first = c.commit(create, 0);
  const second = await c.commit(create, 0);
  assert.equal(second.kind, "conflict");
  release();
  const firstResult = await first;
  assert.equal(firstResult.kind, "ok");
});

test("append failure releases pending slot", async () => {
  let fail = true;
  const c = createGoalCommit({ readBranch: () => [], append: async () => { if (fail) { fail = false; throw new Error("nope"); } } });
  const failed = await c.commit(create, 0);
  assert.equal(failed.kind, "error");
  const retry = await c.commit(create, 0);
  assert.equal(retry.kind, "ok");
});

test("subscriber is notified after successful append", async () => {
  const seen: unknown[] = [];
  const c = createGoalCommit({ readBranch: () => [], append: async (_entry: Entry) => {} });
  c.subscribe(snapshot => seen.push(snapshot));
  await c.commit(create, 0);
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { goal: { id: string } }).goal.id, "g1");
});

test("rebuild preserves subscribers and reloads the branch", async () => {
  let branch: Entry[] = [];
  const seen: unknown[] = [];
  const c = createGoalCommit({ readBranch: () => branch, append: async () => {} });
  c.subscribe(snapshot => seen.push(snapshot));
  await c.commit(create, 0);
  branch = [{ type: "goal.created", version: 1, seq: 1, goal: {
    id: "g2", objective: "new branch", status: "active", tokenBudget: null, maxContinuations: 25,
    continuationSeq: 0, createdAt: 1, updatedAt: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 }
  } }];
  c.rebuild();
  assert.equal(seen.length, 2);
  assert.equal((seen[1] as { goal: { id: string } }).goal.id, "g2");
});
