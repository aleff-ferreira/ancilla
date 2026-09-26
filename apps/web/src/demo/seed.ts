/**
 * The demo's fictional workspace: three sample projects under /home/demo and the threads in them.
 * Every name, path, file and number here is made up. Times are relative to when the page loads, so
 * the sidebar always reads "just now", "2 hours ago" and so on.
 */
import type { ApprovalRequest, LiveView, MspItem, SessionSummary, ViewEvent } from "@ancilla/ui";
import { DAY, HOUR, MIN, MODEL, Script, iso, sampleId } from "./script.js";

export const HOME = "/home/demo";

export const PROJECTS = {
  atlas: `${HOME}/code/atlas-api`,
  lumen: `${HOME}/code/lumen-web`,
  orbit: `${HOME}/code/orbit-cli`,
} as const;

/** Thread ids, fixed so a `#/t/<id>` link keeps working across reloads. */
export const THREADS = {
  audit: "01a0f3c4-6d2e-7b1a-8c3f-5e9d2a7b4c10",
  pagination: "01a0f2b8-1c4d-7e2f-9a3b-6c8d4e2f1a07",
  contrast: "01a0f3d1-8e5a-7c2b-b4d6-2f9e1a3c5b88",
  lazyCharts: "01a0f3b9-2a7c-7d4e-8f1b-9c3e5a7d2b46",
  statusJson: "01a0f2e0-5b3d-7a9c-a2e4-1d6f8b3c7e21",
  syncHang: "01a0ef41-9d2c-7b5e-8a3f-4c1e7b9d2a63",
  rateLimit: "01a0ed12-3f8b-7c1d-9e4a-6b2d8f1c3a95",
  vite: "01a0e8a7-7c1e-7f3b-b5d2-8e4a1c6f9b30",
} as const;

/** The second account the settings page lists; orbit-cli's threads run under it. */
export const SIDE_ACCOUNT = "side";

export interface SeedThread {
  summary: SessionSummary;
  events: ViewEvent[];
  /** The view cursor's sequence so far; live events continue it. */
  seq: number;
  approvals: ApprovalRequest[];
}

/** One agent of the running audit workflow, and what it is doing now. */
export interface AuditChild {
  childId: string;
  label: string;
  state: "working" | "waiting" | "completed" | "cancelled" | "skipped";
  /** What a working agent reports it is on; the demo steps through these so the run looks alive. */
  phases: string[];
  durationMs?: number;
  toolCalls?: number;
}

/** The native Muse workflow running in the audit thread, as one item Muse revises as it goes. */
export interface AuditRun {
  sessionId: string;
  turnId: string;
  itemId: string;
  callId: string;
  runId: string;
  revision: number;
  status: "inProgress" | "completed" | "cancelled";
  tick: number;
  children: AuditChild[];
  summary: string | null;
}

export interface Seed {
  threads: SeedThread[];
  audit: AuditRun;
}

function live(patch: Partial<LiveView> = {}): LiveView {
  return {
    activeTurnId: null,
    turnStartedAt: null,
    pendingApprovals: 0,
    pendingInputs: 0,
    lastTerminal: "completed",
    lastError: null,
    ...patch,
  };
}

function thread(
  script: Script,
  title: string,
  turnCount: number,
  extra: Partial<SessionSummary> = {},
  approvals: ApprovalRequest[] = [],
): SeedThread {
  const first = script.events[0]?.at ?? script.at;
  return {
    summary: {
      sessionId: script.sessionId,
      cwd: script.cwd,
      title,
      titleSource: "auto",
      turnCount,
      modelId: MODEL,
      origin: "ancilla",
      archived: false,
      createdAt: iso(first),
      activityAt: iso(script.at),
      settled: false,
      settledAt: null,
      unsettledAt: null,
      sandboxDisabled: false,
      accountId: null,
      live: live(),
      ...extra,
    },
    events: script.events,
    seq: script.seq,
    approvals,
  };
}

function reconciledMessage(body: Record<string, unknown>): string {
  return `<workflow-launch-reconciled>${JSON.stringify(body)}</workflow-launch-reconciled>`;
}

