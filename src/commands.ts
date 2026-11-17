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
  | { kind: "show" | "help" | "pause" | "resume" | "clear" }
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
  const invalid = (usage: string): Command => ({ kind: "invalid", message: `Invalid /goal arguments. Usage: ${usage}. Run /goal help for every command.` });
  // The bare word only: no flag aliases. Checked before the `-` branch so a
  // leading dash can never be read as a create flag.
  if (/^help$/i.test(s)) return { kind: "help" };
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
    if (create && value !== undefined) return { kind: "create", objective: create[2], tokenBudget: value };
    // A stray flag is not a malformed --tokens call; naming it as an unknown
    // option is what an alias habit (-h, --help) actually needs to read.
    if (!/^--tokens\b/i.test(s)) return { kind: "invalid", message: `Unknown /goal option: ${/^\S+/.exec(s)?.[0] ?? s}. Run /goal help for every command.` };
    return invalid("/goal --tokens <positive tokens[k|M]> <objective>");
  }
  return { kind: "create", objective: s };
}

/** The one place the command surface is described inside Pi. Kept next to the
 * parser so a new subcommand is added in both places in the same edit. */
const USAGE = [
  "/goal — status and control",
  "",
  "  /goal                      status, budget, usage, continuations",
  "  /goal <objective>          create a goal, or update this one",
  "  /goal --tokens 200k <obj>  create with a total budget",
  "  /goal edit <objective>     update the objective",
  "  /goal budget <N|none>      total budget, not additional",
  "  /goal turns <N>            continuation limit (default 32)",
  "  /goal pause | resume       stop or renew continuations",
  "  /goal clear                remove the goal",
  "  /goal help                 this list",
  "",
  "A budget is cumulative. Raise a limit, then /goal resume.",
].join("\n");
/** A one-line echo of the stored objective, so an update shows what it became. */
const PREVIEW_MAX = 160;
export function objectivePreview(objective: string): string {
  const line = objective.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX)}…` : line;
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
    case "token_budget": return ["Limit: token budget.", "Next: /goal budget <N|none>, then /goal resume."];
    case "continuation_limit": return ["Limit: continuations.", goal.maxContinuations === 0 ? "Next: /goal turns <N> above zero, then /goal resume." : "Next: /goal resume."];
    default: return ["Limits cleared.", "Next: /goal resume."];
  }
}
function formatGoal(snapshot: GoalSnapshot | null): string {
  if (!snapshot) return "No active goal. /goal <objective> to start; /goal help for commands.";
  const g = snapshot.goal, u = g.usage;
  return [
    `Status: ${g.status}`,
    `Objective: ${g.objective}`,
    ...limitDetails(g),
    g.tokenBudget === null
      ? `Tokens: ${n(tokensUsed(g))} used · unlimited budget`
      : `Tokens: ${n(tokensUsed(g))} used / ${n(g.tokenBudget)} budget · ${remainingLabel(g)} left`,
    `Input: ${n(u.input)} · Output: ${n(u.output)}`,
    `Cache read: ${n(u.cacheRead)} · Cache write: ${n(u.cacheWrite)}`,
    `Continuations: ${g.continuationSeq}/${g.maxContinuations}`,
    `Active time: ${formatTime(g.timeUsedSeconds ?? 0)}`,
    ...(u.unknownMessages > 0 ? [`Unknown usage: ${u.unknownMessages} message${u.unknownMessages === 1 ? "" : "s"} (totals may be incomplete)`] : [])
  ].join("\n");
}

export function registerGoalCommands(piLike: CommandPiLike, deps: CommandDeps): void {
  const { goalCommit } = deps;
  piLike.registerCommand("goal", { description: "Show goal details or manage the current goal (/goal help)", handler: async (raw: string, ctx?: { ui?: { notify(message: string, level?: string): void } }) => {
    let level: "info" | "warning" | "error" = "info";
    const fail = (message: string, severity: typeof level = "warning") => { level = severity; return message; };
    const finish = (r: CommitResult, ok: string) => {
      if (r.kind === "ok") return ok;
      if (r.kind === "conflict") return fail("Goal changed during the command. Retry with the current goal.");
      return fail(`Goal update failed: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
    };
    /** Success keeps a one-line echo of the stored objective under the headline. */
    const withPreview = (r: CommitResult, headline: string): string =>
      r.kind === "ok" && r.snapshot ? `${headline}\n${objectivePreview(r.snapshot.goal.objective)}` : finish(r, headline);
    const run = async (cmd: Command): Promise<string> => {
      const current = goalCommit.current();
      const revision = current?.revision ?? goalCommit.getRevision();
      if (cmd.kind === "invalid") return fail(cmd.message);
      if (cmd.kind === "help") return USAGE;
      if (cmd.kind === "show") return formatGoal(current);
      if (cmd.kind !== "create" && !current) return fail("No goal to change. Start one with /goal <objective>.");
      switch (cmd.kind) {
        case "create": {
          // Codex thread/goal/set semantics: preserve the unfinished goal's identity and cumulative usage.
          if (current && current.goal.status !== "complete") {
            const r = await goalCommit.commit({ type: "update_objective", objective: cmd.objective, ...(cmd.tokenBudget === undefined ? {} : { tokenBudget: cmd.tokenBudget }) }, revision);
            if (r.kind === "ok" && r.snapshot) deps.send({ customType: "pi-goal-next/objective_updated", content: objectiveUpdatedPrompt(r.snapshot.goal), display: false, details: { goalId: r.snapshot.goal.id } }, { triggerTurn: true });
            return withPreview(r, "Goal updated.");
          }
          const r = await goalCommit.commit({ type: "create", id: newGoalId(), objective: cmd.objective, tokenBudget: cmd.tokenBudget ?? null }, revision);
          if (r.kind === "ok") await deps.kick();
          return withPreview(r, "Goal created.");
        }
        case "edit": {
          const r = await goalCommit.commit({ type: "update_objective", objective: cmd.objective }, revision);
          if (r.kind === "ok" && r.snapshot) deps.send({ customType: "pi-goal-next/objective_updated", content: objectiveUpdatedPrompt(r.snapshot.goal), display: false, details: { goalId: r.snapshot.goal.id } }, { triggerTurn: true });
          return withPreview(r, "Goal updated.");
        }
        case "clear": return finish(await goalCommit.commit({ type: "clear" }, revision), "Goal cleared.");
        case "pause": {
          if (current!.goal.status === "complete") return fail("Cannot pause: goal is complete.");
          if (current!.goal.status === "paused") return "Goal is already paused. Automatic goal continuation is disabled; running model/tool work is not interrupted.";
          return finish(await goalCommit.commit({ type: "transition", to: "paused", by: "user", userRequest: '"/goal pause"' }, revision), "Goal paused.");
        }
        case "resume": {
          const goal = current!.goal;
          if (goal.status === "complete") return fail("Cannot resume: goal is complete. Start a new goal with /goal <objective>.");
          if (limitReason(goal) === "token_budget") return fail(`Cannot resume: budget exhausted (${n(tokensUsed(goal))}/${budgetLabel(goal)}). Raise it with /goal budget <N|none>, then /goal resume.`);
          if (goal.maxContinuations === 0) return fail("Cannot resume: continuation limit is 0. Set /goal turns <N>, then /goal resume.");
          const r = await goalCommit.commit({ type: "transition", to: "active", by: "user", resetContinuations: true }, revision);
          if (r.kind === "ok") await deps.kick();
          return finish(r, `Goal resumed. Continuations 0/${goal.maxContinuations} · tokens ${n(tokensUsed(goal))} used / ${budgetLabel(goal)}.`);
        }
        case "budget": {
          const goal = current!.goal;
          const r = await goalCommit.commit({ type: "limit_config", tokenBudget: cmd.tokenBudget, maxContinuations: goal.maxContinuations }, revision);
          const updated = { ...goal, tokenBudget: cmd.tokenBudget };
          const hint = goal.status === "budget_limited" ? " Run /goal resume." : "";
          return finish(r, `Token budget: ${budgetLabel(updated)} total · ${n(tokensUsed(goal))} used · ${remainingLabel(updated)} left.${hint}`);
        }
        case "turns": {
          const goal = current!.goal;
          const r = await goalCommit.commit({ type: "limit_config", tokenBudget: goal.tokenBudget, maxContinuations: cmd.value }, revision);
          const tail = cmd.value === 0 ? " Zero stops continuation; set it above zero before /goal resume." : "";
          return finish(r, `Continuation limit: ${cmd.value} · ${goal.continuationSeq} used · ${Math.max(0, cmd.value - goal.continuationSeq)} left.${tail}`);
        }
      }
    };
    const message = await run(parseGoalCommand(raw));
    ctx?.ui?.notify(message, level);
    return message;
  }});
}
