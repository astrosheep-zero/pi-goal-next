import { newGoalId } from "./goal.ts";
import type { Intent, Status } from "./goal.ts";
import { objectiveUpdatedPrompt } from "./prompts.ts";
import type { GoalSnapshot } from "./goal-commit.ts";
import type { GoalCommitLike } from "./goal-commit.ts";

export type CommandDeps = {
  goalCommit: GoalCommitLike;
  summarize?: (snapshot: GoalSnapshot | null) => string;
  send(message: { customType: string; content: string; display: false; details?: unknown }, options: { triggerTurn: true }): void;
  kick(): Promise<void>;
};
export type CommandPiLike = { registerCommand(name: string, command: any): void };

export function parseGoalCommand(input: string): { kind: string; objective?: string; tokenBudget?: number | null; value?: number } {
  const s = input.trim(); if (!s || s === "status") return { kind: "status" };
  if (s === "pause" || s === "resume" || s === "clear") return { kind: s };
  const budget = s.match(/^budget\s+(none|\d+)$/i); if (budget) return { kind: "budget", tokenBudget: budget[1].toLowerCase() === "none" ? null : Number(budget[1]) };
  const turns = s.match(/^turns\s+(\d+)$/i); if (turns) return { kind: "turns", value: Number(turns[1]) };
  const edit = s.match(/^edit\s+(.+)$/i); if (edit) return { kind: "edit", objective: edit[1] };
  const create = s.match(/^(?:--tokens\s+(\d+)([kKmM])?\s+)?(.+)$/); if (create) { const n = create[1] ? Number(create[1]) * (create[2]?.toLowerCase() === "m" ? 1_000_000 : create[2]?.toLowerCase() === "k" ? 1_000 : 1) : undefined; return { kind: "create", objective: create[3], ...(n === undefined ? {} : { tokenBudget: n }) }; }
  return { kind: "invalid" };
}

export function registerGoalCommands(piLike: CommandPiLike, deps: CommandDeps): void {
  const { goalCommit } = deps;
  const summarize = deps.summarize ?? ((snapshot: GoalSnapshot | null) => snapshot ? `${snapshot.goal.status}: ${snapshot.goal.objective}` : "No active goal.");
  piLike.registerCommand("goal", { description: "Manage the current goal", handler: async (raw: string, ctx?: { ui?: { notify(message: string, level?: string): void } }) => {
    const run = async (cmd: ReturnType<typeof parseGoalCommand>): Promise<string> => {
      const current = goalCommit.current();
      const revision = current?.revision ?? goalCommit.getRevision();
      const finish = (r: Awaited<ReturnType<GoalCommitLike["commit"]>>, ok: string) => r.kind === "ok" ? ok : "Goal update failed.";
      switch (cmd.kind) {
        case "status": return summarize(current);
        case "create": {
          if (current && current.goal.status !== "complete") return "Cannot create goal: an unfinished goal already exists.";
          const r = await goalCommit.commit({ type: "create", id: newGoalId(), objective: cmd.objective as string, tokenBudget: cmd.tokenBudget ?? null }, revision);
          if (r.kind === "ok") await deps.kick();
          return r.kind === "ok" ? "Goal created." : "Goal update failed.";
        }
        case "edit": {
          if (!current) return "Goal update failed.";
          const r = await goalCommit.commit({ type: "replace", id: newGoalId(), objective: cmd.objective as string }, revision);
          if (r.kind === "ok" && r.snapshot) deps.send({ customType: "pi-goal-next/objective_updated", content: objectiveUpdatedPrompt(r.snapshot.goal), display: false, details: { goalId: r.snapshot.goal.id } }, { triggerTurn: true });
          return r.kind === "ok" ? "Goal edited." : "Goal update failed.";
        }
        case "clear": return finish(await goalCommit.commit({ type: "clear" }, revision), "Goal cleared.");
        case "pause": return finish(await goalCommit.commit({ type: "transition", to: "paused", by: "user", userRequest: '"/goal pause"' }, revision), "Goal paused.");
        case "resume": {
          if (!current) return "Cannot resume: no goal exists.";
          const goal = current.goal;
          if (goal.status === "complete") return "Cannot resume: goal is complete.";
          const used = goal.usage.input + goal.usage.output + goal.usage.cacheRead + goal.usage.cacheWrite;
          if (goal.tokenBudget !== null && used >= goal.tokenBudget) return "Cannot resume: token budget exhausted. Adjust /goal budget first; cumulative usage is preserved.";
          if (goal.maxContinuations === 0) return "Cannot resume: continuation allowance is zero. Adjust /goal turns first.";
          const r = await goalCommit.commit({ type: "transition", to: "active", by: "user", resetContinuations: true }, revision);
          if (r.kind === "ok") await deps.kick();
          return r.kind === "ok" ? "Goal resumed." : "Goal update failed.";
        }
        case "budget": return finish(await goalCommit.commit({ type: "limit_config", tokenBudget: cmd.tokenBudget ?? null, maxContinuations: current?.goal.maxContinuations ?? 25 }, revision), "Goal limits updated.");
        case "turns": return finish(await goalCommit.commit({ type: "limit_config", tokenBudget: current?.goal.tokenBudget ?? null, maxContinuations: cmd.value as number }, revision), "Goal limits updated.");
        default: return "Invalid /goal command.";
      }
    };
    const message = await run(parseGoalCommand(raw));
    ctx?.ui?.notify(message, "info");
    return message;
  }});
}
