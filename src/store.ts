import type { Entry } from "./goal.ts";
export type BranchContext = { sessionManager: { getBranch(): readonly unknown[] } };
export type PiCustomEntry = { type: "custom"; customType: string; data: unknown };
export type PiAppender = { appendEntry(customType: string, data: unknown): unknown };
export const VERSION = 1 as const;
const entryTypes = new Set(["goal.created", "goal.replaced", "goal.transition", "goal.cleared", "goal.usage", "goal.continuation_sent", "goal.stale_turn", "goal.limit_config"]);
export function isEntry(entry: unknown): entry is Entry { return !!entry && typeof entry === "object" && (entry as { version?: unknown }).version === VERSION && entryTypes.has((entry as { type?: unknown }).type as string) && Number.isSafeInteger((entry as { seq?: unknown }).seq); }
export function readBranch(ctx: BranchContext): Entry[] { return ctx.sessionManager.getBranch().filter((item): item is PiCustomEntry => { if (!item || typeof item !== "object") return false; const wrapped = item as Partial<PiCustomEntry>; return wrapped.type === "custom" && wrapped.customType === "pi-goal-next"; }).map(item => item.data).filter(isEntry); }
export async function append(pi: PiAppender, entry: Entry): Promise<void> { if (!isEntry(entry)) throw new Error("unsupported journal version"); await pi.appendEntry("pi-goal-next", entry); }
