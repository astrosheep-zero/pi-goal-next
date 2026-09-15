# Pi 0.85.1 limits

The extension uses the public Pi 0.85.1 event, session, message, and send APIs. The following limits are intentional. Each item states what cannot be guaranteed, what the extension does, and what a user may observe.

## Declared boundaries

### Stale already-sent continuation

**Cannot guarantee:** Pi cannot retract a message already sent with `triggerTurn`, and `abort` cannot selectively cancel only that goal message.

**What it does:** On `message_start`, the extension recognizes its continuation custom message whose generation is stale and records `goal.stale_turn` once. It does not abort the turn. Later scheduling still uses the normal active-status, idle/pending-message, limit, and CAS checks; there is no separate stale-turn scheduling fence.

**User sees:** A stale continuation can still run one more model turn. Its prompt says to call `get_goal` and stop if the goal is paused or cleared. If the goal remains active and normal checks pass after that turn, another continuation can be scheduled.

### Nested and subagent usage

**Cannot guarantee:** Pi does not expose nested or subagent token usage consistently for every tool result.

**What it does:** Counts nested usage only when it is present in `toolResult.usage`. In usage journal intents, omitted usage fields serialize as zero; an explicit `null` preserves existing unknown semantics. An absent entire Pi usage object remains unknown. Top-level assistant and tool-result events are deduplicated by live message-object identity, since their session entry IDs do not yet exist during `message_end`. Journaled usage survives reload; historical events are not counted again.

**User sees:** The status line can show `unknown messages=N`, and budget totals can be lower than provider-side totals when nested usage was not reported. If a usage journal write fails, automatic continuation is suppressed and the next message or settled event retries it. Pending, uncommitted usage is held in memory and cannot survive a reload or branch change.

### Goal-owned run usage

**Cannot guarantee:** Usage for an in-flight response cannot be split precisely at the instant a user pauses or replaces a goal.

**What it does:** Attributes usage to the goal that owns a run. A goal's final completing run remains charged; later unrelated runs after it is complete, paused, or blocked do not charge that goal.

**User sees:** Finishing, pausing, or blocking a goal does not cause later unrelated conversation usage to accumulate against it.

### Continuation message identity

**Cannot guarantee:** Pi may stop emitting message events for custom messages in a future boundary.

**What it does:** Carries `{ goalId, generation }` on the continuation custom message and checks it on `message_start`.

**User sees:** If Pi stops emitting custom-message events, stale turns degrade to prompt self-termination only; subsequent continuation remains subject to normal checks.

### Compaction and goal context

**Cannot guarantee:** Pi controls the content and timing of its normal conversation summary.

**What it does:** Does not override Pi's compaction summary. Goal state remains in a separate journal and is restored through `get_goal` and self-contained continuation prompts.

**User sees:** Normal conversation compaction proceeds under Pi's standard behavior; the goal remains available independently of that summary.

## Additional implementation boundaries

### Session reload

**Cannot guarantee:** Restoring a session does not prove that an in-flight continuation was never sent before the process stopped.

**What it does:** Invalidates outstanding scheduling, rebuilds from the selected branch, and converts any restored `active` goal to `paused` with a system transition. It does not silently resume.

**User sees:** A restored active goal is paused and requires `/goal resume`. A previously sent message may still be present in the provider transcript, but the restored status prevents normal continuation scheduling.

### Branch/tree navigation

**Cannot guarantee:** The pre-tree hook does not expose the post-navigation branch.

**What it does:** Invalidates the continuation generation immediately, then rebuilds from `getBranch()` on the next lifecycle event.

**User sees:** Goal status and journal state follow the newly selected branch after the next event; a continuation leased before the tree change cannot send after invalidation.

### Stale usage marker coverage

**Cannot guarantee:** The current lifecycle path does not pass the stale-turn marker into accounting's per-message delta.

**What it does:** Persists a `goal.stale_turn` journal entry. Accounting's `stale` set is available to its own callers but is not populated by `continuation.onTurnStart`; the stale journal entry is also not a separate scheduling fence.

**User sees:** Usage totals remain counted normally, and the UI may not show a stale count for a stale continuation even though the journal records it.

### Completion self-audit scope

**Cannot guarantee:** The host does not independently verify a `complete` declaration.

**What it does:** Copies Codex's completion audit verbatim into every continuation prompt and into the `update_goal` description, and accepts only `complete` or `blocked`. There is no host-side evidence check, no required summary/evidence fields, and no tool-call counter.

**User sees:** A mistaken `complete` declaration is accepted at face value; the prompt is the only guard.

### Continuation and user-input ordering

**Cannot guarantee:** Event delivery and message queue timing are controlled by Pi.

**What it does:** Requires a fresh normal completion and an uncancelled run. Input receipt invalidates pending scheduling before Pi queues the message; its delivery clears the input-preflight fence. Idle/queue state, cancellation, and lifecycle eligibility are checked both before and after the continuation CAS commit. Pi does not expose an atomic journal-commit-and-start-if-idle operation, so a cancelled attempt may consume a continuation sequence number without sending a prompt.

**User sees:** A continuation can be skipped after a race with user input; the goal remains available after a later normal completion or explicit resume. If another extension handles/rejects input without delivering a user message, automatic scheduling stays suppressed until a later user message is delivered; explicit resume remains available.
