import { summarize } from "./goal.ts";
import type { Goal } from "./goal.ts";
import type { GoalSnapshot } from "./goal-commit.ts";

export type UiDeps = { goalCommit: { subscribe(fn: (snapshot: GoalSnapshot | null) => void): () => void }; accounting: { summary(goal: Goal): string }; getContext(): { ui?: { setStatus?(id: string, text: string): void } } | undefined };

export function registerUi(deps: UiDeps): () => void {
  const render = (snapshot: GoalSnapshot | null) => {
    const text = snapshot ? `${snapshot.goal.status}: ${summarize(snapshot.goal)} | ${deps.accounting.summary(snapshot.goal)}` : "no goal";
    deps.getContext()?.ui?.setStatus?.("pi-goal-next", text);
  };
  return deps.goalCommit.subscribe(render);
}