/** The workflow item at the run's current revision, the shape the Agents panel and workflow card read. */
export function auditItem(run: AuditRun, at: number): MspItem {
  const finished = run.children.filter((child) => child.state === "completed" && child.durationMs !== undefined);
  return {
    itemId: run.itemId,
    kind: "workflow",
    status: run.status,
    revision: run.revision,
    turnId: run.turnId,
    recordedAt: iso(at),
    entryId: "generated.model-chosen",
    scriptId: "generated.workflow.generated.model-chosen",
    triggerSource: "guidanceAuto",
    workflowRunId: run.runId,
    fallbackText: "Workflow: model-chosen generated workflow",
    message: reconciledMessage({
      type: "workflow-launch-reconciled",
      call_id: run.callId,
      route: "guidance",
      launch_admitted: true,
      deferred_to_background: false,
      agents_activity: finished.map((child) => ({ agent: child.childId, duration_ms: child.durationMs, tool_calls: child.toolCalls ?? 0 })),
      final_summary: run.summary ? { status: "success", summary: run.summary } : null,
      latest_failure: null,
    }),
    children: run.children.map((child) => {
      const base = { childId: child.childId, attempt: 1, label: child.label };
      switch (child.state) {
        case "working":
          return { ...base, status: "started", phase: child.phases[run.tick % Math.max(1, child.phases.length)] };
        case "waiting":
          return { ...base, status: "scheduled" };
        default:
          return {
            ...base,
            status: "terminal",
            terminal: child.state,
            ...(child.durationMs !== undefined ? { durationMs: child.durationMs } : {}),
          };
      }
    }),
  };
}

/** The report the synthesis agent writes, once the demo lets the run finish. */
export const AUDIT_SUMMARY = [
  "## Breaking changes since v1.9.0",
  "",
  "1. **`GET /v1/orders` pages with a cursor.** `page` is ignored; clients must follow `nextCursor`.",
  "2. **`Order.total` is an object** (`{ amount, currency }`) instead of a number of cents.",
  "3. **`DELETE /v1/tokens/legacy` is gone**, along with the `legacy_tokens` table.",
  "",
  "Webhook payloads and every other route are unchanged.",
].join("\n");

// ------------------------------------------------------------------------------------------ threads

/** Running now: a native workflow fanned out to four auditors and a synthesis agent. */
function auditThread(now: number): { thread: SeedThread; run: AuditRun } {
  const s = new Script(THREADS.audit, PROJECTS.atlas, now - 7 * MIN, { branch: "release/v2.0" });
  const turnId = s.begin(
    "We're about to tag v2.0. Audit everything that changed since v1.9.0 for breaking changes: route handlers, the OpenAPI schema, the TypeScript SDK and the database migrations. Run the checks in parallel and give me one report I can paste into the release notes.",
  );
  s.think(
    "**Splitting the audit**\n\nThe four areas are independent, so they can run side by side: routes, schema, SDK and migrations. A last agent merges what they find into one report.",
    2600,
  );
  s.todos([
    { text: "Scope the diff since v1.9.0", status: "inProgress", activeForm: "Scoping the diff since v1.9.0" },
    { text: "Audit routes, schema, SDK and migrations in parallel", status: "pending" },
    { text: "Merge the findings into release-note wording", status: "pending" },
  ]);
  s.tool(
    "bash",
    { command: "git diff --stat v1.9.0..HEAD -- src openapi sdk migrations", description: "See what changed since v1.9.0" },
    [
      " migrations/0042_orders_currency.sql    |  18 +++",
      " migrations/0043_drop_legacy_tokens.sql |   9 ++",
      " openapi/v2.yaml                        | 214 ++++++++++++-------",
      " sdk/typescript/src/client.ts           |  23 +--",
      " sdk/typescript/src/orders.ts           |  61 +++---",
      " src/routes/orders.ts                   |  74 ++++---",
      " src/routes/tokens.ts                   |  41 ++---",
      " src/routes/webhooks.ts                 |  36 +++-",
      " 8 files changed, 311 insertions(+), 165 deletions(-)",
      "",
    ].join("\n"),
    3100,
  );
  s.bill(38_400, 610);
  s.todos([
    { text: "Scope the diff since v1.9.0", status: "completed" },
    { text: "Audit routes, schema, SDK and migrations in parallel", status: "inProgress", activeForm: "Auditing routes, schema, SDK and migrations in parallel" },
    { text: "Merge the findings into release-note wording", status: "pending" },
  ]);
  const callId = "call_01a0f3c4e7b2";
  s.tool(
    "workflow",
    {
      args: JSON.stringify({ goal: "Audit atlas-api for breaking changes between v1.9.0 and HEAD", mode: "thorough" }),
      script: [
        "export default async function workflow(host) {",
        '  phase("Parallel audit");',
        "  const areas = [\"scan-routes\", \"Diff OpenAPI schema\", \"Check TypeScript SDK\", \"review-migrations\"];",
        "  const findings = await Promise.all(areas.map((area) => host.agent(area)));",
        '  phase("Synthesis");',
        '  return host.agent("synthesis-report", { findings });',
        "}",
      ].join("\n"),
    },
    undefined,
    4200,
    { callId },
  );
  s.bill(41_900, 1_240);
  const child = (label: string) => sampleId(`${THREADS.audit}:agent:${label}`);
  const run: AuditRun = {
    sessionId: THREADS.audit,
    turnId,
    itemId: s.id("workflow"),
    callId,
    runId: `workflow-run-model-tool-call_${callId.slice(5)}`,
    revision: 18,
    status: "inProgress",
    tick: 0,
    summary: null,
    children: [
      { childId: child("scan-routes"), label: "scan-routes", state: "completed", phases: [], durationMs: 51_000, toolCalls: 9 },
      {
        childId: child("openapi"),
        label: "Diff OpenAPI schema",
        state: "working",
        phases: [
          "Comparing response schemas for /v1/orders",
          "Checking enum changes in OrderStatus",
          "Looking for removed query parameters",
          "Comparing webhook payload schemas",
        ],
      },
      {
        childId: child("sdk"),
        label: "Check TypeScript SDK",
        state: "working",
        phases: [
          "Reading sdk/typescript/src/orders.ts",
          "Type-checking the v1.9 examples against the new SDK",
          "Checking renamed exports in client.ts",
        ],
      },
      { childId: child("review-migrations"), label: "review-migrations", state: "completed", phases: [], durationMs: 37_000, toolCalls: 6 },
      { childId: child("synthesis-report"), label: "synthesis-report", state: "waiting", phases: [] },
    ],
  };
  s.at += 900;
  s.push("item/started", { item: auditItem({ ...run, revision: 1, children: run.children.map((c) => ({ ...c, state: "waiting" as const })) }, s.at) }, 0);
  s.at = now - 20_000;
  s.push("item/updated", { item: auditItem(run, s.at) }, 0);
  const thread0 = thread(s, "Audit the v2 API for breaking changes", 1, {
    activityAt: iso(now - 20_000),
    live: live({ activeTurnId: turnId, turnStartedAt: iso(now - 7 * MIN + 600), lastTerminal: null }),
  });
  return { thread: thread0, run };
}

