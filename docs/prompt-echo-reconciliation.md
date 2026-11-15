# Technical Design Record: Prompt Echo Reconciliation & Attachment Pipeline

## 1. Problem Statement

When a developer submits a prompt containing attachments (such as PDFs, source code snippets, or images), the UI creates an immediate optimistic preview message marked **Sent** to provide instantaneous responsiveness. Under standard agent streaming protocols, the host records the user message in its canonical session store and broadcasts it back over the event stream.

Because agent runtimes normalize messages by appending structured attachment metadata to the canonical message body, exact string matching between the local preview and the canonical streamed message inevitably fails. Without reconciliation, users observe duplicate prompt bubbles—a stagnant local preview alongside the recorded canonical message—until the turn concludes.

---

## 2. Architectural Solution

Ancilla resolves message identity through structural turn and command correlation rather than volatile string comparison:

```
[ User Composer ]
        │
        ▼ (Generates Client Command ID & Optimistic Preview)
[ UI Controller ] ────► [ Local State: Status "Sent" ]
        │
        ▼ (HTTP REST / SSE Turn Dispatch)
[ Agent Server ]
        │
        ▼ (Injects `displayText` & Processes Attachments)
[ Agent CLI Host (MSP / Provider) ]
        │
        ▼ (Streamed Canonical Message Arrives)
[ UI Reconciler ]
        │
        ├─► Matches by Turn ID + Command Sequence
        ├─► Replaces Optimistic Preview with Canonical Stream
        └─► Evicts Transient Preview Bubble upon Turn Finalization
```

### 2.1 Core Reconciliation Invariants
1. **Identity Over Text**: Standard and queued submissions correlate with streamed messages via turn and command identifiers. Matching remains robust regardless of whether the HTTP response precedes or succeeds the streaming event.
2. **Steering Alignment**: Steered messages injected into an active execution correlate with their respective steered turn segment.
3. **Deliberate Repetition**: Identical prompts submitted across distinct turns retain distinct message identities, preventing false deduplication.
4. **Deterministic Eviction**: Upon turn completion, all acknowledged previews for the active turn are evicted. No orphaned **Sent** bubbles persist in the transcript.
5. **Display Fidelity (`displayText`)**: Attachments pass the original user prompt text via the `displayText` protocol field, ensuring the visual thread reflects exact user wording while the model receives fully parsed multimodal references.

---

## 3. Verification & Automated Test Matrix

The reconciliation pipeline is verified by automated test suites in `packages/ui/test/echo-reconciliation.test.ts` (executed via `npm test`):

- **Asynchronous Arrival Order**: Validates streaming events arriving before and after HTTP acknowledgment.
- **Multimodal Payloads**: Validates single-image, multi-image, and PDF attachment combinations.
- **Intentional Duplication**: Validates identical sequential text submissions without false-positive suppression.
- **Turn Interruption & Steering**: Validates live steering during executing turns.
- **Completion Race Conditions**: Confirms preview eviction when completion signals race with acknowledgment payloads.
