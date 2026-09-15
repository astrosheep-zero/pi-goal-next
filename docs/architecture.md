# Architecture — pi-goal (authoritative design contract)

All implementers follow this document exactly. Deviations require a new design round, not local invention.

## Product

Pi 0.85.1 extension package adding a long-running `/goal`. Behavior follows Codex Goal (`codex-rs/ext/goal`) as the baseline: the *same executing model* audits its own completion and calls `update_goal`. **No independent auditor, no human approval gate.** What differs is only what Pi's public API forces.

## Status set (goal.ts)

`active | paused | blocked | budget_limited | complete`

- Model's `update_goal` accepts only: `complete` | `blocked`. The model self-audits; the host does not validate the declaration.
- `budget_limited` is set only by runtime/system paths (accounting).
- `clear` is a journal entry `goal.cleared`; `fold()` yields null. Deletion is semantic.
- One goal per session branch. `create_goal` refuses when an unfinished goal exists.

## Ownership table

| Module | Owns | Must not do |
|---|---|---|
| `goal.ts` | Goal type, status transitions `transition()`, journal `fold()`, `summarize()`. Pure, zero deps. | IO, Pi types, prompts |
| `goal-commit.ts` | Sole write path: `current()`, `commit(intent, expectedRevision)`, `subscribe(fn)`. CAS + single pending slot; owns `revision`. | scheduling, accounting math, UI, Pi ctx |
| `store.ts` | `readBranch()` (from `ctx.sessionManager.getBranch()`, filter `goal.*`), `append(entry)`, `assertVersion`. IO only. | state decisions, caching current |
| `accounting.ts` | usage attribution keyed by **message id** (assistant and toolResult separately), `settleTurn() → verdict: ok \| budget_limited`, `summary()` | triggering continuation, editing goal state directly (returns verdict; lifecycle commits it) |
| `continuation.ts` | `generation` lease, `agent_settled` decision, commit-then-sendMessage, stale handling. The ONLY sender of continuation messages. | building UI, reading store, deciding acceptance |
| `prompts.ts` | Pure: the three Codex-verbatim goal templates — `continuationPrompt(goal)`, `budgetLimitPrompt(goal)`, `objectiveUpdatedPrompt(goal)`; `escapeXmlText` applies to the objective only. | IO, model calls, host-side validation |
| `tools.ts` | Codex-verbatim tool descriptions, TypeBox schema → `goalCommit.commit` → tool result. Three tools: get_goal / create_goal / update_goal. `update_goal` accepts only complete\|blocked and reports final usage on complete. | writing rules text, touching store/continuation |
| `commands.ts` | `/goal` subcommands → goal-commit. | direct store access |
| `lifecycle.ts` | Stateless event mapping (owns only sessionId). Session/branch/compaction policies plus budget-limit steering, see below. | holding Goal state, growing beyond the listed policies |
| `ui.ts` | status/widget text from `current()` + `accounting.summary()`. Read-only. | writes |
| `index.ts` | dependency assembly + registration only. | logic |

Dependency direction: `index → {tools, commands, lifecycle, ui} → {goal-commit, accounting, continuation, prompts} → {goal, store}`. `goal.ts` and `prompts.ts` have zero dependencies.

## goal-commit CAS contract

```ts
current(): GoalSnapshot | null            // { goal, revision }
commit(intent, expectedRevision): Promise<{ ok, snapshot } | { conflict, snapshot }>
subscribe(fn): unsubscribe
```

Internally: check `revision === expectedRevision` and no pending → mark pending → `await store.append` → success: swap in, revision+1, notify; failure: release pending, report. Critical section wraps one append only — never verification, prompt building, or sendMessage.

## Two counters

- `revision` (goal-commit): +1 per commit, CAS basis.
- `generation` (continuation): the implementation currently invalidates it on tree navigation (`session_before_tree`). Pause, clear, resume, and session restore do not call the continuation invalidation hook; status changes are still protected by the active-status check and the commit CAS. Every continuation message carries `{ goalId, generation, seq }` in details.

## Continuation protocol

`agent_settled` → read `current()` + require `ctx.isIdle() && !ctx.hasPendingMessages()` → `commit(continuation_sent {generation, seq}, revision)` → only on success `pi.sendMessage(continuation, { triggerTurn: true })`. On conflict: abandon this round, wait for next settle.

Stale continuation: Pi has no message retraction and `abort` cannot selectively cancel a goal message, so **never abort**. On `message_start`, lifecycle notifies continuation; if the custom continuation message is ours and generation is stale, record `stale_turn`. The current implementation does not propagate that marker to accounting usage deltas and does not have a separate stale-turn scheduling fence; subsequent scheduling still uses the normal active-status, idle/pending-message, limit, and CAS checks. Every continuation message body is Codex's `continuation.md` verbatim: the objective is wrapped in `<objective>` as user-provided data, and the budget, evidence, fidelity, completion-audit, blocked-audit, and closing rules are stated inline.

