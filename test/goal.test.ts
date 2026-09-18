import test from "node:test"; import assert from "node:assert/strict"; import { transition, fold, summarize, GoalError } from "../src/goal.ts"; import type { Entry, Goal } from "../src/goal.ts";
test("create and legal transitions", () => { const created = transition(null, {type:"create", id:"1", objective:"do it"}); assert.ok(created); let g: Goal = created; assert.equal(g.status,"active"); g=transition(g,{type:"transition",to:"paused",by:"user",userRequest:"stop"})!; g=transition(g,{type:"transition",to:"active",by:"system"})!; g=transition(g,{type:"transition",to:"blocked",by:"agent"})!; g=transition(g,{type:"transition",to:"active",by:"system"})!; g=transition(g,{type:"transition",to:"budget_limited",by:"system"})!; g=transition(g,{type:"transition",to:"active",by:"system"})!; g=transition(g,{type:"transition",to:"complete",by:"agent"})!; assert.match(summarize(g),/complete/); });
test("illegal transitions throw", () => { assert.throws(()=>transition(null,{type:"transition",to:"active",by:"system"}),GoalError); const g=transition(null,{type:"create",id:"1",objective:"x"})!; assert.throws(()=>transition(g,{type:"transition",to:"active",by:"agent"}),GoalError); assert.throws(()=>transition(g,{type:"create",id:"2",objective:"y"}),GoalError); });
test("agent can pause at the user's explicit request but not complete a paused goal", () => { const g=transition(null,{type:"create",id:"1",objective:"x"})!; const paused=transition(g,{type:"transition",to:"paused",by:"agent"})!; assert.equal(paused.status,"paused"); assert.throws(()=>transition(paused,{type:"transition",to:"complete",by:"agent"}),GoalError); });
test("agent cannot complete paused or blocked goal", () => { let g=transition(null,{type:"create",id:"1",objective:"x"})!; g=transition(g,{type:"transition",to:"paused",by:"user",userRequest:"wait"})!; assert.throws(()=>transition(g,{type:"transition",to:"complete",by:"agent"}),GoalError); g=transition(g,{type:"transition",to:"blocked",by:"system"})!; assert.throws(()=>transition(g,{type:"transition",to:"complete",by:"agent"}),GoalError); });
test("usage folds, counts nulls, and flips budget", () => { const created = transition(null,{type:"create",id:"1",objective:"x",tokenBudget:10,maxContinuations:25}); assert.ok(created); let g: Goal = created; g=transition(g,{type:"usage",input:4,output:3,cacheRead:null,cacheWrite:1})!; assert.deepEqual(g.usage,{input:4,output:3,cacheRead:0,cacheWrite:1,unknownMessages:1}); assert.equal(g.status,"active"); g=transition(g,{type:"usage",input:2,output:0,cacheRead:0,cacheWrite:0})!; assert.equal(g.status,"budget_limited"); assert.match(summarize(g),/usage in=6 out=3 cacheRead=0 cacheWrite=1 unknown=1/); });
test("continuation arithmetic limit uses budget_limited", () => { const created = transition(null,{type:"create",id:"1",objective:"x",maxContinuations:1}); assert.ok(created); let g: Goal = created; g=transition(g,{type:"continuation_sent",generation:1})!; g=transition(g,{type:"usage",input:0,output:0,cacheRead:0,cacheWrite:0})!; assert.equal(g.status,"budget_limited"); });
test("fold replay and clear",()=>{const created=transition(null,{type:"create",id:"a",objective:"x"}); assert.ok(created); const es: Entry[]=[{type:"goal.created",version:1,seq:1,goal:created},{type:"goal.usage",version:1,seq:2,input:2,output:3,cacheRead:null,cacheWrite:0,unknownMessages:0},{type:"goal.transition",version:1,seq:3,from:"active",to:"complete",by:"agent"}]; assert.deepEqual(fold(es),fold(es)); assert.deepEqual(fold(es)?.usage,{input:2,output:3,cacheRead:0,cacheWrite:0,unknownMessages:1}); es.push({type:"goal.cleared",version:1,seq:4}); assert.equal(fold(es),null);});
test("usage seconds accumulate and omitted seconds add zero", () => {
  let g = transition(null, { type: "create", id: "time", objective: "x" })!;
  g = transition(g, { type: "usage", input: 1, seconds: 4 })!;
  assert.equal(g.timeUsedSeconds, 4);
  g = transition(g, { type: "usage", output: 2 })!;
  assert.equal(g.timeUsedSeconds, 4);
  assert.match(summarize(g), /time 4s/);
});

test("usage seconds reject negative and non-integer values", () => {
  const g = transition(null, { type: "create", id: "time", objective: "x" })!;
  for (const seconds of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => transition(g, { type: "usage", seconds }), (error: unknown) => error instanceof GoalError && error.code === "invalid");
  }
});

test("fold replays usage seconds and normalizes a legacy created snapshot", () => {
  const created = transition(null, { type: "create", id: "legacy", objective: "x" })!;
  const legacy = { ...created } as Record<string, unknown>;
  delete legacy.timeUsedSeconds;
  const entries: Entry[] = [
    { type: "goal.created", version: 1, seq: 1, goal: legacy as any },
    { type: "goal.usage", version: 1, seq: 2, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0, seconds: 7 },
    { type: "goal.usage", version: 1, seq: 3, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 },
  ];
  const folded = fold(entries)!;
  assert.equal(folded.timeUsedSeconds, 7);
  assert.equal(folded.usage.input, 0);
});
