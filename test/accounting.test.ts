import test from "node:test";
import assert from "node:assert/strict";
import { createAccounting } from "../src/accounting.ts";
import { transition } from "../src/goal.ts";

const goal = (opts: any = {}) => transition(null, { type: "create", id: "g", objective: "x", ...opts })!;

test("dedupes messages by entry id and attributes usage", () => {
  const a = createAccounting();
  const first = a.recordMessage({ entryId: "1", role: "assistant", usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 1 } })!;
  assert.equal(first.duplicate, false);
  assert.equal(a.recordMessage({ entryId: "1", role: "assistant", usage: { input: 99 } })!.duplicate, true);
  assert.deepEqual(first.delta, { input: 2, output: 3, cacheRead: 4, cacheWrite: 1, unknownMessages: 0, stale: false });
});

test("missing usage is unknown and nested toolResult usage counts", () => {
  const a = createAccounting();
  assert.equal(a.recordMessage({ entryId: "u", role: "toolResult" })!.delta.unknownMessages, 1);
  const d = a.recordMessage({ entryId: "sub", role: "toolResult", usage: { input: 5, output: 7 } })!.delta;
  assert.equal(d.input + d.output, 12);
});

test("settles arithmetic limits", () => {
  const a = createAccounting();
  assert.equal(a.settleTurn(goal({ tokenBudget: 10 })).kind, "ok");
  const limited = goal({ tokenBudget: 10 });
  limited.usage.input = 10;
  assert.equal(a.settleTurn(limited).kind, "budget_limited");
});

test("stale flagging", () => {
  const a = createAccounting();
  a.recordMessage({ entryId: "x", role: "assistant", usage: { input: 1 }, toolName: "search" });
  a.recordStale("x");
  assert.match(a.summary(goal()), /stale=1/);
});

test("final completing turn can be accounted", () => {
  const a = createAccounting();
  const d = a.recordMessage({ entryId: "final", role: "assistant", usage: { input: 3, output: 4 } })!;
  const g = goal();
  g.usage.input += d.delta.input;
  g.usage.output += d.delta.output;
  g.status = "complete";
  assert.match(a.summary(g), /input=3 output=4/);
});
