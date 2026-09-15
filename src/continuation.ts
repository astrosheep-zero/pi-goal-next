import { limitsExceeded } from "./goal.ts";
import type { Goal, Intent } from "./goal.ts";
import type { CommitResult, GoalSnapshot } from "./goal-commit.ts";

export type ContinuationDeps = {
  getSnapshot(): GoalSnapshot | null;
  commit(intent: Intent, expectedRevision: number): Promise<CommitResult>;
  send(message: {
    customType: "pi-goal-next/continuation";
    content: string;
    display: false;
    details: { goalId: string; generation: number; seq: number };
  }, options: { triggerTurn: true }): void;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  buildPrompt(goal: Goal): string;
};

export type Continuation = {
  invalidate(): void;
  onSettled(): Promise<void>;
  onMessageStart(message: unknown): Promise<void>;
  hadStaleTurn(): boolean;
};

export function createContinuation(deps: ContinuationDeps): Continuation {
  let generation = 0;
  let staleObserved = false;
  const staleKeys = new Set<string>();

  function invalidate(): void {
    generation += 1;
  }

  async function onSettled(): Promise<void> {
    if (!deps.isIdle() || deps.hasPendingMessages()) return;
    const snapshot = deps.getSnapshot();
    if (!snapshot || snapshot.goal.status !== "active") return;
    const { goal, revision } = snapshot;
    if (limitsExceeded(goal)) return;

    const leaseGeneration = generation;
    const seq = goal.continuationSeq + 1;
    const result = await deps.commit({ type: "continuation_sent", generation: leaseGeneration }, revision);
    if (result.kind !== "ok" || generation !== leaseGeneration) return;
    const latest = deps.getSnapshot();
    if (!latest || latest.goal.id !== goal.id || latest.goal.status !== "active") return; // user may have cleared/paused during the commit await

    deps.send({
      customType: "pi-goal-next/continuation",
      content: deps.buildPrompt(goal),
      display: false,
      details: { goalId: goal.id, generation: leaseGeneration, seq }
    }, { triggerTurn: true });
  }

  async function onMessageStart(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const m = message as { role?: unknown; customType?: unknown; details?: unknown };
    if (m.role !== "custom" || m.customType !== "pi-goal-next/continuation" || !m.details || typeof m.details !== "object") return;
    const details = m.details as { goalId?: unknown; generation?: unknown };
    if (typeof details.goalId !== "string" || !Number.isInteger(details.generation)) return;
    if ((details.generation as number) >= generation) return;
    const key = `${details.goalId}:${details.generation}`;
    if (staleKeys.has(key)) return;
    staleKeys.add(key);
    staleObserved = true;
    const snapshot = deps.getSnapshot();
    if (snapshot) await deps.commit({ type: "stale_turn", generation: details.generation as number }, snapshot.revision);
    // Pi cannot retract an already-sent message; a stale turn may still run.
  }

  return {
    invalidate,
    onSettled,
    onMessageStart,
    hadStaleTurn: () => staleObserved
  };
}
