# One bubble per prompt

When you send a prompt, Ancilla shows it straight away as a local preview marked **Sent**, and replaces that preview
with Muse's saved copy once Muse has recorded it. With attachments this used to go wrong: a prompt with a PDF or an
image could show twice while the turn ran, once as Muse's saved message and once as the leftover **Sent** preview.

The prompt was only ever saved once. Muse appends attachment references to the text of the saved message, so matching
the preview to the saved message by exact text never succeeded, and the preview stayed until the turn ended.

## How Ancilla matches them now

- A normal or queued send is matched to Muse's message by its turn and command identity, not by text. This works in
  either order: when the streamed message arrives before the send's HTTP response, and when it arrives after.
- Steering shares a running turn, so a steer still needs a matching steered message with matching text.
- A repeated prompt acknowledged in another turn cannot match an older revision of an earlier message, so sending the
  same words twice on purpose still shows two messages.
- When a turn finishes, every acknowledged preview for it is cleared, including when the completion arrives before the
  acknowledgement. No stale **Sent** bubble is left behind.

For attachment sends, Ancilla also passes your original wording to Muse as `displayText`, so the thread shows the prompt
the way you typed it. The model still receives the uploaded files and images. Slash commands that set their own display
text keep it.

None of this resends, rewrites or deletes saved prompts, and it does not change delegation or permissions.

## Verifying it

`packages/ui/test/echo-reconciliation.test.ts` (run by `npm test`) covers both acknowledgement and event orders, a PDF
plus an image, image-only prompts, rewritten commands, reloads, intentionally repeated prompts, queued follow-ups,
steering, and completion races. Replaying a real affected message gave one saved message plus one leftover preview
before the fix, and one saved message with no preview after it.

To check it yourself, attach a PDF or an image to a prompt and send it: the thread should show one bubble for it
throughout the turn, and one after reopening the thread.

## Limits

This fixes a display problem. It does not add an idempotency protocol for resubmitting a prompt by hand after an
ambiguous network timeout.
