import { Type } from "typebox";
import { newGoalId } from "./goal.ts";
import type { Goal, Intent, Status } from "./goal.ts";
import type { CommitResult, GoalCommitLike } from "./goal-commit.ts";

export type GoalToolDeps = { goalCommit: GoalCommitLike };
export type PiTool = { name: string; label?: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<any> };
export type PiLike = { registerTool(tool: any): void };

const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
const tokensUsed = (goal: Goal) => goal.usage.input + goal.usage.output + goal.usage.cacheRead + goal.usage.cacheWrite;
function result(message: string): any { return { content: [{ type: "text", text: message }] }; }
function commitMessage(r: CommitResult): string {
  if (r.kind === "conflict") return "Goal update conflict: goal changed; retry with the current goal.";
  if (r.kind === "error") return `Goal update failed: ${r.error instanceof Error ? r.error.message : text(r.error)}`;
  return "Goal updated.";
}

export function registerGoalTools(piLike: PiLike, deps: GoalToolDeps): void {
  const { goalCommit } = deps;
  piLike.registerTool({
    name: "get_goal", label: "Get goal",
    description: "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
    parameters: Type.Object({}),
    execute: async () => {
      const snapshot = goalCommit.current();
      if (!snapshot) return result("No active goal.");
      const goal = snapshot.goal;
      return result(JSON.stringify({ ...snapshot, remainingBudget: goal.tokenBudget === null ? null : Math.max(0, goal.tokenBudget - tokensUsed(goal)), elapsedSeconds: Math.floor((Date.now() - goal.createdAt) / 1000) }));
    }
  });
  piLike.registerTool({
    name: "create_goal", label: "Create goal",
    description: "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nSet token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
    parameters: Type.Object({
      objective: Type.String({ description: "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete." }),
      token_budget: Type.Optional(Type.Integer({ minimum: 1, description: "Positive token budget for the new goal. Omit unless explicitly requested." }))
    }),
    execute: async (_id: string, params: any) => {
      if (!params || typeof params.objective !== "string" || !params.objective.trim()) return result("Invalid objective: a non-empty objective is required.");
      const current = goalCommit.current();
      if (current && current.goal.status !== "complete") return result("Cannot create goal: an unfinished goal already exists.");
      const revision = current?.revision ?? goalCommit.getRevision();
      const intent: Intent = { type: "create", id: newGoalId(), objective: params.objective, tokenBudget: params.token_budget ?? null };
      const r = await goalCommit.commit(intent, revision);
      return result(r.kind === "ok" ? "Goal created." : commitMessage(r));
    }
  });
  piLike.registerTool({
    name: "update_goal", label: "Update goal",
    description: "Update the existing goal.\nSet status to `paused` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume cancels the pause. Report the returned status and stop goal work. Budget limits take precedence over pausing.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nSet status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.\nIf the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.\nOnce the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.\nDo not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\nDo not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\nYou cannot use this tool to resume or budget-limit a goal; those status changes are controlled by the user or system.\nWhen marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.",
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("paused")], { description: "Required. `paused` requires an explicit user request. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit." }) }),
    execute: async (_id: string, params: any) => {
      const status = params?.status as Status;
      const expected = status === "complete" || status === "blocked" || status === "paused";
      const current = goalCommit.current();
      if (!current) return result("Goal update failed: no goal exists.");
      if (!expected) return result(`Invalid status: ${text(params?.status)} is not complete or blocked.`);
      const r = await goalCommit.commit({ type: "transition", to: status, by: "agent" }, current.revision);
      if (r.kind !== "ok") return result(commitMessage(r));
      if (status === "blocked") return result("Goal marked blocked.");
      if (status === "paused") return result("Goal marked paused.");
      const u = (r.snapshot?.goal ?? current.goal).usage;
      const total = u.input + u.output + u.cacheRead + u.cacheWrite;
      return result(`Goal marked complete. Final token usage: input=${u.input} output=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} (total=${total}).`);
    }
  });
}
