import assert from "node:assert/strict";
import test from "node:test";
import { createGoalClock } from "../src/clock.ts";

test("starts only on active goals and stops on pause, completion, or null", () => {
  let now = 0;
  const clock = createGoalClock(() => now);
  assert.equal(clock.peek("g"), 0);
  clock.sync({ id: "g", status: "paused" });
  now = 5000;
  assert.equal(clock.peek("g"), 0);
  clock.sync({ id: "g", status: "active" });
  now = 6500;
  assert.equal(clock.peek("g"), 1);
  clock.sync({ id: "g", status: "complete" });
  now = 10000;
  assert.equal(clock.peek("g"), 0);
  clock.sync(null);
  assert.equal(clock.peek("g"), 0);
});

test("re-bases when the active goal id changes", () => {
  let now = 1000;
  const clock = createGoalClock(() => now);
  clock.sync({ id: "old", status: "active" });
  now += 5000;
  clock.sync({ id: "new", status: "active" });
  assert.equal(clock.peek("old"), 0);
  assert.equal(clock.peek("new"), 0);
  now += 2200;
  assert.equal(clock.peek("new"), 2);
});

test("peek floors whole seconds and returns zero for another goal", () => {
  let now = 0;
  const clock = createGoalClock(() => now);
  clock.sync({ id: "g", status: "active" });
  now = 3999;
  assert.equal(clock.peek("g"), 3);
  assert.equal(clock.peek("other"), 0);
});

test("markAccounted advances the baseline", () => {
  let now = 0;
  const clock = createGoalClock(() => now);
  clock.sync({ id: "g", status: "active" });
  now = 3500;
  assert.equal(clock.peek("g"), 3);
  clock.markAccounted("g");
  assert.equal(clock.peek("g"), 0);
  now += 1100;
  assert.equal(clock.peek("g"), 1);
});

test("reset stops the clock", () => {
  let now = 0;
  const clock = createGoalClock(() => now);
  clock.sync({ id: "g", status: "active" });
  now = 2000;
  clock.reset();
  assert.equal(clock.peek("g"), 0);
});
