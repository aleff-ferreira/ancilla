/**
 * The sample projects' files, for the file viewer and the links in replies. Each file is in the state
 * the demo's threads left it. Edits made in the demo last until the page reloads.
 */
import type { FileContent, FileEntry, FileKind, FileListing } from "@ancilla/ui";
import {
  APP_TS_AFTER,
  CURSOR_TS,
  DASHBOARD_AFTER,
  DOCS_AFTER,
  ORDERS_AFTER,
  ORDERS_TEST_AFTER,
  PROJECTS,
  REPO_GO_AFTER,
  STATUS_GO_AFTER,
  TOKENS_AFTER,
  WALKER_GO,
} from "./seed.js";

const ATLAS: Record<string, string> = {
  "README.md": `# atlas-api

The orders and billing API behind the sample storefront.

\`\`\`sh
npm install
npm run dev     # http://localhost:4000
npm test
\`\`\`

- Routes live in [src/routes](src/routes/orders.ts); the OpenAPI schema is [openapi/v2.yaml](openapi/v2.yaml).
- The TypeScript SDK in \`sdk/typescript\` is generated from that schema and published with each release.
- See [docs/api/orders.md](docs/api/orders.md) for pagination.
`,
  "package.json": `{
  "name": "atlas-api",
  "version": "2.0.0-rc.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "docs:build": "typedoc --out docs/api-ref src"
  }
}
`,
  "CHANGELOG.md": `# Changelog

## 2.0.0 (unreleased)

- Orders page with a cursor. \`page\` is ignored.
- \`Order.total\` is \`{ amount, currency }\`.
- Removed \`DELETE /v1/tokens/legacy\`.

## 1.9.0

- Webhook retries back off exponentially.
`,
  "src/app.ts": APP_TS_AFTER,
  "src/routes/orders.ts": ORDERS_AFTER,
  "src/lib/cursor.ts": CURSOR_TS,
  "test/orders.test.ts": ORDERS_TEST_AFTER,
  "docs/api/orders.md": DOCS_AFTER,
  "openapi/v2.yaml": `openapi: 3.1.0
info:
  title: atlas-api
  version: 2.0.0
paths:
  /v1/orders:
    get:
      summary: List orders, newest first
      parameters:
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
        - { name: cursor, in: query, schema: { type: string } }
      responses:
        "200":
          description: One page of orders
          content:
            application/json:
              schema:
                type: object
                required: [data, nextCursor]
                properties:
                  data: { type: array, items: { $ref: "#/components/schemas/Order" } }
                  nextCursor: { type: [string, "null"] }
components:
  schemas:
    Order:
      type: object
      required: [id, status, total, createdAt]
      properties:
        id: { type: string }
        status: { type: string, enum: [pending, paid, refunded, cancelled] }
        total:
          type: object
          properties:
            amount: { type: integer }
            currency: { type: string }
        createdAt: { type: string, format: date-time }
`,
  "migrations/0042_orders_currency.sql": `ALTER TABLE orders ADD COLUMN currency char(3) NOT NULL DEFAULT 'USD';
ALTER TABLE orders RENAME COLUMN total_cents TO total_amount;
`,
  "migrations/0043_drop_legacy_tokens.sql": `DROP TABLE IF EXISTS legacy_tokens;
`,
};

const LUMEN: Record<string, string> = {
  "README.md": `# lumen-web

The analytics dashboard. React 18, Vite 6, CSS modules.

\`\`\`sh
npm install
npm run dev
npx playwright test   # visual snapshots live next to each spec
\`\`\`
`,
  "package.json": `{
  "name": "lumen-web",
  "version": "0.9.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test:visual": "playwright test"
  }
}
`,
  "src/styles/tokens.css": TOKENS_AFTER,
  "src/pages/Dashboard.tsx": DASHBOARD_AFTER,
  "src/components/SettingsDialog.module.css": `.dialog {
  background: var(--surface);
  color: var(--text);
  border-radius: 12px;
  padding: 20px 24px;
}

.hint {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 13px;
}
`,
};

