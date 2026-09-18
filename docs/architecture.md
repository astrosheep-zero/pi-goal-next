# Architecture — pi-goal (authoritative design contract)

All implementers follow this document exactly. Deviations require a new design round, not local invention.

## Product

Pi 0.85.1 extension package adding a long-running `/goal`. Behavior follows Codex Goal (`codex-rs/ext/goal`) as the baseline: the *same executing model* audits its own completion and calls `update_goal`. **No independent auditor, no human approval gate.** What differs is only what Pi's public API forces.

## Status set (goal.ts)

`active | paused | blocked | budget_limited | complete`

- Model's `update_goal` accepts only: `complete` | `blocked` | `paused` (paused at the user's explicit request, prompt-level only). `complete` is permitted from `active` and `budget_limited`, but not from `paused` or `blocked`. The model self-audits; the host does not validate the declaration.
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
| `clock.ts` | Active wall-clock baseline (`sync`/`peek`/`markAccounted`), Codex `GoalWallClockAccounting` equivalent. Pure, injectable `now`. | journaling, goal state |
| `continuation.ts` | `generation` lease, `agent_settled` decision, commit-then-sendMessage, stale handling. The ONLY sender of continuation messages. | building UI, reading store, deciding acceptance |
| `prompts.ts` | Pure: the three Codex-verbatim goal templates — `continuationPrompt(goal)`, `budgetLimitPrompt(goal)`, `objectiveUpdatedPrompt(goal)`; `escapeXmlText` applies to the objective only. | IO, model calls, host-side validation |
| `tools.ts` | Codex-verbatim tool descriptions, TypeBox schema → `goalCommit.commit` → tool result. Three tools: get_goal / create_goal / update_goal. `update_goal` accepts complete\|blocked\|paused and reports final usage on complete. | writing rules text, touching store/continuation |
| `commands.ts` | `/goal` subcommands → goal-commit. | direct store access |
| `lifecycle.ts` | Event ordering, live-message identities, run cancellation signal, and input/settlement fences. Session/branch/compaction policies plus budget-limit steering, see below. | holding Goal state |
| `ui.ts` | status/widget text from `current()` + `accounting.summary()`. Read-only. | writes |
| `index.ts` | dependency assembly + registration only. | logic |

Dependency direction: `index → {tools, commands, lifecycle, ui} → {goal-commit, accounting, continuation, prompts} → {goal, store}`. `goal.ts` and `prompts.ts` have zero dependencies.

## goal-commit CAS contract

```ts
current(): GoalSnapshot | null            // { goal, revision }
getRevision(): number                     // available even when current() is null
commit(intent, expectedRevision): Promise<{ ok, snapshot } | { conflict, snapshot }>
subscribe(fn): unsubscribe
```

Internally: check `revision === expectedRevision` and no pending → mark pending → `await store.append` → success: swap in, revision+1, notify; failure: release pending, report. `getRevision()` remains available after a clear, so a clear→create sequence can use the current CAS revision. Critical section wraps one append only — never verification, prompt building, or sendMessage.

## Two counters

- `revision` (goal-commit): +1 per commit, CAS basis.
- `generation` (continuation): invalidated on session restore, tree navigation, input receipt, and user-message delivery. Pause and clear are protected by the active-status check and the commit CAS. Every continuation message carries `{ goalId, generation, seq }` in details. A separate lifecycle epoch rejects settlement work overtaken by another run or input.

## Continuation protocol

`message_end` captures the current event's stop reason. Only a fresh `stop` or `length` response authorizes automatic work at `agent_settled`, after Pi has drained tools, retries, compaction, and queued messages. Settlement consumes that authorization once. The run's captured abort signal must not be aborted, no new input may be awaiting delivery, and Pi must be idle with no queued messages.

Then read `current()` → `commit(continuation_sent {generation}, revision)` → recheck lifecycle authorization, generation, goal identity/status, idle state, and pending messages → `pi.sendMessage(continuation, { triggerTurn: true })`. On conflict or invalidation, abandon this attempt. An abandoned attempt may consume a sequence number because Pi cannot atomically commit the journal and admit a new turn. Explicit `/goal` create/resume can start idle work without a preceding assistant response.

Stale continuation: Pi has no message retraction and `abort` cannot selectively cancel a goal message, so **never abort**. On `message_start`, lifecycle notifies continuation; if the custom continuation message is ours and generation is stale, record `stale_turn`. The current implementation does not propagate that marker to accounting usage deltas and does not have a separate stale-turn scheduling fence; subsequent scheduling still uses the normal active-status, idle/pending-message, limit, and CAS checks. Every continuation message body is Codex's `continuation.md` verbatim: the objective is wrapped in `<objective>` as user-provided data, and the budget, evidence, fidelity, completion-audit, blocked-audit, and closing rules are stated inline.

User messages win: `input` invalidates outstanding continuation attempts before Pi queues the message. Delivery at `message_start` clears the input-preflight fence and invalidates old completion state. Idle/queue checks are repeated after the commit await. Ordinary input injects no goal prompt; a normal response to that input may continue the still-active goal once the whole run settles.

## lifecycle.ts — the lifecycle policies

