import { budgetLimitPrompt } from "./prompts.ts";
import type { Message } from "./accounting.ts";
import type { GoalSnapshot, CommitResult } from "./goal-commit.ts";
import type { Intent } from "./goal.ts";
import { createAccounting } from "./accounting.ts";
import type { Continuation } from "./continuation.ts";
import type { MessageEndEvent, MessageStartEvent, InputEvent, AgentSettledEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

export type LifecycleDeps = {
  goalCommit: { current(): GoalSnapshot | null; commit(intent: Intent, expectedRevision: number): Promise<CommitResult> };
  accounting: ReturnType<typeof createAccounting>;
  continuation: Continuation;
  send(message: { customType: string; content: string; display: false; details?: unknown }, options: { triggerTurn: true }): void;
  rebuild(): void;
};

export type PiEvents = { on(name: string, handler: (event: any, ctx: any) => unknown): void };
export function registerLifecycle(pi: PiEvents, deps: LifecycleDeps): void {
  async function commitWithRetry(intent: Intent, attempts = 3, expectedGoalId?: string): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      const snapshot = deps.goalCommit.current();
      if (!snapshot || (expectedGoalId !== undefined && snapshot.goal.id !== expectedGoalId)) return false;
      const result = await deps.goalCommit.commit(intent, snapshot.revision);
      if (result.kind === "ok") return true;
      if (result.kind === "error") return false;
    }
    return false;
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
  // Keep ownership through completion so its remaining tool results/final reply
  // count, but never transfer an old run's usage to a replacement goal.
  let accountingGoalId: string | null = null;
  let startGoalId: string | null = null;
  const pendingUsage = new Map<string, { goalId: string; message: Message }>();
  let usageFlush: Promise<boolean> | undefined;
  async function flushUsage(): Promise<boolean> {
    if (usageFlush) return usageFlush;
    usageFlush = (async () => {
      for (const [id, item] of pendingUsage) {
        if (deps.goalCommit.current()?.goal.id !== item.goalId) { pendingUsage.delete(id); continue; }
        const delta = deps.accounting.previewMessage(item.message);
        if (!await commitWithRetry({ type: "usage", ...delta }, 3, item.goalId)) return false;
        deps.accounting.recordMessage(item.message);
        pendingUsage.delete(id);
      }
      return true;
    })();
    try { return await usageFlush; } finally { usageFlush = undefined; }
  }
  const eligibleGoalId = () => {
    const goal = deps.goalCommit.current()?.goal;
    return goal && (goal.status === "active" || goal.status === "budget_limited") ? goal.id : null;
  };
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
    startGoalId = deps.goalCommit.current()?.goal.id ?? null;
    accountingGoalId = eligibleGoalId();
  });

  pi.on("session_start", async (_event: SessionStartEvent, ctx: any) => {
    invalidate();
    inputPending = false;
    accountingGoalId = null;
    startGoalId = null;
    pendingUsage.clear();
    await bootstrap();
    const snapshot = deps.goalCommit.current();
    if (snapshot?.goal?.status === "active") {
      await commitWithRetry({ type: "transition", to: "paused", by: "system", userRequest: "session restored; explicit resume required" });
    }
  });

  pi.on("session_before_tree", async (_event: any, ctx: any) => {
    invalidate();
    inputPending = false;
    accountingGoalId = null;
    startGoalId = null;
    pendingUsage.clear();
    pendingRebuild = true;
    // Pi's tree hook does not expose the post-navigation branch; rebuild on the next event.
    void ctx;
  });

  const before = async (_ctx: any) => { if (pendingRebuild) { pendingRebuild = false; await bootstrap(); } };
  pi.on("message_end", async (event: MessageEndEvent, ctx: any) => {
    await before(ctx);
    const m = event.message;
    if (m.role !== "assistant" && m.role !== "toolResult") return;
    if (m.role === "assistant") lastAssistantStop = m.stopReason;
    // A create_goal tool can establish ownership after agent_start.
    const eligible = eligibleGoalId();
    if (!accountingGoalId && (!startGoalId || startGoalId === eligible)) accountingGoalId = eligible;
    if (!accountingGoalId || deps.goalCommit.current()?.goal.id !== accountingGoalId) return;
    let entryId = messageIds.get(m);
    if (!entryId) { entryId = `live-message:${++messageSeq}`; messageIds.set(m, entryId); }
    const message: Message = { ...m, entryId };
    if (!deps.accounting.hasMessage(entryId)) pendingUsage.set(entryId, { goalId: accountingGoalId, message });
    await flushUsage();
  });
  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx: any) => {
    await before(ctx);
    if (!await flushUsage()) return; // No automatic work while usage persistence is unresolved.
    accountingGoalId = null;
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
    if (event.message.role === "user") {
      inputPending = false;
      invalidate();
      startGoalId = deps.goalCommit.current()?.goal.id ?? null;
      accountingGoalId = eligibleGoalId();
    }
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
