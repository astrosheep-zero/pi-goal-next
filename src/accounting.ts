import type { Goal } from "./goal.ts";

export type Usage = {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  [key: string]: unknown;
};
export type Message = { entryId: string; role: "assistant" | "toolResult"; usage?: Usage | null; toolName?: string };
export type Delta = { input: number; output: number; cacheRead: number; cacheWrite: number; unknownMessages: number; stale: boolean };
export type Verdict = { kind: "ok" } | { kind: "budget_limited"; reason: string };

const n = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export function createAccounting() {
  const seen = new Set<string>();
  const stale = new Set<string>();
  const unknown = new Set<string>();
  const deltas = new Map<string, Delta>();

  function recordMessage(message: Message): { duplicate: boolean; delta: Delta } | null {
    if (!message || typeof message.entryId !== "string" || !message.entryId) return null;
    if (seen.has(message.entryId)) return { duplicate: true, delta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownMessages: 0, stale: stale.has(message.entryId) } };
    seen.add(message.entryId);
    const u = message.usage;
    const missing = !u;
    const delta: Delta = {
      input: n(u?.input) ?? 0,
      output: n(u?.output) ?? 0,
      cacheRead: n(u?.cacheRead) ?? 0,
      cacheWrite: n(u?.cacheWrite) ?? 0,
      unknownMessages: missing ? 1 : 0,
      stale: stale.has(message.entryId)
    };
    if (missing) unknown.add(message.entryId);
    deltas.set(message.entryId, delta);
    return { duplicate: false, delta };
  }

  function recordStale(entryId: string) { stale.add(entryId); const d = deltas.get(entryId); if (d) d.stale = true; }
  function settleTurn(goal: Goal): Verdict {
    const total = goal.usage.input + goal.usage.output + goal.usage.cacheRead + goal.usage.cacheWrite;
    if (goal.tokenBudget !== null && total >= goal.tokenBudget) return { kind: "budget_limited", reason: `token budget reached (${total}/${goal.tokenBudget})` };
    if (goal.continuationSeq >= goal.maxContinuations) return { kind: "budget_limited", reason: `continuation limit reached (${goal.continuationSeq}/${goal.maxContinuations})` };
    return { kind: "ok" };
  }
  function summary(goal: Goal) {
    const u = goal.usage;
    const staleText = stale.size ? `, stale=${stale.size}` : "";
    const unknownText = u.unknownMessages || unknown.size ? `, unknown messages=${u.unknownMessages + unknown.size}` : "";
    return `usage input=${u.input} output=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite}${unknownText}${staleText}`;
  }
  return { recordMessage, recordStale, settleTurn, summary };
}
