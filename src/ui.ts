import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { summarize } from "./goal.ts";
import type { Goal } from "./goal.ts";
import type { GoalSnapshot } from "./goal-commit.ts";

export type UiDeps = { goalCommit: { current(): GoalSnapshot | null; subscribe(fn: (snapshot: GoalSnapshot | null) => void): () => void }; accounting: { summary(goal: Goal): string }; getContext(): { ui?: { setStatus?(id: string, text: string): void } } | undefined };

export function registerUi(pi: Pick<ExtensionAPI, "on">, deps: UiDeps): () => void {
  const render = (snapshot: GoalSnapshot | null) => {
    const text = snapshot ? `${snapshot.goal.status}: ${summarize(snapshot.goal)} | ${deps.accounting.summary(snapshot.goal)}` : "no goal";
    deps.getContext()?.ui?.setStatus?.("pi-goal-next", text);
  };
  const unsubscribeStatus = deps.goalCommit.subscribe(render);
  const unsubscribeMessage = pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (message.role !== "custom" || message.customType !== "pi-goal-next/continuation") return;
    const details = message.details as { goalId?: unknown; seq?: unknown } | undefined;
    if (!details || typeof details.seq !== "number" || !Number.isSafeInteger(details.seq) || details.seq < 1) return;
    const snapshot = deps.goalCommit.current();
    if (!snapshot || details.goalId !== snapshot.goal.id) return;
    // Notify on delivery, not on the journal commit: a fenced attempt can consume
    // a sequence number without ever starting a continuation.
    ctx.ui.notify(`Goal continuing (turn ${details.seq}/${snapshot.goal.maxContinuations}).`, "info");
  });
  return () => { unsubscribeStatus(); unsubscribeMessage(); };
}
