import { limitReason, newGoalId, tokensUsed, type Goal } from "./goal.ts";
import { objectiveUpdatedPrompt } from "./prompts.ts";
import type { CommitResult, GoalCommitLike, GoalSnapshot } from "./goal-commit.ts";

export type CommandDeps = {
  goalCommit: GoalCommitLike;
  send(message: { customType: string; content: string; display: false; details?: unknown }, options: { triggerTurn: true }): void;
  kick(): Promise<void>;
};
export type CommandPiLike = { registerCommand(name: string, command: any): void };
type Command =
  | { kind: "show" | "pause" | "resume" | "clear" }
  | { kind: "budget"; tokenBudget: number | null }
  | { kind: "turns"; value: number }
  | { kind: "edit"; objective: string }
  | { kind: "create"; objective: string; tokenBudget?: number }
  | { kind: "invalid"; message: string };

function parseTokens(text: string, minimum = 0): number | undefined {
  const match = text.match(/^(\d+)([kKmM])?$/);
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1_000 : 1);
  return Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

export function parseGoalCommand(input: string): Command {
  const s = input.trim();
  if (!s) return { kind: "show" };
  const invalid = (usage: string): Command => ({ kind: "invalid", message: `Invalid /goal arguments. Usage: ${usage}` });
  const simple = s.match(/^(pause|resume|clear)$/i);
  if (simple) return { kind: simple[1].toLowerCase() as "pause" | "resume" | "clear" };
  const budget = s.match(/^budget\s+(\S+)$/i);
  if (budget) {
    if (budget[1].toLowerCase() === "none") return { kind: "budget", tokenBudget: null };
    const value = parseTokens(budget[1]);
    if (value !== undefined) return { kind: "budget", tokenBudget: value };
  }
  const turns = s.match(/^turns\s+(\d+)$/i);
  if (turns && Number.isSafeInteger(Number(turns[1]))) return { kind: "turns", value: Number(turns[1]) };
  const edit = s.match(/^edit\s+([\s\S]+)$/i);
  if (edit) return { kind: "edit", objective: edit[1] };
  const reserved = s.match(/^(pause|resume|clear|budget|turns|edit)\b/i)?.[1].toLowerCase();
  if (reserved) {
    const usage: Record<string, string> = { budget: " <tokens[k|M]|none>", turns: " <non-negative integer>", edit: " <objective>" };
    return invalid(`/goal ${reserved}${usage[reserved] ?? ""}`);
  }
  if (s.startsWith("-")) {
    const create = s.match(/^--tokens\s+(\S+)\s+([\s\S]+)$/i);
    const value = create ? parseTokens(create[1], 1) : undefined;
    return create && value !== undefined ? { kind: "create", objective: create[2], tokenBudget: value } : invalid("/goal --tokens <positive tokens[k|M]> <objective>");
  }
  return { kind: "create", objective: s };
}

const n = (value: number) => value.toLocaleString("en-US");
const budgetLabel = (goal: Goal) => goal.tokenBudget === null ? "unlimited" : n(goal.tokenBudget);
const remainingLabel = (goal: Goal) => goal.tokenBudget === null ? "unlimited" : n(Math.max(0, goal.tokenBudget - tokensUsed(goal)));
function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", rest || !seconds ? `${rest}s` : ""].filter(Boolean).join(" ");
}
function limitDetails(goal: Goal): string[] {
  if (goal.status !== "budget_limited") return [];
  switch (limitReason(goal)) {
    case "token_budget": return ["Limit reached: token budget.", "Next: increase the total with /goal budget <N>, or remove the cap with /goal budget none; then /goal resume."];
    case "continuation_limit": return ["Limit reached: automatic continuation allowance.", goal.maxContinuations === 0 ? "Next: set /goal turns <N> above zero, then /goal resume." : "Next: /goal resume renews the continuation allowance; token usage is preserved."];
    default: return ["Limits are no longer exceeded. Next: /goal resume."];
  }
}
function formatGoal(snapshot: GoalSnapshot | null): string {
  if (!snapshot) return "No active goal.";
  const g = snapshot.goal, u = g.usage;
  return [
    `Status: ${g.status}`,
    `Objective: ${g.objective}`,
    ...limitDetails(g),
    `Tokens: ${n(tokensUsed(g))} used / ${budgetLabel(g)} total budget`,
    `Tokens remaining: ${remainingLabel(g)}`,
    `Input: ${n(u.input)} · Output: ${n(u.output)}`,
    `Cache read: ${n(u.cacheRead)} · Cache write: ${n(u.cacheWrite)}`,
    `Continuations: ${g.continuationSeq}/${g.maxContinuations} used (${Math.max(0, g.maxContinuations - g.continuationSeq)} remaining)`,
    `Recorded active time: ${formatTime(g.timeUsedSeconds ?? 0)}`,
    ...(u.unknownMessages > 0 ? [`Unknown-usage messages: ${u.unknownMessages} (token totals may be incomplete)`] : [])
  ].join("\n");
}

