import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/index.ts";
import { transition, type Goal } from "../src/goal.ts";
import type { GoalSnapshot } from "../src/goal-commit.ts";
import { formatStatus } from "../src/ui.ts";
import { createFakePi } from "./support/fake-pi.ts";

async function setup() {
  const fake = createFakePi();
  const notifications: { message: string; level: string }[] = [];
  fake.ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });
  extension(fake.pi);
  await fake.emit("session_start");
  await fake.registrations.tools.find(t => t.name === "create_goal").execute("create", { objective: "work" });
  return { ...fake, notifications };
}

async function settleNormally(fake: Awaited<ReturnType<typeof setup>>) {
  await fake.emit("agent_start");
  await fake.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 1 } } });
  await fake.emit("agent_settled");
}

test("each delivered continuation notifies in English with its turn count", async () => {
  const h = await setup();
  for (let turn = 1; turn <= 2; turn++) {
    await settleNormally(h);
    assert.equal(h.notifications.length, turn - 1); // Sending alone is not delivery.
    const message = h.sentMessages[turn - 1].message;
    await h.emit("message_start", { message: { role: "custom", ...message } });
    assert.deepEqual(h.notifications[turn - 1], { message: `Goal continuing (turn ${turn}/32).`, level: "info" });
  }
  assert.equal(h.ctx.ui.statuses.get("pi-goal-next"), "⚑\uFE0E"); // turn 2/32
});

test("aborted or fenced continuation attempts and unrelated messages do not notify", async () => {
  const h = await setup();
  await h.emit("agent_start");
  await h.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 1 } } });
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.sentMessages.length, 0);

  const append = h.pi.appendEntry;
  h.pi.appendEntry = async (customType: string, data: any) => {
    await append(customType, data);
    if (data.type === "goal.continuation_sent") h.setPendingMessages(true);
  };
  await settleNormally(h);
  assert.equal(h.sentMessages.length, 0); // Commit succeeded; post-commit fence blocked delivery.
  assert.equal(h.ctx.ui.statuses.get("pi-goal-next"), "⚑\uFE0E"); // turn 1/32
  await h.emit("message_start", { message: { role: "user", content: "hi" } });
  await h.emit("message_start", { message: { role: "custom", customType: "pi-goal-next/objective_updated", details: {} } });
  assert.equal(h.notifications.length, 0);
});

test("status text is a single state glyph", () => {
  const snap = (over: Partial<Goal>): GoalSnapshot => ({ goal: { ...transition(null, { type: "create", id: "1", objective: "do it" })!, ...over }, revision: 0 });
  assert.equal(formatStatus(snap({})), "⚑\uFE0E");
  assert.equal(formatStatus(snap({ status: "paused" })), "⏸\uFE0E");
  assert.equal(formatStatus(snap({ status: "blocked" })), "⊘");
  assert.equal(formatStatus(snap({ status: "budget_limited" })), "⚠\uFE0E");
});

test("status line clears when the goal completes", async () => {
  const h = await setup();
  assert.ok(h.ctx.ui.statuses.has("pi-goal-next"));
  await h.registrations.tools.find(t => t.name === "update_goal")!.execute("upd", { status: "complete" });
  assert.equal(h.ctx.ui.statuses.has("pi-goal-next"), false);
});
