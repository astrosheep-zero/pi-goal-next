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

function branchTail(ctx: any): any[] {
  const branch = ctx?.sessionManager?.getBranch?.();
  return Array.isArray(branch) ? branch : [];
}

function messageFromEvent(event: any, ctx: any): Message | null {
  const message = event?.message ?? event;
  if (!message || (message.role !== "assistant" && message.role !== "toolResult")) return null;
  const tail = branchTail(ctx);
  const candidate = [...tail].reverse().find((entry: any) => {
    const m = entry?.message ?? entry;
    return m?.role === message.role;
  });
  const m = candidate?.message ?? candidate ?? message;
  const entryId = m?.id ?? m?.entryId ?? message.id ?? message.entryId;
  // Entry identity is heuristic-by-position because branch entries may omit message ids.
  return typeof entryId === "string"
    ? { entryId, role: message.role, usage: m?.usage ?? message.usage, toolName: m?.toolName ?? message.toolName, stopReason: m?.stopReason ?? message.stopReason }
    : null;
}

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

  pi.on("session_start", async (_event: SessionStartEvent, ctx: any) => {
    await bootstrap();
    const snapshot = deps.goalCommit.current();
    if (snapshot?.goal?.status === "active") {
      await commitWithRetry({ type: "transition", to: "paused", by: "system", userRequest: "session restored; explicit resume required" });
    }
  });

  pi.on("session_before_tree", async (_event: any, ctx: any) => {
    deps.continuation.invalidate();
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
    const message = messageFromEvent(event, ctx);
    if (!message) return;
    if (message.role === "assistant") lastAssistantStop = message.stopReason;
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
    const verdict = deps.accounting.settleTurn(snapshot.goal);
    if (verdict.kind !== "ok") {
      const latest = deps.goalCommit.current();
      if (latest && latest.goal.status !== verdict.kind) await commitWithRetry({ type: "transition", to: verdict.kind, by: "system" });
    }
    const latest = deps.goalCommit.current();
    if (!latest) { steeredGoalId = null; steered = false; return; }
    const goal = latest.goal;
    if (goal.id !== steeredGoalId) { steeredGoalId = goal.id; steered = false; }
    if (goal.status === "budget_limited" && !steered) {
      steered = true;
      deps.send({ customType: "pi-goal-next/budget_limit", content: budgetLimitPrompt(goal), display: false, details: { goalId: goal.id } }, { triggerTurn: true });
    }
    // Error/aborted turns produced no completed work; only continue after a normally-finished turn (Codex parity).
    if (lastAssistantStop === "error" || lastAssistantStop === "aborted") return;
    await deps.continuation.onSettled();
  });
  pi.on("message_start", async (event: MessageStartEvent, ctx: any) => { await before(ctx); await deps.continuation.onMessageStart(event?.message ?? event); });
  pi.on("input", async (_event: InputEvent, ctx: any) => { await before(ctx); });
}
