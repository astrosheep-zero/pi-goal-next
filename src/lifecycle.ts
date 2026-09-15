import { summarize } from "./goal.ts";
import { budgetLimitPrompt } from "./prompts.ts";
import type { Message } from "./accounting.ts";
import type { GoalSnapshot, CommitResult } from "./goal-commit.ts";
import type { Intent } from "./goal.ts";
import { createAccounting } from "./accounting.ts";
import type { Continuation } from "./continuation.ts";
import type { SessionBeforeCompactEvent, MessageEndEvent, MessageStartEvent, InputEvent, AgentSettledEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

export type LifecycleDeps = {
  goalCommit: { current(): GoalSnapshot | null; commit(intent: Intent, expectedRevision: number): Promise<CommitResult> };
  accounting: ReturnType<typeof createAccounting>;
  continuation: Continuation;
  send(message: { customType: string; content: string; display: false; details?: unknown }, options: { triggerTurn: true }): void;
  rebuild(): void;
};

export type PiEvents = { on(name: string, handler: (event: any, ctx: any) => unknown): void };
export function registerLifecycle(pi: PiEvents, deps: LifecycleDeps): void {
  async function commitWithRetry(intent: Intent, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const snapshot = deps.goalCommit.current();
      if (!snapshot) return;
      const result = await deps.goalCommit.commit(intent, snapshot.revision);
      if (result.kind !== "conflict") return;
    }
  }
  let pendingRebuild = false;
  const bootstrap = () => deps.rebuild();
  // Budget-limit steering is sent once per goal instance; reset on null branch or a new goal id.
  let steeredGoalId: string | null = null;
  let steered = false;
  // Stop reason of the most recent assistant turn; gates continuation on normal completion.
  let lastAssistantStop: string | undefined;
  let epoch = 0;
  let inputPending = false;
  let runSignal: AbortSignal | undefined;
  // message_end precedes SessionManager.appendMessage. Its object is authoritative;
  // no persisted entry ID exists yet. Deduplicate live events by object identity.
  const messageIds = new WeakMap<object, string>();
  let messageSeq = 0;
  const invalidate = () => {
    epoch += 1;
    lastAssistantStop = undefined;
    deps.continuation.invalidate();
  };
  pi.on("agent_start", (_event: unknown, ctx: any) => {
    epoch += 1;
    lastAssistantStop = undefined;
    // Retain the signal: ctx.signal becomes undefined once the run is idle.
    runSignal = ctx.signal;
  });

  pi.on("session_start", async (_event: SessionStartEvent, ctx: any) => {
    invalidate();
    inputPending = false;
    await bootstrap();
    const snapshot = deps.goalCommit.current();
    if (snapshot?.goal?.status === "active") {
      await commitWithRetry({ type: "transition", to: "paused", by: "system", userRequest: "session restored; explicit resume required" });
    }
  });

  pi.on("session_before_tree", async (_event: any, ctx: any) => {
    invalidate();
    inputPending = false;
    pendingRebuild = true;
    // Pi's tree hook does not expose the post-navigation branch; rebuild on the next event.
    void ctx;
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, _ctx: any) => {
    const snapshot = deps.goalCommit.current();
    if (!snapshot) return;
    if (event?.preparation?.firstKeptEntryId && Number.isFinite(event.preparation.tokensBefore)) {
      return { compaction: { summary: summarize(snapshot.goal), firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
    }
    // Older Pi hooks may not support extension-provided compaction content.
    return;
  });

  const before = async (_ctx: any) => { if (pendingRebuild) { pendingRebuild = false; await bootstrap(); } };
  pi.on("message_end", async (event: MessageEndEvent, ctx: any) => {
    await before(ctx);
    const m = event.message;
    if (m.role !== "assistant" && m.role !== "toolResult") return;
    if (m.role === "assistant") lastAssistantStop = m.stopReason;
    let entryId = messageIds.get(m);
    if (!entryId) { entryId = `live-message:${++messageSeq}`; messageIds.set(m, entryId); }
    const message: Message = { ...m, entryId };
    const recorded = deps.accounting.recordMessage(message);
    if (recorded && !recorded.duplicate) {
      const delta = recorded.delta;
      await commitWithRetry({ type: "usage", input: delta.input, output: delta.output, cacheRead: delta.cacheRead, cacheWrite: delta.cacheWrite, unknownMessages: delta.unknownMessages });
    }
  });
  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx: any) => {
    await before(ctx);
    const snapshot = deps.goalCommit.current();
    if (!snapshot) { steeredGoalId = null; steered = false; return; }
    const settledEpoch = epoch;
    const settledSignal = runSignal;
    const canSend = () => epoch === settledEpoch && !settledSignal?.aborted && !inputPending && ctx.isIdle() && !ctx.hasPendingMessages();
    // Only a fresh normal completion can authorize automatic work. Consume it
    // once: duplicate settled events and tool-boundary aborts cannot restart us.
    const stop = lastAssistantStop;
    lastAssistantStop = undefined;
    if ((stop !== "stop" && stop !== "length") || !canSend()) return;
    if (snapshot.goal.status !== "active" && snapshot.goal.status !== "budget_limited") return;
    const verdict = deps.accounting.settleTurn(snapshot.goal);
    if (verdict.kind !== "ok") {
      const latest = deps.goalCommit.current();
      if (latest && latest.goal.status !== verdict.kind) await commitWithRetry({ type: "transition", to: verdict.kind, by: "system" });
    }
    if (!canSend()) return;
    const latest = deps.goalCommit.current();
    if (!latest) { steeredGoalId = null; steered = false; return; }
    const goal = latest.goal;
    if (goal.id !== steeredGoalId) { steeredGoalId = goal.id; steered = false; }
    if (goal.status === "budget_limited" && !steered) {
      steered = true;
      deps.send({ customType: "pi-goal-next/budget_limit", content: budgetLimitPrompt(goal), display: false, details: { goalId: goal.id } }, { triggerTurn: true });
    }
    await deps.continuation.onSettled(canSend);
  });
  pi.on("message_start", async (event: MessageStartEvent, ctx: any) => {
    if (event.message.role === "user") { inputPending = false; invalidate(); }
    await before(ctx);
    await deps.continuation.onMessageStart(event.message);
  });
  pi.on("input", async (_event: InputEvent, ctx: any) => {
    // Runs before Pi queues the input, so hasPendingMessages alone is too late.
    inputPending = true;
    invalidate();
    await before(ctx);
  });
}