/** Finished: cursor pagination, with edits across three files and passing tests. */
function paginationThread(now: number): SeedThread {
  const s = new Script(THREADS.pagination, PROJECTS.atlas, now - 74 * MIN, { branch: "feat/orders-cursor" });
  s.begin(
    "GET /v1/orders still uses offset pagination and gets slow past page 200. Switch it to cursor pagination (keep `limit`, default 50, max 200) and update the tests.",
  );
  s.think(
    "**Reading the orders route**\n\nThe handler turns `page` into `skip`, so every deep page scans all the rows before it. A cursor on `(createdAt, id)` makes each page an index seek.",
  );
  s.tool("read", { file_path: "src/routes/orders.ts" }, ORDERS_BEFORE, 1900);
  s.tool(
    "grep",
    { pattern: "listOrders|page=", path: "." },
    'src/routes/orders.ts:6:export async function listOrders(req: Request, res: Response) {\nsrc/app.ts:12:app.get("/v1/orders", listOrders);\ntest/orders.test.ts:14:    const res = await request(app).get("/v1/orders?page=2");\n',
    2100,
  );
  s.tool("read", { file_path: "test/orders.test.ts" }, ORDERS_TEST_BEFORE, 1700);
  s.bill(29_800, 540);
  s.tool("write", { file_path: "src/lib/cursor.ts", content: CURSOR_TS }, undefined, 6800);
  s.tool(
    "multi_edit",
    {
      file_path: "src/routes/orders.ts",
      edits: [
        {
          old_string: 'import { db } from "../db.js";\n\nconst PAGE_SIZE = 50;',
          new_string: 'import { db } from "../db.js";\nimport { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";\n\nconst PAGE_SIZE = 50;\nconst MAX_PAGE_SIZE = 200;',
        },
        { old_string: ORDERS_HANDLER_BEFORE, new_string: ORDERS_HANDLER_AFTER },
      ],
    },
    undefined,
    5400,
  );
  s.tool("edit", { file_path: "test/orders.test.ts", old_string: ORDERS_TEST_OLD, new_string: ORDERS_TEST_NEW }, undefined, 5100);
  s.bill(36_200, 2_180);
  s.tool(
    "bash",
    { command: "npm test -- test/orders.test.ts", description: "Run the orders tests" },
    "\n> atlas-api@2.0.0-rc.1 test\n> vitest run test/orders.test.ts\n\n RUN  v2.1.8 /home/demo/code/atlas-api\n\n ✓ test/orders.test.ts (4 tests) 184ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n   Duration  1.12s\n",
    8200,
  );
  s.say(
    [
      "`GET /v1/orders` now pages with a cursor instead of an offset.",
      "",
      "- [src/routes/orders.ts](src/routes/orders.ts) reads `cursor` and `limit` (default 50, max 200) and answers `{ data, nextCursor }`. It fetches one extra row to know whether another page exists.",
      "- [src/lib/cursor.ts](src/lib/cursor.ts) encodes the `(createdAt, id)` pair as an opaque base64url string, so clients never depend on its shape.",
      "- A malformed cursor answers `400` instead of an empty page.",
      "",
      "All four orders tests pass. Clients that still send `page` now get the first page, which is worth a line in the changelog.",
    ].join("\n"),
  );
  s.bill(39_100, 420);
  s.end(161_000);

  s.begin("Add a short note about it to the API docs.", 5 * MIN);
  s.tool("read", { file_path: "docs/api/orders.md" }, DOCS_BEFORE, 1500);
  s.tool("edit", { file_path: "docs/api/orders.md", old_string: DOCS_PAGINATION_OLD, new_string: DOCS_PAGINATION_NEW }, undefined, 4300);
  s.say(
    "Added a **Pagination** section to [docs/api/orders.md](docs/api/orders.md) with a request example, and noted that `page` is deprecated and now returns the first page.",
  );
  s.bill(40_300, 610);
  s.end(38_000);
  return thread(s, "Add cursor pagination to GET /v1/orders", 2);
}

