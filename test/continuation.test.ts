import assert from "node:assert/strict";
import test from "node:test";
import { createContinuation, type ContinuationDeps } from "../src/continuation.ts";
import type { Goal } from "../src/goal.ts";

function goal(overrides: Partial<Goal> = {}): Goal {
  return { id: "g1", objective: "do it", status: "active", tokenBudget: null, maxContinuations: 3, continuationSeq: 0, createdAt: 1, updatedAt: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 }, ...overrides };
}
function harness(g = goal()) {
  let snapshot: { goal: Goal; revision: number } | null = { goal: g, revision: 0 };
  const sent: unknown[] = [], commits: unknown[] = [];
  let idle = true, pending = false, nextResult: any = { kind: "ok", snapshot: null };
  let blocked = false;
  let release: (() => void) | undefined;
  const deps: ContinuationDeps = {
    getSnapshot: () => snapshot,
    commit: async (intent, revision) => { commits.push({ intent, revision }); if (blocked) await new Promise<void>(r => { release = r; }); if (nextResult.kind === "ok") { snapshot = snapshot && { goal: { ...snapshot.goal, continuationSeq: intent.type === "continuation_sent" ? snapshot.goal.continuationSeq + 1 : snapshot.goal.continuationSeq }, revision: revision + 1 }; } return nextResult; },
    send: message => sent.push(message), isIdle: () => idle, hasPendingMessages: () => pending, buildPrompt: () => "prompt"
  };
  return { deps, sent, commits, setIdle: (v: boolean) => { idle = v; }, setPending: (v: boolean) => { pending = v; }, setResult: (v: any) => { nextResult = v; }, setStatus: (status: Goal["status"]) => { if (snapshot) snapshot = { goal: { ...snapshot.goal, status }, revision: snapshot.revision }; }, blockCommit: () => { blocked = true; return () => { blocked = false; release?.(); }; } };
}

test("sends only after successful commit", async () => { const h = harness(); const c = createContinuation(h.deps); await c.onSettled(); assert.equal(h.sent.length, 1); });
test("conflict abandons without send", async () => { const h = harness(); h.setResult({ kind: "conflict", snapshot: null }); await createContinuation(h.deps).onSettled(); assert.equal(h.sent.length, 0); });
test("generation fencing prevents send after invalidation", async () => { const h = harness(); const c = createContinuation(h.deps); const release = h.blockCommit(); const run = c.onSettled(); await Promise.resolve(); c.invalidate(); release(); await run; assert.equal(h.sent.length, 0); });
test("paused during commit await suppresses send", async () => { const h = harness(); const release = h.blockCommit(); const run = createContinuation(h.deps).onSettled(); await Promise.resolve(); h.setStatus("paused"); release(); await run; assert.equal(h.sent.length, 0); });
test("stale continuation message is recorded once", async () => { const h = harness(); const c = createContinuation(h.deps); c.invalidate(); const message = { role: "custom", customType: "pi-goal-next/continuation", details: { goalId: "g1", generation: 0 } }; await c.onMessageStart(message); await c.onMessageStart(message); assert.equal(h.commits.length, 1); assert.equal(c.hadStaleTurn(), true); await c.onMessageStart({ ...message, details: { goalId: "g1", generation: 1 } }); assert.equal(h.commits.length, 1); });
test("idle, pending, and arithmetic limits guard", async () => { const h = harness(); const c = createContinuation(h.deps); h.setIdle(false); await c.onSettled(); h.setIdle(true); h.setPending(true); await c.onSettled(); h.setPending(false); const limited = harness(goal({ maxContinuations: 0 })); await createContinuation(limited.deps).onSettled(); assert.equal(h.sent.length, 0); assert.equal(limited.sent.length, 0); });
