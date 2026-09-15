# pi-goal

`pi-goal` (published by this manifest as `pi-goal-next`) is a Pi 0.85.1 extension that adds a long-running `/goal`. It follows the Codex Goal semantics: the same model that performs the work audits its own progress and declares `complete` or `blocked` with `update_goal`. There is no independent auditor or human approval step.

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

Creating a goal is refused while an unfinished goal exists. `edit` clears the current goal and creates a new active goal with its limits preserved. `pause` and `resume` are user commands; `clear` removes the goal semantically from the journal. Token suffixes accepted by create are `k` and `M` (for example, `200k` and `2M`).

## Model tools

- `get_goal` returns the current snapshot plus `remainingBudget` and `elapsedSeconds`, or reports that no goal exists.
- `create_goal` creates an active goal after an explicit request. It accepts `objective` and optional `token_budget` (a positive integer).
- `update_goal` accepts only `complete` or `blocked` after the model's self-audit. The host does not validate the declaration; on `complete` the result reports the final token usage.

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

 active --accounting limit--> budget_limited
 any unfinished --/goal clear--> no goal
```

`complete` is terminal. A goal is one journal-folded goal per session branch; a new goal cannot be created until the prior one is complete (or cleared). `blocked` is a model declaration, not an automatic retry decision. Codex's three-consecutive-turn blocker guard lives verbatim in the continuation prompt and the `update_goal` description; it is prompt-level only, not enforced in runtime code.

## Limits and accounting

- The default maximum is 25 continuation turns (`maxContinuations`). Change it with `/goal turns N`.
- A token budget is unset by default. Set one at creation with `/goal --tokens N[k|M] ...` or later with `/goal budget N`.
- Usage is attributed by message entry id, separately for assistant and tool-result messages. Duplicate entry ids are ignored.
- Missing provider usage is recorded as unknown, never treated as confirmed zero.
- Nested or subagent usage is counted only when Pi exposes it as `toolResult.usage` data; see [limits](docs/limits.md).
- The final completing turn is included in accounting.

## Completion and blocking contract

The model calls `update_goal` after auditing the current goal against the Codex completion audit carried in every continuation prompt. The host accepts `complete` and `blocked` at face value and performs no independent verification; the prompt is the only guard. `complete` reports final token usage in the tool result, and `blocked` is meant to follow three consecutive turns with the same blocker. `paused` is user-only (`/goal pause`). Runtime accounting may instead move an active goal to `budget_limited`; the model cannot declare that state, and the transition triggers one `budget_limit.md` steering message.

Continuation messages are sent only after a successful journal commit and only while Pi is idle with no pending messages. A continuation carries the goal id, generation, and sequence number. User input and compare-and-swap conflicts prevent a new continuation from being sent.
