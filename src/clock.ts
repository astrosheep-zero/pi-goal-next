// Codex GoalWallClockAccounting equivalent: a wall-clock baseline that runs
// only while a goal is active. The baseline is in-memory; accrued seconds are
// journaled at accounting points (usage flushes), so the persisted total
// survives reloads while the live baseline does not.
export type ClockGoal = { id: string; status: string } | null;

export function createGoalClock(now: () => number = Date.now) {
  let baseline: { goalId: string; at: number } | null = null;

  // Observe the current goal: start the clock when a goal is active, stop it
  // otherwise, and rebase when the active goal id changes. Idempotent.
  function sync(goal: ClockGoal): void {
    if (goal && goal.status === "active") {
      if (!baseline || baseline.goalId !== goal.id) baseline = { goalId: goal.id, at: now() };
    } else {
      baseline = null;
    }
  }

  // Whole seconds accrued since the last accounting point for this goal;
  // 0 when the clock is stopped or belongs to a different goal.
  function peek(goalId: string): number {
    if (!baseline || baseline.goalId !== goalId) return 0;
    return Math.max(0, Math.floor((now() - baseline.at) / 1000));
  }

  // Advance the baseline past journaled seconds. Call only after the seconds
  // have been durably committed; on failure the baseline stays put so the
  // next attempt still accounts the full delta.
  function markAccounted(goalId: string): void {
    if (baseline && baseline.goalId === goalId) baseline = { goalId, at: now() };
  }

  function reset(): void { baseline = null; }

  return { sync, peek, markAccounted, reset };
}
