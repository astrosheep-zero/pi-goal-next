# Pi 0.85.1 limits

The extension uses the public Pi 0.85.1 event, session, message, and send APIs. The following limits are intentional. Each item states what cannot be guaranteed, what the extension does, and what a user may observe.

## Declared boundaries

### Stale already-sent continuation

**Cannot guarantee:** Pi cannot retract a message already sent with `triggerTurn`, and `abort` cannot selectively cancel only that goal message.

**What it does:** On `message_start`, the extension recognizes its continuation custom message whose generation is stale and records `goal.stale_turn` once. It does not abort the turn. Later scheduling still uses the normal active-status, idle/pending-message, limit, and CAS checks; there is no separate stale-turn scheduling fence.

**User sees:** A stale continuation can still run one more model turn. Its prompt says to call `get_goal` and stop if the goal is paused or cleared. If the goal remains active and normal checks pass after that turn, another continuation can be scheduled.

### Nested and subagent usage

**Cannot guarantee:** Pi does not expose nested or subagent token usage consistently for every tool result.

**What it does:** Counts nested usage only when it is present in `toolResult.usage`; missing usage is recorded as unknown. Top-level assistant and tool-result messages are deduplicated by entry id.

**User sees:** The status line can show `unknown messages=N`, and budget totals can be lower than provider-side totals when nested usage was not reported.

### Continuation message identity

**Cannot guarantee:** Pi may stop emitting message events for custom messages in a future boundary.

**What it does:** Carries `{ goalId, generation }` on the continuation custom message and checks it on `message_start`.

**User sees:** If Pi stops emitting custom-message events, stale turns degrade to prompt self-termination only; subsequent continuation remains subject to normal checks.

### Compaction extension content

**Cannot guarantee:** Pi may not accept extension-provided appended compaction content on every hook/version path.

**What it does:** The 0.85.1 hook accepts a `CompactionResult`; it returns the goal summary when the hook provides `preparation.firstKeptEntryId` and numeric `tokensBefore`. The defensive field check remains for older/newer hook variants. Continuation prompts remain self-contained.

**User sees:** After some compactions the normal goal summary may be absent from the compaction context, while the goal itself remains in the journal.

## Additional implementation boundaries

### Session reload

**Cannot guarantee:** Restoring a session does not prove that an in-flight continuation was never sent before the process stopped.

**What it does:** Rebuilds from the selected branch and converts any restored `active` goal to `paused` with a system transition. It does not silently resume and does not explicitly invalidate the continuation generation in this hook.

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

**What it does:** Requires idle state and no pending messages before the continuation CAS commit, then sends only after that commit succeeds. A user message arriving concurrently is handled by the pending-message check or a CAS conflict.

**User sees:** A continuation can be skipped after a race with user input; the goal remains available for the next settled event or explicit resume.
