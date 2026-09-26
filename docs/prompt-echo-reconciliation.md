# Duplicate attachment prompt preview

The reported PDF/image prompt was saved once in Muse's history. The second bubble
marked **Sent** was Helicon's temporary local preview. The persisted message had
attachment references appended to its text, so exact text matching never removed
that preview while the turn was running.

The UI now reconciles an acknowledged normal or queued send using its turn/command
identity, including when the streamed message arrives before the HTTP response.
Steers share a running turn and still require a matching steered message and text.
An acknowledged repeat from another turn cannot match an older message revision.
When a turn finishes, all of its acknowledged previews are cleared. A completion
that arrives before its acknowledgement also leaves no stale Sent bubble.

For future attachment sends, Helicon supplies the original wording as displayText.
The prepared model input still includes the uploaded files and images. Explicit
display text from slash commands retains precedence. The fix does not resend,
rewrite, or delete saved prompts, and does not alter delegation or permissions.

Validation includes both acknowledgement/event orders, PDF plus image, image-only
prompts, rewritten commands, reloads, intentional repeated prompts, queued
follow-ups, steering and completion races. Replaying the actual reported message
produced one saved message plus one local preview before the fix, and one saved
message with no local preview after it. The full UI suite passed 290 tests; web
transport and startup checks passed another 11.

The frontend update can be loaded by refreshing the Helicon window. The local
backend need not restart. This addresses the demonstrated display bug; it does
not add an HTTP idempotency protocol for manual resubmission after an ambiguous
network timeout.
