import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { append, readBranch } from "./store.ts";
import { createGoalCommit } from "./goal-commit.ts";
import type { GoalStore } from "./goal-commit.ts";
import { createAccounting } from "./accounting.ts";
import { createContinuation } from "./continuation.ts";
import { continuationPrompt } from "./prompts.ts";
import { registerLifecycle } from "./lifecycle.ts";
import { registerUi } from "./ui.ts";
import { registerGoalTools } from "./tools.ts";
import { registerGoalCommands } from "./commands.ts";

export default function (pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  // ExtensionAPI has no ambient context; handlers receive it per session/event.
  pi.on("session_start", (_event, eventCtx) => { ctx = eventCtx; });
  const store: GoalStore = {
    readBranch: () => ctx ? readBranch(ctx) : [],
    append: entry => append(pi, entry)
  };
  const goalCommit = createGoalCommit(store);
  const accounting = createAccounting();
  const continuation = createContinuation({
    getSnapshot: () => goalCommit.current(),
    commit: (intent, revision) => goalCommit.commit(intent, revision),
    send: (message, options) => { void Promise.resolve(pi.sendMessage(message, options)).catch(() => undefined); },
    isIdle: () => ctx?.isIdle?.() ?? true,
    hasPendingMessages: () => ctx?.hasPendingMessages?.() ?? false,
    buildPrompt: continuationPrompt
  });
  const send = (message: { customType: string; content: string; display: false; details?: unknown }, options: { triggerTurn: true }) => {
    void Promise.resolve(pi.sendMessage(message, options)).catch(() => undefined);
  };
  registerGoalTools(pi, { goalCommit });
  registerGoalCommands(pi, { goalCommit, send, kick: () => continuation.onSettled() });
  registerLifecycle(pi, { goalCommit, accounting, continuation, send, rebuild: () => goalCommit.rebuild() });
  registerUi({ goalCommit, accounting, getContext: () => ctx });
}