/** Waiting: an edit is in, and a shell command needs approval before it runs. */
function contrastThread(now: number): SeedThread {
  const s = new Script(THREADS.contrast, PROJECTS.lumen, now - 4 * MIN, { branch: "fix/dark-contrast" });
  const turnId = s.begin(
    "The muted text in the settings dialog is hard to read in dark mode. Fix the contrast without touching the light theme, then update the visual snapshots.",
  );
  s.think(
    "**Checking the dark-mode tokens**\n\n`--text-muted` is `#6b7280` in both themes. On the dark surface that is 3.8:1, under the 4.5:1 WCAG AA minimum for body text.",
  );
  s.tool(
    "grep",
    { pattern: "--text-muted", path: "src" },
    "src/styles/tokens.css:4:  --text-muted: #6b7280;\nsrc/styles/tokens.css:10:  --text-muted: #6b7280;\nsrc/components/SettingsDialog.module.css:12:  color: var(--text-muted);\nsrc/components/Sidebar.module.css:31:  color: var(--text-muted);\n",
    1800,
  );
  s.tool("read", { file_path: "src/styles/tokens.css" }, TOKENS_BEFORE, 1600);
  s.bill(22_600, 480);
  s.tool("edit", { file_path: "src/styles/tokens.css", old_string: TOKENS_DARK_OLD, new_string: TOKENS_DARK_NEW }, undefined, 4700);
  const command = "npx playwright test settings-dialog --update-snapshots";
  const pending = s.add(
    {
      kind: "toolCall",
      tool: "bash",
      callId: "call_01a0f3d1b9c4",
      args: JSON.stringify({ command, description: "Update the settings dialog's visual snapshots" }),
    },
    3300,
    "item/started",
  );
  s.bill(24_100, 390);
  const approval: ApprovalRequest = {
    approvalId: sampleId(`${THREADS.contrast}:approval`),
    sessionId: THREADS.contrast,
    itemId: pending.itemId,
    turnId,
    toolName: "bash",
    toolCallId: "call_01a0f3d1b9c4",
    currentRequirementId: "req-1",
    subject: { kind: "shell", command, workspaceRoot: PROJECTS.lumen },
    availableChoices: [
      { choiceId: "remember", label: "Allow and remember", decision: "approved", scope: "session", rulePreview: "npx playwright test *" },
      { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
      { choiceId: "reject", label: "Reject", decision: "denied", scope: "once", acceptsFeedback: true },
    ],
  };
  s.push("approval/requested", approval as unknown as Record<string, unknown>, 200);
  return thread(
    s,
    "Fix low-contrast muted text in dark mode",
    1,
    { live: live({ activeTurnId: turnId, turnStartedAt: iso(now - 4 * MIN + 600), pendingApprovals: 1, lastTerminal: null }) },
    [approval],
  );
}

/** Finished a few minutes ago and not opened since, so the sidebar marks it unread. */
function lazyChartsThread(now: number): SeedThread {
  const s = new Script(THREADS.lazyCharts, PROJECTS.lumen, now - 12 * MIN, { branch: "perf/lazy-charts" });
  s.begin("The dashboard's first load pulls in the whole charts library. Load it only when a chart is actually rendered.");
  s.tool(
    "grep",
    { pattern: 'from "@/charts"', path: "src" },
    'src/pages/Dashboard.tsx:1:import { RevenueChart } from "@/charts";\nsrc/pages/Reports.tsx:5:import { RevenueChart, UsageChart } from "@/charts";\n',
    1700,
  );
  s.tool("read", { file_path: "src/pages/Dashboard.tsx" }, DASHBOARD_BEFORE, 1500);
  s.bill(19_800, 360);
  s.tool("edit", { file_path: "src/pages/Dashboard.tsx", old_string: DASHBOARD_OLD, new_string: DASHBOARD_NEW }, undefined, 4200);
  s.tool(
    "bash",
    { command: "npm run build", description: "Build to compare chunk sizes" },
    "\n> lumen-web@0.9.0 build\n> vite build\n\nvite v6.0.7 building for production...\n✓ 412 modules transformed.\ndist/index.html                      0.61 kB │ gzip:  0.38 kB\ndist/assets/index-3f9c1a2e.css      18.40 kB │ gzip:  4.71 kB\ndist/assets/RevenueChart-8b2e4d71.js 231.64 kB │ gzip: 71.12 kB\ndist/assets/index-c41d9e07.js       148.21 kB │ gzip: 47.90 kB\n✓ built in 2.84s\n",
    7600,
  );
  s.say(
    "The charts now load on demand. [src/pages/Dashboard.tsx](src/pages/Dashboard.tsx) imports `RevenueChart` with `React.lazy` and shows the card's skeleton while it loads. The entry chunk dropped from **379 kB to 148 kB** (gzip 119 kB to 48 kB); the charts arrive as their own 232 kB chunk the first time the dashboard renders one. `Reports.tsx` still imports them eagerly, which is fine since every report has a chart.",
  );
  s.bill(21_400, 520);
  s.end(64_000);
  return thread(s, "Lazy-load the charts bundle", 1);
}

/** Finished this morning under the second account. */
function statusJsonThread(now: number): SeedThread {
  const s = new Script(THREADS.statusJson, PROJECTS.orbit, now - 3 * HOUR - 12 * MIN, { branch: "main" });
  s.begin("Add a --json flag to `orbit status` so scripts can read it. Keep the human output as the default.");
  s.tool("read", { file_path: "cmd/status.go" }, STATUS_GO_BEFORE, 1500);
  s.tool("read", { file_path: "internal/workspace/repo.go" }, REPO_GO_BEFORE, 1300);
  s.bill(14_200, 300);
  s.tool(
    "multi_edit",
    {
      file_path: "cmd/status.go",
      edits: [
        { old_string: 'import (\n\t"flag"\n\t"fmt"\n\t"io"', new_string: 'import (\n\t"encoding/json"\n\t"flag"\n\t"fmt"\n\t"io"' },
        {
          old_string: '\tfs := flag.NewFlagSet("status", flag.ContinueOnError)\n\tif err := fs.Parse(args); err != nil {',
          new_string: '\tfs := flag.NewFlagSet("status", flag.ContinueOnError)\n\tasJSON := fs.Bool("json", false, "print machine-readable JSON")\n\tif err := fs.Parse(args); err != nil {',
        },
        {
          old_string: "\tfor _, r := range repos {",
          new_string: '\tif *asJSON {\n\t\tenc := json.NewEncoder(out)\n\t\tenc.SetIndent("", "  ")\n\t\treturn enc.Encode(repos)\n\t}\n\tfor _, r := range repos {',
        },
      ],
    },
    undefined,
    5200,
  );
  s.tool("edit", { file_path: "internal/workspace/repo.go", old_string: REPO_STRUCT_OLD, new_string: REPO_STRUCT_NEW }, undefined, 3100);
  s.tool("bash", { command: "go test ./...", description: "Run the tests" }, "ok  \torbit/cmd\t0.214s\nok  \torbit/internal/sync\t0.388s\nok  \torbit/internal/workspace\t0.102s\n", 6400);
  s.tool(
    "bash",
    { command: "go run . status --json", description: "Try the new flag" },
    '[\n  {\n    "name": "atlas-api",\n    "branch": "release/v2.0",\n    "ahead": 3,\n    "behind": 0,\n    "dirty": false\n  },\n  {\n    "name": "lumen-web",\n    "branch": "fix/dark-contrast",\n    "ahead": 1,\n    "behind": 2,\n    "dirty": true\n  }\n]\n',
    3900,
  );
  s.say(
    "`orbit status --json` now prints the tracked repos as an indented JSON array; without the flag the table is unchanged. The field names come from new `json` tags on `workspace.Repo` in [internal/workspace/repo.go](internal/workspace/repo.go), so they stay lowercase and stable even if the Go fields get renamed.",
  );
  s.bill(17_900, 470);
  s.end(71_000);
  return thread(s, "Add --json output to orbit status", 1, { accountId: SIDE_ACCOUNT });
}

/** Finished yesterday: a question, answered from the code without changing it. */
function syncHangThread(now: number): SeedThread {
  const s = new Script(THREADS.syncHang, PROJECTS.orbit, now - 26 * HOUR, { branch: "main" });
  s.begin("`orbit sync` hangs forever on repos with more than about 10k files. Why?");
  s.tool("grep", { pattern: "chan ", path: "internal/sync" }, "internal/sync/walker.go:13:\tpaths := make(chan string)\ninternal/sync/walker.go:14:\tresults := make(chan Entry)\ninternal/sync/walker.go:15:\terrs := make(chan error)\n", 1600);
  s.tool("read", { file_path: "internal/sync/walker.go" }, WALKER_GO, 1400);
  s.think(
    "**Following the error path**\n\n`errs` is unbuffered and only read after `results` is drained, but `results` only closes once every worker has returned.",
  );
  s.bill(16_300, 820);
  s.say(
    [
      "It is a deadlock in [internal/sync/walker.go](internal/sync/walker.go#L22-L26), and repo size only matters because big repos are the ones likely to contain an unreadable path.",
      "",
      "1. A worker that fails to `stat` a path sends the error on `errs`, which is unbuffered.",
      "2. Nothing reads `errs` until the `results` loop ends, so that worker blocks forever.",
      "3. `wg.Wait()` never returns, `results` is never closed, and the loop over it waits forever too.",
      "",
      "A broken symlink or a permission-denied folder is enough to trigger it. This reproduces it on any machine:",
      "",
      "```sh",
      "mkdir -p /tmp/repro && ln -s missing /tmp/repro/broken && orbit sync /tmp/repro",
      "```",
      "",
      "The smallest fix is to drop the second channel: give `Entry` an `Err` field, send failures on `results` like any other entry, and return the first error after the loop. Want me to make that change and add the repro as a test?",
    ].join("\n"),
  );
  s.bill(18_100, 640);
  s.end(52_000);
  return thread(s, "Why does orbit sync hang on large repos?", 1, { accountId: SIDE_ACCOUNT, origin: "muse" });
}

/** Two days old. */
function rateLimitThread(now: number): SeedThread {
  const s = new Script(THREADS.rateLimit, PROJECTS.atlas, now - 2 * DAY - 3 * HOUR, { branch: "main" });
  s.begin("Rate-limit POST /v1/login to 10 attempts per minute per IP.");
  s.tool("read", { file_path: "src/app.ts" }, APP_TS, 1500);
  s.tool("edit", { file_path: "src/app.ts", old_string: APP_LOGIN_OLD, new_string: APP_LOGIN_NEW }, undefined, 4100);
  s.tool("bash", { command: "npm test -- test/login.test.ts", description: "Run the login tests" }, " ✓ test/login.test.ts (3 tests) 96ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n", 6100);
  s.say(
    "`POST /v1/login` now allows 10 attempts per IP per minute and answers `429` with a `Retry-After` header after that. The limiter keeps its counts in memory, so they reset on restart and are per instance; point it at a shared store before running more than one instance.",
  );
  s.bill(21_700, 690);
  s.end(47_000);
  return thread(s, "Rate-limit the login endpoint", 1, { live: null });
}

/** Almost a week old and shelved, so it sits in the project's settled list. */
function viteThread(now: number): SeedThread {
  const s = new Script(THREADS.vite, PROJECTS.lumen, now - 6 * DAY - 2 * HOUR, { branch: "main" });
  s.begin("Upgrade Vite to v6 and fix whatever breaks.");
  s.tool("bash", { command: "npm install -D vite@6 @vitejs/plugin-react@4", description: "Upgrade Vite" }, "\nchanged 14 packages, and audited 402 packages in 6s\n\nfound 0 vulnerabilities\n", 2200);
  s.tool("bash", { command: "npm run build", description: "Check the build" }, "vite v6.0.7 building for production...\n✓ 409 modules transformed.\n✓ built in 2.91s\n", 7400);
  s.say("Vite 6 builds cleanly with no config changes. The only difference in output is that CSS chunks are now hashed with 8 characters instead of 7.");
  s.bill(12_400, 250);
  s.end(29_000);
  return thread(s, "Upgrade to Vite 6", 1, { live: null, settled: true, settledAt: iso(now - 4 * DAY) });
}

export function seed(now: number): Seed {
  const audit = auditThread(now);
  return {
    threads: [
      audit.thread,
      contrastThread(now),
      lazyChartsThread(now),
      paginationThread(now),
      statusJsonThread(now),
      syncHangThread(now),
      rateLimitThread(now),
      viteThread(now),
    ],
    audit: audit.run,
  };
}

// ------------------------------------------------------------------------------------ file contents

export const ORDERS_HANDLER_BEFORE = `export async function listOrders(req: Request, res: Response) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = await db.order.findMany({
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });
  res.json({ page, data: rows });
}`;

export const ORDERS_HANDLER_AFTER = `export async function listOrders(req: Request, res: Response) {
  const limit = Math.min(Math.max(Number(req.query.limit) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = req.query.cursor === undefined ? null : decodeCursor(String(req.query.cursor));
  if (req.query.cursor !== undefined && !cursor) {
    return res.status(400).json({ error: "invalid_cursor" });
  }
  const rows = await db.order.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    where: cursor ? afterCursor(cursor) : undefined,
    take: limit + 1,
  });
  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  res.json({ data, nextCursor: more ? encodeCursor(data[data.length - 1]!) : null });
}`;

export const ORDERS_BEFORE = `import type { Request, Response } from "express";
import { db } from "../db.js";

const PAGE_SIZE = 50;

${ORDERS_HANDLER_BEFORE}
`;

export const ORDERS_AFTER = `import type { Request, Response } from "express";
import { db } from "../db.js";
import { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

${ORDERS_HANDLER_AFTER}
`;

export const CURSOR_TS = `/** Opaque page cursors: the last row's sort key, base64url-encoded so clients never parse it. */
export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString("base64url");
}

export function decodeCursor(value: string): Cursor | null {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown[];
    if (typeof createdAt !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(createdAt))) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Rows strictly after the cursor, in (createdAt desc, id desc) order. */
export function afterCursor(cursor: Cursor) {
  const createdAt = new Date(cursor.createdAt);
  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }],
  };
}
`;

export const ORDERS_TEST_OLD = `  it("returns the second page", async () => {
    const res = await request(app).get("/v1/orders?page=2");
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.data).toHaveLength(50);
  });`;

export const ORDERS_TEST_NEW = `  it("returns the first page with a next cursor", async () => {
    const res = await request(app).get("/v1/orders?limit=20");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.nextCursor).toEqual(expect.any(String));
  });

  it("follows the cursor without repeating rows", async () => {
    const first = await request(app).get("/v1/orders?limit=20");
    const second = await request(app).get(\`/v1/orders?limit=20&cursor=\${first.body.nextCursor}\`);
    const seen = new Set(first.body.data.map((order: { id: string }) => order.id));
    expect(second.body.data.some((order: { id: string }) => seen.has(order.id))).toBe(false);
  });

  it("caps limit at 200", async () => {
    const res = await request(app).get("/v1/orders?limit=5000");
    expect(res.body.data.length).toBeLessThanOrEqual(200);
  });

  it("rejects a malformed cursor", async () => {
    const res = await request(app).get("/v1/orders?cursor=not-a-cursor");
    expect(res.status).toBe(400);
  });`;

const ORDERS_TEST_HEAD = `import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";

describe("GET /v1/orders", () => {
  it("returns the newest orders first", async () => {
    const res = await request(app).get("/v1/orders");
    expect(res.status).toBe(200);
    const dates = res.body.data.map((order: { createdAt: string }) => order.createdAt);
    expect(dates).toEqual([...dates].sort().reverse());
  });

`;

export const ORDERS_TEST_BEFORE = `${ORDERS_TEST_HEAD}${ORDERS_TEST_OLD}\n});\n`;
export const ORDERS_TEST_AFTER = `${ORDERS_TEST_HEAD}${ORDERS_TEST_NEW}\n});\n`;

export const DOCS_PAGINATION_OLD = `## Pagination

Pass \`page\` (1-based) to fetch later pages. Each page holds 50 orders.
`;

export const DOCS_PAGINATION_NEW = `## Pagination

Results come newest first, \`limit\` orders at a time (default 50, at most 200). Each response carries
\`nextCursor\`; pass it back as \`cursor\` to fetch the next page. It is \`null\` on the last page.

\`\`\`http
GET /v1/orders?limit=2&cursor=WyIyMDI2LTA5LTI1VDEwOjQyOjAwLjAwMFoiLCJvcmRfOGsyIl0
\`\`\`

\`page\` is deprecated: it is ignored and returns the first page.
`;

const DOCS_HEAD = `# Orders

\`GET /v1/orders\` lists the orders the API key can see.

| Field | Type | Notes |
| --- | --- | --- |
| \`id\` | string | Stable, prefixed \`ord_\` |
| \`status\` | string | \`pending\`, \`paid\`, \`refunded\` or \`cancelled\` |
| \`total\` | object | \`{ amount, currency }\`, amount in minor units |
| \`createdAt\` | string | ISO 8601 |

`;

export const DOCS_BEFORE = `${DOCS_HEAD}${DOCS_PAGINATION_OLD}`;
export const DOCS_AFTER = `${DOCS_HEAD}${DOCS_PAGINATION_NEW}`;

export const TOKENS_DARK_OLD = `[data-theme="dark"] {
  --surface: #111418;
  --text: #f3f4f6;
  --text-muted: #6b7280;
}`;

export const TOKENS_DARK_NEW = `[data-theme="dark"] {
  --surface: #111418;
  --text: #f3f4f6;
  /* 7.7:1 on --surface; #6b7280 was 3.8:1, under WCAG AA. */
  --text-muted: #a1a8b3;
}`;

const TOKENS_LIGHT = `:root {
  --surface: #ffffff;
  --text: #111827;
  --text-muted: #6b7280;
}
`;

export const TOKENS_BEFORE = `${TOKENS_LIGHT}\n${TOKENS_DARK_OLD}\n`;
export const TOKENS_AFTER = `${TOKENS_LIGHT}\n${TOKENS_DARK_NEW}\n`;

export const DASHBOARD_OLD = `import { RevenueChart } from "@/charts";
import { Card } from "@/components/Card";`;

export const DASHBOARD_NEW = `import { lazy, Suspense } from "react";
import { Card, CardSkeleton } from "@/components/Card";

// The charts library is the biggest thing on this page; load it only once a chart renders.
const RevenueChart = lazy(() => import("@/charts").then((charts) => ({ default: charts.RevenueChart })));`;

const DASHBOARD_BODY = `
import { useMetrics } from "@/hooks/useMetrics";

export function Dashboard() {
  const metrics = useMetrics();
  return (
    <main className="grid gap-4 md:grid-cols-3">
      <Card title="Active users" value={metrics.activeUsers} />
      <Card title="Signups this week" value={metrics.signups} />
      <Card title="Churn" value={\`\${metrics.churn}%\`} />
      <section className="md:col-span-3">
        <RevenueChart data={metrics.revenue} />
      </section>
    </main>
  );
}
`;

export const DASHBOARD_BEFORE = `${DASHBOARD_OLD}${DASHBOARD_BODY}`;
export const DASHBOARD_AFTER = `${DASHBOARD_NEW}${DASHBOARD_BODY.replace(
  "        <RevenueChart data={metrics.revenue} />",
  "        <Suspense fallback={<CardSkeleton height={320} />}>\n          <RevenueChart data={metrics.revenue} />\n        </Suspense>",
)}`;

export const STATUS_GO_BEFORE = `package cmd

import (
	"flag"
	"fmt"
	"io"

	"orbit/internal/workspace"
)

// Status prints where every tracked repo stands.
func Status(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	repos, err := workspace.Load()
	if err != nil {
		return err
	}
	for _, r := range repos {
		fmt.Fprintf(out, "%-24s %-20s %d ahead, %d behind\\n", r.Name, r.Branch, r.Ahead, r.Behind)
	}
	return nil
}
`;

export const STATUS_GO_AFTER = `package cmd

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"orbit/internal/workspace"
)

// Status prints where every tracked repo stands, as a table or, with --json, for scripts.
func Status(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	repos, err := workspace.Load()
	if err != nil {
		return err
	}
	if *asJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(repos)
	}
	for _, r := range repos {
		fmt.Fprintf(out, "%-24s %-20s %d ahead, %d behind\\n", r.Name, r.Branch, r.Ahead, r.Behind)
	}
	return nil
}
`;

export const REPO_STRUCT_OLD = `type Repo struct {
	Name   string
	Branch string
	Ahead  int
	Behind int
	Dirty  bool
}`;

export const REPO_STRUCT_NEW = `type Repo struct {
	Name   string \`json:"name"\`
	Branch string \`json:"branch"\`
	Ahead  int    \`json:"ahead"\`
	Behind int    \`json:"behind"\`
	Dirty  bool   \`json:"dirty"\`
}`;

const REPO_GO_HEAD = `package workspace

// Repo is one repository orbit tracks, with how far its branch is from upstream.
`;

export const REPO_GO_BEFORE = `${REPO_GO_HEAD}${REPO_STRUCT_OLD}\n`;
export const REPO_GO_AFTER = `${REPO_GO_HEAD}${REPO_STRUCT_NEW}\n`;

export const WALKER_GO = `package sync

import (
	"io/fs"
	"path/filepath"
	gosync "sync"
)

// Walk stats every file under root with a pool of workers.
func Walk(root string, workers int) ([]Entry, error) {
	var wg gosync.WaitGroup

	paths := make(chan string)
	results := make(chan Entry)
	errs := make(chan error)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range paths {
				e, err := stat(p)
				if err != nil {
					errs <- err
					continue
				}
				results <- e
			}
		}()
	}

	go func() {
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			paths <- p
			return nil
		})
		close(paths)
	}()

	go func() {
		wg.Wait()
		close(results)
		close(errs)
	}()

	var out []Entry
	for e := range results {
		out = append(out, e)
	}
	if err := <-errs; err != nil {
		return nil, err
	}
	return out, nil
}
`;

export const APP_LOGIN_OLD = `app.post("/v1/login", login);`;

export const APP_LOGIN_NEW = `// 10 attempts per IP per minute; counts live in memory, so they are per instance.
const loginLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true });
app.post("/v1/login", loginLimit, login);`;

const APP_HEAD = `import express from "express";
import { rateLimit } from "./lib/rate-limit.js";
import { login } from "./routes/auth.js";
import { listOrders } from "./routes/orders.js";

export const app = express();
app.use(express.json());

`;

export const APP_TS = `${APP_HEAD}${APP_LOGIN_OLD}
app.get("/v1/orders", listOrders);
`;

export const APP_TS_AFTER = `${APP_HEAD}${APP_LOGIN_NEW}
app.get("/v1/orders", listOrders);
`;