const ORBIT: Record<string, string> = {
  "README.md": `# orbit-cli

Keeps a folder of Git repos in step: \`orbit status\`, \`orbit sync\`, \`orbit each -- <cmd>\`.

\`\`\`sh
go install ./...
orbit status --json | jq '.[] | select(.dirty)'
\`\`\`
`,
  "go.mod": `module orbit

go 1.23
`,
  "main.go": `package main

import (
	"fmt"
	"os"

	"orbit/cmd"
)

func main() {
	if err := cmd.Run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "orbit:", err)
		os.Exit(1)
	}
}
`,
  "cmd/status.go": STATUS_GO_AFTER,
  "internal/workspace/repo.go": REPO_GO_AFTER,
  "internal/sync/walker.go": WALKER_GO,
};

const TREES: Record<string, Record<string, string>> = {
  [PROJECTS.atlas]: ATLAS,
  [PROJECTS.lumen]: LUMEN,
  [PROJECTS.orbit]: ORBIT,
};

interface DemoFile {
  content: string;
  mtimeMs: number;
}

function notFound(path: string): Error {
  return Object.assign(new Error(`${path} does not exist.`), { status: 404 });
}

function sizeOf(content: string): number {
  return new TextEncoder().encode(content).length;
}

export class DemoFiles {
  private readonly trees = new Map<string, Map<string, DemoFile>>();

  constructor(private readonly now: number) {}

  private tree(cwd: string): Map<string, DemoFile> {
    let tree = this.trees.get(cwd);
    if (!tree) {
      const source = TREES[cwd] ?? { "README.md": `# ${cwd.split("/").pop() ?? "project"}\n` };
      tree = new Map(Object.entries(source).map(([path, content], index) => [path, { content, mtimeMs: this.now - (index + 1) * 3_600_000 }]));
      this.trees.set(cwd, tree);
    }
    return tree;
  }

  /** Accepts a project-relative path, or an absolute one inside the project. */
  private relative(cwd: string, path: string): string {
    const prefix = `${cwd}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\.\//, "");
  }

  list(cwd: string, dir: string): FileListing {
    const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
    const entries = new Map<string, FileEntry>();
    for (const [path, file] of this.tree(cwd)) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const [head, ...rest] = path.slice(prefix.length).split("/");
      if (!head) {
        continue;
      }
      const child = `${prefix}${head}`;
      entries.set(
        child,
        rest.length > 0
          ? { name: head, path: child, kind: "dir", size: 0, mtimeMs: file.mtimeMs }
          : { name: head, path: child, kind: "file", size: sizeOf(file.content), mtimeMs: file.mtimeMs },
      );
    }
    const sorted = [...entries.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    return { path: dir, entries: sorted, truncated: false };
  }

  read(cwd: string, raw: string): FileContent {
    const path = this.relative(cwd, raw);
    const file = this.tree(cwd).get(path);
    if (!file) {
      throw notFound(path);
    }
    const name = path.split("/").pop() ?? path;
    const kind: FileKind = /\.(md|markdown|mdx)$/i.test(name) ? "markdown" : "text";
    return {
      path,
      name,
      size: sizeOf(file.content),
      mtimeMs: file.mtimeMs,
      kind,
      mediaType: kind === "markdown" ? "text/markdown" : "text/plain",
      content: file.content,
      truncated: false,
    };
  }

  write(cwd: string, raw: string, content: string): { path: string; size: number; mtimeMs: number } {
    const path = this.relative(cwd, raw);
    const file = { content, mtimeMs: Date.now() };
    this.tree(cwd).set(path, file);
    return { path, size: sizeOf(content), mtimeMs: file.mtimeMs };
  }

  search(cwd: string, query: string): FileEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.tree(cwd)]
      .filter(([path]) => words.every((word) => path.toLowerCase().includes(word)))
      .map(([path, file]) => ({ name: path.split("/").pop() ?? path, path, kind: "file" as const, size: sizeOf(file.content), mtimeMs: file.mtimeMs }));
  }
}
