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

test("getRevision is available for an empty branch and survives failed commits", async () => {
  let fail = true;
  const c = createGoalCommit({ readBranch: () => [], append: async () => { if (fail) throw new Error("nope"); } });
  assert.equal(c.current(), null);
  assert.equal(c.getRevision(), 0);
  assert.equal((await c.commit(create, c.getRevision())).kind, "error");
  assert.equal(c.getRevision(), 0);
  fail = false;
  assert.equal((await c.commit(create, c.getRevision())).kind, "ok");
});

test("replace is one atomic journal entry, preserves limits, and replays", async () => {
  const entries: Entry[] = [];
  const store = { readBranch: () => entries, append: (entry: Entry) => { entries.push(entry); } };
  const c = createGoalCommit(store);
  await c.commit({ type: "create", id: "old", objective: "old", tokenBudget: 99, maxContinuations: 7 }, 0);
  const oldRevision = c.current()!.revision;
  const replaced = await c.commit({ type: "replace", id: "new", objective: "new" }, oldRevision);
  assert.equal(replaced.kind, "ok");
  assert.equal(entries.filter(entry => entry.type === "goal.replaced").length, 1);
  assert.equal(c.current()!.goal.tokenBudget, 99);
  assert.equal(c.current()!.goal.maxContinuations, 7);
  assert.equal(createGoalCommit(store).current()!.goal.objective, "new");
});

test("update_objective preserves id, status, limits, and usage through replay", async () => {
  const entries: Entry[] = [];
  const store = { readBranch: () => entries, append: (e: Entry) => { entries.push(e); } };
  const c = createGoalCommit(store);
  const created = await c.commit({ type: "create", id: "g1", objective: "old", tokenBudget: 100 }, 0);
  assert.equal(created.kind, "ok");
  await c.commit({ type: "usage", input: 30, output: 5 }, 1);
  const updated = await c.commit({ type: "update_objective", objective: "new" }, 2);
  assert.equal(updated.kind, "ok");
  assert.equal(entries.filter(entry => entry.type === "goal.objective_updated").length, 1);
  const replayed = createGoalCommit(store).current()!.goal;
  assert.equal(replayed.id, "g1");
  assert.equal(replayed.objective, "new");
  assert.equal(replayed.status, "active");
  assert.equal(replayed.tokenBudget, 100);
  assert.equal(replayed.usage.input, 30);
  assert.equal(replayed.usage.output, 5);
});

test("update_objective append failure and validation leave the old objective", async () => {
  let fail = true;
  const goal = { id: "old", objective: "old", status: "active" as const, tokenBudget: 4, maxContinuations: 2, continuationSeq: 0, createdAt: 1, updatedAt: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 } };
  const entries: Entry[] = [{ type: "goal.created", version: 1, seq: 1, goal }];
  const c = createGoalCommit({ readBranch: () => entries, append: async () => { if (fail) throw new Error("nope"); } });
  assert.equal((await c.commit({ type: "update_objective", objective: "new" }, 0)).kind, "error");
  assert.equal(c.current()!.goal.objective, "old");
  fail = false;
  assert.equal((await c.commit({ type: "update_objective", objective: "   " }, 0)).kind, "error");
  assert.equal(c.current()!.goal.objective, "old");
});

test("replace append failure and validation leave the old goal intact", async () => {
  let fail = true;
  const goal = { id: "old", objective: "old", status: "active" as const, tokenBudget: 4, maxContinuations: 2, continuationSeq: 0, createdAt: 1, updatedAt: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 } };
  const entries: Entry[] = [{ type: "goal.created", version: 1, seq: 1, goal }];
  const c = createGoalCommit({ readBranch: () => entries, append: async () => { if (fail) throw new Error("nope"); } });
  assert.equal((await c.commit({ type: "replace", id: "new", objective: "new" }, 0)).kind, "error");
  assert.equal(c.current()!.goal.id, "old");
  fail = false;
  assert.equal((await c.commit({ type: "replace", id: "new", objective: "   " }, 0)).kind, "error");
  assert.equal(c.current()!.goal.id, "old");
});

test("sparse usage entries serialize undefined as zero while preserving explicit null", async () => {
  const entries: Entry[] = [];
  const c = createGoalCommit({ readBranch: () => entries, append: entry => { entries.push(entry); } });
  await c.commit(create, 0);
  await c.commit({ type: "usage", input: 3, cacheRead: null }, 1);
  const usage = entries.find(entry => entry.type === "goal.usage") as Extract<Entry, { type: "goal.usage" }>;
  assert.deepEqual(usage, { type: "goal.usage", version: 1, seq: 2, input: 3, output: 0, cacheRead: null, cacheWrite: 0, unknownMessages: 0 });
  const replayed = createGoalCommit({ readBranch: () => entries, append: () => {} }).current()!.goal;
  assert.deepEqual(replayed.usage, { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 1 });
  assert.deepEqual(replayed.usage, c.current()!.goal.usage);
});
