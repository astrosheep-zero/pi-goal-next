# pi-goal

`pi-goal` (published by this manifest as `pi-goal-next`) is a Pi 0.85.1 extension that adds a long-running `/goal`. It follows the Codex Goal semantics: the same model that performs the work audits its own progress and declares `complete`, `blocked`, or — at the user's explicit request — `paused` with `update_goal`. There is no independent auditor or human approval step.

## Installation

Install a local checkout:

```text
pi install /path/to/pi-goal
```

For a project-local extension, add the package path to the project's Pi extension configuration (the package manifest exposes `./src/index.ts`), or run Pi with the checkout available to that project. The package requires Pi 0.85.1 APIs and its declared peer packages.

## Commands

`/goal` and `/goal status` show the current goal, status, continuation count, token budget, and recorded usage.

```text
/goal Implement the migration and verify it with tests
/goal --tokens 200k Implement the migration
/goal status
/goal edit Replace the migration objective with this one
/goal pause
/goal resume
/goal budget 100000
/goal budget none
/goal turns 10
/goal clear
```

With no goal, or when the current goal is complete, `/goal <objective>` creates a fresh goal. With an unfinished goal it instead updates the objective in place (Codex `thread/goal/set` semantics): same goal id, status, token budget, and cumulative usage are preserved, and an `objective_updated` steering message is sent. `/goal edit <objective>` performs the same in-place update. The model-facing `create_goal` tool still refuses while an unfinished goal exists. `pause` and `resume` are user commands; `clear` removes the goal semantically from the journal. Token suffixes accepted by create are `k` and `M` (for example, `200k` and `2M`).

## Model tools

- `get_goal` returns the current snapshot plus `remainingBudget` and `elapsedSeconds`, or reports that no goal exists.
- `create_goal` creates an active goal after an explicit request. It accepts `objective` and optional `token_budget` (a positive integer).
- `update_goal` accepts `complete`, `blocked`, or `paused` after the model's self-audit. `paused` is honored only at the user's explicit request (prompt-level rule; the host enforces only the state machine). `complete` is permitted from `active` and `budget_limited`, not `paused` or `blocked`; the host does not validate declarations. On `complete` the result reports the final token usage.

The prompt text is copied byte-for-byte from Codex Goal (`continuation.md`, `budget_limit.md`, `objective_updated.md`); the only deletion is Codex's `update_plan` "Progress visibility" paragraph, because Pi has no `update_plan` tool. Continuation prompts state the objective inside `<objective>` as user-provided data and carry the budget, evidence, fidelity, completion-audit, and blocked-audit rules. The three-consecutive-turn blocked audit is prompt-level guidance; the runtime does not enforce it.

## State machine

```text
                         /goal resume (user)
                    +---------------------------+
                    |                           v
                  paused <-------------------- active --------------------> complete
                    ^                 /goal pause       update_goal complete
                    |                         |
 session_start      |                         v
 restored active ---+                       blocked
                                             ^
                         update_goal blocked|

 active --accounting limit--> budget_limited --update_goal complete--> complete
 any unfinished --/goal clear--> no goal
```

`complete` is terminal. It may be declared from `active` or `budget_limited`, never from `paused` or `blocked`. A goal is one journal-folded goal per session branch; a new goal cannot be created until the prior one is complete (or cleared). `blocked` is a model declaration, not an automatic retry decision. Codex's three-consecutive-turn blocker guard lives verbatim in the continuation prompt and the `update_goal` description; it is prompt-level only, not enforced in runtime code.

## Limits and accounting

- The default maximum is 25 continuation turns (`maxContinuations`) per run. Change it with `/goal turns N`. `/goal resume` resets the run's continuation count and immediately schedules work when idle. It preserves the objective, journal history, cumulative usage, and token budget. If the token budget is exhausted or the continuation allowance is zero, resume reports the limit instead of claiming success.
- A token budget is unset by default. Set one at creation with `/goal --tokens N[k|M] ...` or later with `/goal budget N`.
- Usage comes directly from each completed assistant/tool-result event. Repeated delivery of the same live message object is deduplicated. Pi has not assigned a session entry id at this event boundary; historical messages are not re-accounted on reload.
- In usage journal intents, omitted usage fields serialize as zero; an explicit `null` preserves existing unknown semantics. An absent entire Pi usage object remains unknown.
- Nested or subagent usage is counted only when Pi exposes it as `toolResult.usage` data; see [limits](docs/limits.md).
- Usage is attributed to the goal that owns the run. The final completing turn remains charged; runs begun after a goal is complete, paused, or blocked are unrelated and are not charged to it.

## Completion and blocking contract

The model calls `update_goal` after auditing the current goal against the Codex completion audit carried in every continuation prompt. The host accepts `complete` and `blocked` at face value and performs no independent verification; the prompt is the only guard. `paused` via the tool requires the user's explicit request and is otherwise indistinguishable from a user `/goal pause`. `complete` may transition an `active` or `budget_limited` goal and reports final token usage; it is prohibited from `paused` and `blocked`. `blocked` is meant to follow three consecutive turns with the same blocker. Runtime accounting may instead move an active goal to `budget_limited`; the model cannot declare that state, and the transition triggers one `budget_limit.md` steering message.

Automatic continuation waits for a fresh normal assistant completion and for the entire Pi run to settle, including tools, retries, compaction, and queued input. Errors, cancellation (including cancellation after text finishes), and runs ending at a tool boundary do not trigger continuation or budget steering. Ordinary user input has no continuation attached; once the response to that input finishes normally, an active goal may continue.

Continuation messages are sent only after a successful journal commit. The plugin checks cancellation, goal state, and pending input again after that commit, immediately before sending. A continuation carries the goal id, generation, and sequence number. Input received during scheduling invalidates the automatic send. Explicit `/goal` create/resume can start work immediately when idle.
