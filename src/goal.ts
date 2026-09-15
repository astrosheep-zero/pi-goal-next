export type Status = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export type Actor = "user" | "agent" | "system";
export type Goal = {
  id: string; objective: string; status: Status; tokenBudget: number | null;
  maxContinuations: number; continuationSeq: number; createdAt: number; updatedAt: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; unknownMessages: number };
};
export type Entry =
  | { type: "goal.created"; version: 1; seq: number; goal: Goal }
  | { type: "goal.transition"; version: 1; seq: number; from: Status; to: Status; by: Actor; userRequest?: string; resetContinuations?: boolean }
  | { type: "goal.cleared"; version: 1; seq: number }
  | { type: "goal.usage"; version: 1; seq: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; unknownMessages: number }
  | { type: "goal.continuation_sent"; version: 1; seq: number; generation: number }
  | { type: "goal.stale_turn"; version: 1; seq: number; generation: number }
  | { type: "goal.limit_config"; version: 1; seq: number; tokenBudget: number | null; maxContinuations: number };
export type Intent =
  | { type: "create"; id: string; objective: string; tokenBudget?: number | null; maxContinuations?: number }
  | { type: "transition"; to: Status; by: Actor; userRequest?: string; resetContinuations?: boolean }
  | { type: "clear" }
  | { type: "usage"; input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null; unknownMessages?: number }
  | { type: "continuation_sent"; generation: number }
  | { type: "stale_turn"; generation: number }
  | { type: "limit_config"; tokenBudget: number | null; maxContinuations: number };
export class GoalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = "GoalError"; }
}
const statuses: readonly Status[] = ["active", "paused", "blocked", "budget_limited", "complete"];
const unfinished = (s: Status) => s !== "complete";
const usageKeys = ["input", "output", "cacheRead", "cacheWrite"] as const;
type UsageKey = typeof usageKeys[number];
function safeDelta(value: number | null | undefined, name: string): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new GoalError("invalid", `${name} must be a non-negative safe integer`);
  return value;
}
function safeAdd(a: number, b: number, name: string): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new GoalError("invalid", `${name} exceeds safe integer range`);
  return result;
}
export function transition(state: Goal | null, intent: Intent): Goal | null {
  if (intent.type === "create") {
    if (state && unfinished(state.status)) throw new GoalError("unfinished", "an unfinished goal already exists");
    if (typeof intent.objective !== "string" || !intent.objective.trim() || !intent.id) throw new GoalError("invalid", "objective and id are required");
    const max = intent.maxContinuations ?? 25;
    if (!Number.isInteger(max) || max < 0 || (intent.tokenBudget !== undefined && intent.tokenBudget !== null && (!Number.isFinite(intent.tokenBudget) || intent.tokenBudget < 0))) throw new GoalError("invalid", "invalid limits");
    const now = Date.now();
    return { id: intent.id, objective: intent.objective.trim(), status: "active", tokenBudget: intent.tokenBudget ?? null, maxContinuations: max, continuationSeq: 0, createdAt: now, updatedAt: now, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0 } };
  }
  if (!state) throw new GoalError("missing", "no goal exists");
  if (intent.type === "clear") return null;
  if (intent.type === "transition") {
    if (!statuses.includes(intent.to)) throw new GoalError("invalid", "unknown status");
    if (intent.to === "paused" && !intent.userRequest?.trim()) throw new GoalError("forbidden", "paused requires user request evidence");
    if (intent.by === "agent" && !["complete", "blocked"].includes(intent.to)) throw new GoalError("forbidden", "agent cannot set this status");
    if (intent.by === "agent" && intent.to === "complete" && state.status !== "active") throw new GoalError("forbidden", "agent can complete only an active goal");
    const reset = intent.resetContinuations === true;
    if (reset && (intent.by !== "user" || intent.to !== "active")) throw new GoalError("forbidden", "only user resume can reset continuations");
    if (reset && state.tokenBudget !== null && usageKeys.reduce((sum, key) => sum + state.usage[key], 0) >= state.tokenBudget) throw new GoalError("budget", "token budget exhausted; adjust /goal budget before resuming");
    if (state.status === "complete" || (intent.to === state.status && !reset)) throw new GoalError("illegal", "illegal status transition");
    return { ...state, status: intent.to, ...(reset ? { continuationSeq: 0 } : {}) };
  }
  if (intent.type === "limit_config") {
    if (!Number.isInteger(intent.maxContinuations) || intent.maxContinuations < 0 || (intent.tokenBudget !== null && (!Number.isFinite(intent.tokenBudget) || intent.tokenBudget < 0))) throw new GoalError("invalid", "invalid limits");
    return { ...state, tokenBudget: intent.tokenBudget, maxContinuations: intent.maxContinuations };
  }
  if (intent.type === "continuation_sent") return { ...state, continuationSeq: safeAdd(state.continuationSeq, 1, "continuation count") };
  if (intent.type === "usage") {
    const delta: Record<UsageKey, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let unknown = safeDelta(intent.unknownMessages, "unknownMessages");
    for (const key of usageKeys) {
      const value = intent[key];
      if (value === null) unknown = safeAdd(unknown, 1, "unknownMessages");
      else delta[key] = safeDelta(value, key);
    }
    const nextUsage = {
      input: safeAdd(state.usage.input, delta.input, "input usage"),
      output: safeAdd(state.usage.output, delta.output, "output usage"),
      cacheRead: safeAdd(state.usage.cacheRead, delta.cacheRead, "cacheRead usage"),
      cacheWrite: safeAdd(state.usage.cacheWrite, delta.cacheWrite, "cacheWrite usage"),
      unknownMessages: safeAdd(state.usage.unknownMessages, unknown, "unknownMessages")
    };
    const next = { ...state, usage: nextUsage };
    // Arithmetic limits use budget_limited.
    if (next.status === "active" && limitsExceeded(next)) next.status = "budget_limited";
    return next;
  }
  return { ...state };
}
export function limitsExceeded(goal: Goal): boolean {
  const used = goal.usage.input + goal.usage.output + goal.usage.cacheRead + goal.usage.cacheWrite;
  return (goal.tokenBudget !== null && used >= goal.tokenBudget) || goal.continuationSeq >= goal.maxContinuations;
}
export function fold(entries: readonly Entry[]): Goal | null {
  let state: Goal | null = null;
  for (const entry of entries) {
    if (!entry.type.startsWith("goal.")) continue;
    if (entry.type === "goal.created") state = { ...entry.goal };
    else if (entry.type === "goal.cleared") state = null;
    else if (state && entry.type === "goal.transition") state = transition(state, { type: "transition", to: entry.to, by: entry.by, userRequest: entry.userRequest, resetContinuations: entry.resetContinuations });
    else if (state && entry.type === "goal.limit_config") state = transition(state, { type: "limit_config", tokenBudget: entry.tokenBudget, maxContinuations: entry.maxContinuations });
    else if (state && entry.type === "goal.continuation_sent") state = transition(state, { type: "continuation_sent", generation: entry.generation });
    else if (state && entry.type === "goal.usage") state = transition(state, { type: "usage", input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite, unknownMessages: entry.unknownMessages });
    else if (state && entry.type === "goal.stale_turn") state = transition(state, { type: "stale_turn", generation: entry.generation });
  }
  return state;
}
export const newGoalId = (): string => `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export function summarize(goal: Goal): string { const u = goal.usage; return `[goal ${goal.id}] ${goal.status}: ${goal.objective} (continuations ${goal.continuationSeq}/${goal.maxContinuations}, budget ${goal.tokenBudget ?? "none"}, usage in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} unknown=${u.unknownMessages})`; }