1. `session_start`: invalidate pending work, rebuild, and transition any restored `active` goal to `paused`. Never silently resume.
2. `session_before_tree`: invalidate pending work; the next event rebuilds from the selected branch.
3. Pi generates its normal conversation summary without a goal override. Goal state remains in its separate journal; `get_goal` and continuation prompts restore the relevant goal context.
4. `agent_start`: reset completion state and capture `ctx.signal`. Retain that signal after Pi clears its current signal at idle, so cancellation during message/agent-end handlers still suppresses continuation.
5. `message_end`: account the current message and capture its stop reason. Pi dispatches this hook **before** appending the message to SessionManager; never substitute the last persisted same-role message.
6. `input` / user `message_start`: invalidate old scheduling and track input receipt through delivery.
7. `agent_settled`: require and consume a fresh normal, uncancelled completion. Apply accounting limits, recheck input/run eligibility, and send budget steering once per goal instance if eligible. Otherwise run `continuation.onSettled(canSend)` with the same eligibility checks across the commit await. Error, aborted, toolUse-only, and empty runs send nothing.

Retry messages are separately accounted because each response costs real tokens. Only the final successful run can authorize continuation.

## accounting rules

- Dedup key: an in-memory ID assigned by WeakMap to each assistant/toolResult event message object. Session entry IDs do not yet exist at `message_end`. Usage deltas are journaled immediately; historical messages are not replayed into accounting on reload. A message is acknowledged only after its usage commit succeeds. Failed writes remain pending for the next message or settled event; unresolved writes suppress automatic continuation.
- Usage is attributed to the goal that owns the run. The final run completing a goal remains charged; later unrelated runs after complete, pause, or block do not charge that goal.
- In usage journal intents, omitted usage fields serialize as zero; an explicit `null` preserves existing unknown semantics. An absent entire Pi usage object remains unknown.
- Time accounting follows Codex: a wall-clock baseline runs only while the goal is `active` (paused/budget-limited/complete/blocked time never accrues, and pause→resume gaps are excluded because every committed transition re-syncs the clock via `goalCommit.subscribe`). The accrued whole-second delta rides the first usage commit of each flush as the `seconds` field; the baseline advances only after that commit is durable, so failed writes keep the full delta for the retry. A flush with no pending message usage still journals idle active time as a time-only `goal.usage` entry (token fields zero), and user `message_start` triggers such a flush. `goal.timeUsedSeconds` is the journaled cumulative total; pre-feature journal snapshots without the field fold to `0`.
- toolResult.usage (nested/subagent usage) counts only when present; the coverage gap is disclosed in UI + limits.md.
- Final completing turn IS accounted (same as both reference implementations).

## prompt rules (Codex-verbatim)

`prompts.ts` copies the three Codex Goal templates byte-for-byte — the only deletion is the `update_plan` "Progress visibility" paragraph, because Pi has no `update_plan` tool.

- `continuationPrompt(goal)` (`continuation.md`): the objective inside `<objective>` as user-provided data; budget block; "Work from evidence"; "Fidelity"; completion audit; blocked audit (three consecutive goal turns); closing rules.
- `budgetLimitPrompt(goal)` (`budget_limit.md`): sent once per goal instance when the status flips to `budget_limited`.
- `objectiveUpdatedPrompt(goal)` (`objective_updated.md`): sent after a successful in-place objective update (`/goal <new>` or `/goal edit` on an unfinished goal); uses `<untrusted_objective>` and reports remaining tokens as `unbounded` when no budget is set.

Substitution is trivial `{{ name }}` replacement. `escapeXmlText` (`&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`) is applied to the objective only. `tokens_used` is `input+output+cacheRead+cacheWrite`; `token_budget` is the budget or `none`; `remaining_tokens` is `max(0, budget-used)`, or `unbounded` without a budget; `time_used_seconds` is the goal's journaled active wall-clock total (`timeUsedSeconds`).

The blocked audit is prompt-level only: the runtime does not count blocking turns and never rejects a `blocked` declaration.

## Commands

`/goal` or `/goal status` · `/goal [--tokens N[k|M]] <objective>` (create, or in-place objective update while unfinished — Codex `thread/goal/set` semantics) · `/goal edit <objective>` (same in-place update) · `/goal pause` · `/goal resume` · `/goal clear` · `/goal budget <tokens|none>` · `/goal turns <max-continuations>`.

A successful `resume` atomically journals `resetContinuations: true` on the user transition to active, resetting the run's continuation count while preserving the objective, usage, budget, and historical entries. It also accepts an already-active goal. Exhausted token budgets and zero continuation allowances are reported without resuming. A successful `create` or `resume` calls `continuation.onSettled()` so an idle session starts pursuing immediately (Codex starts the turn directly). A successful in-place objective update atomically appends `goal.objective_updated`, preserving the goal id, status, limits, and cumulative usage, then sends `objectiveUpdatedPrompt(goal)` with `triggerTurn: true`; `pause` and `clear` send nothing (the active-status check stops continuation).

## Defaults

max continuations (turns): 25 · token budget: unset (opt-in) · the blocked-loop guard is Codex's three-consecutive-turns rule in the continuation prompt and the `update_goal` description (verbatim); it is prompt-level only and not runtime-enforced.

## Declared Pi 0.85.1 limits (docs/limits.md must restate)

1. Stale already-sent continuation runs one more turn (no retraction, no selective abort).
2. Subagent/nested tokens counted only when toolResult.usage present.
3. Stale identity rides on continuation custom messages observed via `message_start`; if those events disappear, prompt self-termination is the fallback.
4. Pi owns normal conversation-summary generation; goal context is restored separately from the journal through `get_goal` and continuation prompts.

## Testing

node:test covers goal transitions, journal replay, CAS conflicts, limits, prompts, commands, and lifecycle races. `test/pi-session.test.ts` additionally runs real Pi 0.85.1 AgentSessions with in-memory settings/sessions and a deterministic model stream (no network). It verifies pre-append event ordering, usage accounting, normal→error/abort transitions, abort during streaming and at message/agent-end boundaries, steering delivery, and the absence of a continuation attached to user input. The pre-fix 0.1.4 code fails the real-session error/abort regressions.