User messages win: `hasPendingMessages()` check + CAS conflict as backstop.

## lifecycle.ts — the lifecycle policies

1. `session_start`: any restored `active` goal → commit a system transition to `paused` (the journal does not contain a separate `loaded` entry). Never silently resume; the continuation generation is not explicitly invalidated by this hook.
2. `session_before_tree`: tell continuation to void generation; next event triggers rebuild from `getBranch()` via goal-commit.
3. `session_before_compact`: append `goal.summarize()` text to the compaction if the hook allows (verify at implementation; continuation messages are self-contained regardless).
4. `agent_settled`: commit the accounting verdict, then — if the current goal is `budget_limited` and this goal instance has not been steered yet — send `budgetLimitPrompt(goal)` with `triggerTurn: true`. Steering is sent once per goal instance (`steeredGoalId`/`steered` closure state, reset on a null snapshot or a new goal id). Then run `continuation.onSettled()`.

No other business. Retry needs no lifecycle handling — accounting dedupes by message id; retry messages have new ids and are honestly counted (they cost real tokens).

## accounting rules

- Dedup key: session entry id of the assistant/toolResult message.
- Only count usage Pi reports. Missing usage → recorded as `unknown`, never assumed zero.
- toolResult.usage (nested/subagent usage) counts only when present; the coverage gap is disclosed in UI + limits.md.
- Final completing turn IS accounted (same as both reference implementations).

## prompt rules (Codex-verbatim)

`prompts.ts` copies the three Codex Goal templates byte-for-byte — the only deletion is the `update_plan` "Progress visibility" paragraph, because Pi has no `update_plan` tool.

- `continuationPrompt(goal)` (`continuation.md`): the objective inside `<objective>` as user-provided data; budget block; "Work from evidence"; "Fidelity"; completion audit; blocked audit (three consecutive goal turns); closing rules.
- `budgetLimitPrompt(goal)` (`budget_limit.md`): sent once per goal instance when the status flips to `budget_limited`.
- `objectiveUpdatedPrompt(goal)` (`objective_updated.md`): sent after a successful `/goal edit`; uses `<untrusted_objective>` and reports remaining tokens as `unknown` when no budget is set.

Substitution is trivial `{{ name }}` replacement. `escapeXmlText` (`&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`) is applied to the objective only. `tokens_used` is `input+output+cacheRead+cacheWrite`; `token_budget` is the budget or `none`; `remaining_tokens` is `max(0, budget-used)`, or `unbounded` (continuation) / `unknown` (objective update) without a budget; `time_used_seconds` is `floor((Date.now()-createdAt)/1000)`.

The blocked audit is prompt-level only: the runtime does not count blocking turns and never rejects a `blocked` declaration.

## Commands

`/goal` or `/goal status` · `/goal [--tokens N[k|M]] <objective>` (create; refuses while unfinished) · `/goal edit <objective>` · `/goal pause` · `/goal resume` · `/goal clear` · `/goal budget <tokens|none>` · `/goal turns <max-continuations>`.

A successful `create` or `resume` calls `continuation.onSettled()` so an idle session starts pursuing immediately (Codex starts the turn directly). A successful `edit` sends `objectiveUpdatedPrompt(goal)` with `triggerTurn: true`; `pause` and `clear` send nothing (the active-status check stops continuation).

## Defaults

max continuations (turns): 25 · token budget: unset (opt-in) · the blocked-loop guard is Codex's three-consecutive-turns rule in the continuation prompt and the `update_goal` description (verbatim); it is prompt-level only and not runtime-enforced.

## Declared Pi 0.85.1 limits (docs/limits.md must restate)

1. Stale already-sent continuation runs one more turn (no retraction, no selective abort).
2. Subagent/nested tokens counted only when toolResult.usage present.
3. Stale identity rides on continuation custom messages observed via `message_start`; if those events disappear, prompt self-termination is the fallback.
4. Whether compaction hook accepts appended summary needs verification; harmless if not.

## Testing

vitest or node:test (implementer's choice, state it). fake-pi support harness drives events. Required: goal transitions incl. illegal ones; CAS conflict/pending/append-failure; branch fold isolation; dedup by message id; settleTurn verdicts incl. final-turn accounting; continuation send-only-after-commit, conflict-abandon, generation fencing, stale turn; prompt templates (escaping, budget math, injection guard, no update_plan); tools schema; command flows; lifecycle policies incl. budget steering; integration replay of a full goal session on fake-pi.
