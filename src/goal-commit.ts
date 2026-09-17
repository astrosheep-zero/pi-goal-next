import { fold, transition } from "./goal.ts";
import type { Entry, Goal, Intent } from "./goal.ts";

export type GoalSnapshot = { goal: Goal; revision: number };
export type GoalStore = {
  readBranch(): readonly Entry[];
  append(entry: Entry): Promise<void> | void;
};
export type CommitResult =
  | { kind: "ok"; snapshot: GoalSnapshot | null }
  | { kind: "conflict"; snapshot: GoalSnapshot | null }
  | { kind: "error"; error: unknown };
export type GoalCommitLike = Pick<ReturnType<typeof createGoalCommit>, "current" | "commit" | "getRevision">;

export function createGoalCommit(store: GoalStore) {
  let bootstrapped = false;
  let goal: Goal | null = null;
  let revision = 0;
  let sequence = 0;
  let pending = false;
  const subscribers = new Set<(snapshot: GoalSnapshot | null) => void>();

  function bootstrap(): void {
    if (bootstrapped) return;
    const entries = store.readBranch();
    goal = fold(entries);
    sequence = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    revision = 0;
    bootstrapped = true;
  }

  function current(): GoalSnapshot | null {
    bootstrap();
    return goal ? { goal, revision } : null;
  }

  function getRevision(): number { bootstrap(); return revision; }

  function entryFor(intent: Intent, next: Goal | null, previous: Goal | null): Entry {
    const seq = ++sequence;
    switch (intent.type) {
      case "create": return { type: "goal.created", version: 1, seq, goal: next! };
      case "replace": return { type: "goal.replaced", version: 1, seq, goal: next! };
      case "update_objective": return { type: "goal.objective_updated", version: 1, seq, objective: intent.objective };
      case "clear": return { type: "goal.cleared", version: 1, seq };
      case "transition": return { type: "goal.transition", version: 1, seq, from: previous!.status, to: intent.to, by: intent.by, ...(intent.userRequest ? { userRequest: intent.userRequest } : {}), ...(intent.resetContinuations ? { resetContinuations: true } : {}) };
      case "usage": return { type: "goal.usage", version: 1, seq, input: intent.input === undefined ? 0 : intent.input, output: intent.output === undefined ? 0 : intent.output, cacheRead: intent.cacheRead === undefined ? 0 : intent.cacheRead, cacheWrite: intent.cacheWrite === undefined ? 0 : intent.cacheWrite, unknownMessages: intent.unknownMessages ?? 0 };
      case "continuation_sent": return { type: "goal.continuation_sent", version: 1, seq, generation: intent.generation };
      case "stale_turn": return { type: "goal.stale_turn", version: 1, seq, generation: intent.generation };
      case "limit_config": return { type: "goal.limit_config", version: 1, seq, tokenBudget: intent.tokenBudget, maxContinuations: intent.maxContinuations };
    }
  }

  async function commit(intent: Intent, expectedRevision: number): Promise<CommitResult> {
    bootstrap();
    const snapshot = goal ? { goal, revision } : null;
    if (pending || revision !== expectedRevision) return { kind: "conflict", snapshot };
    let next: Goal | null;
    try {
      next = transition(goal, intent);
    } catch (error) {
      return { kind: "error", error };
    }
    const entry = entryFor(intent, next, goal);
    pending = true;
    try {
      await store.append(entry);
    } catch (error) {
      pending = false;
      sequence--;
      return { kind: "error", error };
    }
    pending = false;
    goal = next;
    revision++;
    const result = goal ? { goal, revision } : null;
    for (const subscriber of subscribers) subscriber(result);
    return { kind: "ok", snapshot: result };
  }

  function subscribe(fn: (snapshot: GoalSnapshot | null) => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function rebuild(): void {
    bootstrapped = false;
    goal = null;
    revision = 0;
    sequence = 0;
    bootstrap();
    const snapshot = goal ? { goal, revision } : null;
    for (const subscriber of subscribers) subscriber(snapshot);
  }

  return { current, getRevision, commit, subscribe, rebuild };
}
