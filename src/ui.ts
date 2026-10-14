import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalSnapshot } from "./goal-commit.ts";
import type { Status } from "./goal.ts";

export type UiDeps = { goalCommit: { current(): GoalSnapshot | null; subscribe(fn: (snapshot: GoalSnapshot | null) => void): () => void }; getContext(): { ui?: { setStatus?(id: string, text: string | undefined): void } } | undefined };

// U+FE0E (VS15) forces text presentation: macOS font fallback otherwise
// renders these text-default codepoints as color emoji. ⊘ has no emoji
// variant and needs no selector.
const FLAG = "⚑\uFE0E";
const STATE_GLYPHS: Partial<Record<Status, string>> = { paused: "⏸\uFE0E", blocked: "⊘", budget_limited: "⚠\uFE0E" };

export function formatStatus(snapshot: GoalSnapshot): string {
  return STATE_GLYPHS[snapshot.goal.status] ?? FLAG;
}

export function registerUi(pi: Pick<ExtensionAPI, "on">, deps: UiDeps): () => void {
  const render = (snapshot: GoalSnapshot | null) => {
    // Status line is a pure presence flag: objective and turn count stay off
    // the shared footer line (user's call; details via /goal).
    // undefined removes the entry entirely: no goal, or goal completed.
    const text = snapshot && snapshot.goal.status !== "complete" ? formatStatus(snapshot) : undefined;
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