export function registerGoalCommands(piLike: CommandPiLike, deps: CommandDeps): void {
  const { goalCommit } = deps;
  piLike.registerCommand("goal", { description: "Show goal details or manage the current goal", handler: async (raw: string, ctx?: { ui?: { notify(message: string, level?: string): void } }) => {
    let level: "info" | "warning" | "error" = "info";
    const fail = (message: string, severity: typeof level = "warning") => { level = severity; return message; };
    const finish = (r: CommitResult, ok: string) => {
      if (r.kind === "ok") return ok;
      if (r.kind === "conflict") return fail("Goal changed during the command. Retry with the current goal.");
      return fail(`Goal update failed: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
    };
    const run = async (cmd: Command): Promise<string> => {
      const current = goalCommit.current();
      const revision = current?.revision ?? goalCommit.getRevision();
      if (cmd.kind === "invalid") return fail(cmd.message);
      if (cmd.kind === "show") return formatGoal(current);
      if (cmd.kind !== "create" && !current) return fail("Cannot change goal: no goal exists. Create one with /goal <objective>.");
      switch (cmd.kind) {
        case "create": {
          // Codex thread/goal/set semantics: preserve the unfinished goal's identity and cumulative usage.
          if (current && current.goal.status !== "complete") {
            const r = await goalCommit.commit({ type: "update_objective", objective: cmd.objective, ...(cmd.tokenBudget === undefined ? {} : { tokenBudget: cmd.tokenBudget }) }, revision);
            if (r.kind === "ok" && r.snapshot) deps.send({ customType: "pi-goal-next/objective_updated", content: objectiveUpdatedPrompt(r.snapshot.goal), display: false, details: { goalId: r.snapshot.goal.id } }, { triggerTurn: true });
            return finish(r, "Goal updated.");
          }
          const r = await goalCommit.commit({ type: "create", id: newGoalId(), objective: cmd.objective, tokenBudget: cmd.tokenBudget ?? null }, revision);
          if (r.kind === "ok") await deps.kick();
          return finish(r, "Goal created.");
        }
        case "edit": {
          const r = await goalCommit.commit({ type: "update_objective", objective: cmd.objective }, revision);
          if (r.kind === "ok" && r.snapshot) deps.send({ customType: "pi-goal-next/objective_updated", content: objectiveUpdatedPrompt(r.snapshot.goal), display: false, details: { goalId: r.snapshot.goal.id } }, { triggerTurn: true });
          return finish(r, "Goal edited.");
        }
        case "clear": return finish(await goalCommit.commit({ type: "clear" }, revision), "Goal cleared. Automatic goal continuation is disabled; running model/tool work is not interrupted.");
        case "pause": {
          if (current!.goal.status === "complete") return fail("Cannot pause: goal is complete.");
          if (current!.goal.status === "paused") return "Goal is already paused. Automatic goal continuation is disabled; running model/tool work is not interrupted.";
          return finish(await goalCommit.commit({ type: "transition", to: "paused", by: "user", userRequest: '"/goal pause"' }, revision), "Goal paused. Automatic goal continuation is disabled; running model/tool work is not interrupted.");
        }
        case "resume": {
          const goal = current!.goal;
          if (goal.status === "complete") return fail("Cannot resume: goal is complete. Start a new goal with /goal <objective>.");
          if (limitReason(goal) === "token_budget") return fail(`Cannot resume: token budget exhausted (${n(tokensUsed(goal))}/${budgetLabel(goal)} used). Increase the total with /goal budget <N>, or remove the cap with /goal budget none; then /goal resume. Cumulative usage is preserved.`);
          if (goal.maxContinuations === 0) return fail("Cannot resume: continuation allowance is zero. Set /goal turns <N> above zero, then /goal resume.");
          const r = await goalCommit.commit({ type: "transition", to: "active", by: "user", resetContinuations: true }, revision);
          if (r.kind === "ok") await deps.kick();
          return finish(r, `Goal resumed. Continuation counter reset (limit: ${goal.maxContinuations}).\nToken usage preserved: ${n(tokensUsed(goal))}; total budget: ${budgetLabel(goal)}; remaining: ${remainingLabel(goal)}.`);
        }
        case "budget": {
          const goal = current!.goal;
          const r = await goalCommit.commit({ type: "limit_config", tokenBudget: cmd.tokenBudget, maxContinuations: goal.maxContinuations }, revision);
          const updated = { ...goal, tokenBudget: cmd.tokenBudget };
          return finish(r, `Total token budget: ${budgetLabel(updated)} (not additional tokens). Used: ${n(tokensUsed(goal))}; remaining: ${remainingLabel(updated)}.\nGoal status unchanged: ${goal.status}.${goal.status === "budget_limited" ? " Use /goal resume after adjusting limits." : ""}`);
        }
        case "turns": {
          const goal = current!.goal;
          const r = await goalCommit.commit({ type: "limit_config", tokenBudget: goal.tokenBudget, maxContinuations: cmd.value }, revision);
          return finish(r, `Continuation limit: ${cmd.value}. Used: ${goal.continuationSeq}; remaining: ${Math.max(0, cmd.value - goal.continuationSeq)}. ${cmd.value === 0 ? "Zero disables automatic goal continuation; set a positive limit before /goal resume." : "Counter unchanged; /goal resume resets it."}\nGoal status unchanged: ${goal.status}.`);
        }
      }
    };
    const message = await run(parseGoalCommand(raw));
    ctx?.ui?.notify(message, level);
    return message;
  }});
}
