// Ancilla Web Demo Virtual Filesystem
// Provides in-memory virtual project directory trees (atlas, lumen, orbit),
// path navigation, listing, reading, and searching for the interactive web demo.
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
const ATLAS_VIRTUAL_TREE: Record<string, string> = {
  ["README.md"]: `# Atlas Storefront Engine\n\nE-commerce order orchestration and payment processing microservice.\n\n### Getting Started\n\n\`\`\`bash\nnpm install\nnpm run dev        # Starts API server on http://localhost:4000\nnpm test           # Runs test suite\n\`\`\`\n\n- Endpoint handlers: [src/routes/orders.ts](src/routes/orders.ts)\n- Contract specification: [openapi/v2.yaml](openapi/v2.yaml)\n- Cursor pagination documentation: [docs/api/orders.md](docs/api/orders.md)\n`,
  ["package.json"]: `{\n  "name": "atlas-api",\n  "version": "2.0.0-rc.1",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "tsx watch src/server.ts",\n    "build": "tsc -p tsconfig.json",\n    "test": "vitest run",\n    "test:e2e": "playwright test",\n    "docs:build": "typedoc --out docs/api-ref src"\n  }\n}\n`,
  ["CHANGELOG.md"]: `# Release Notes\n\n## Version 2.0.0 (in progress)\n\n* Switch orders list to cursor pagination; deprecate numeric page offset.\n* Standardize monetary totals as structured amount and currency object.\n* Remove legacy tokens cleanup endpoint.\n\n## Version 1.9.0\n\n* Exponential backoff for outbound webhook notifications.\n`,
  ["src/app.ts"]: APP_TS_AFTER,
  ["src/routes/orders.ts"]: ORDERS_AFTER,
  ["src/lib/cursor.ts"]: CURSOR_TS,
  ["test/orders.test.ts"]: ORDERS_TEST_AFTER,
  ["docs/api/orders.md"]: DOCS_AFTER,
  ["openapi/v2.yaml"]: `# Atlas Orders Service OpenAPI Contract\nopenapi: "3.1.0"\ninfo:\n  title: "Atlas Orders API"\n  version: "2.0.0"\npaths:\n  /v1/orders:\n    get:\n      summary: "Retrieve orders collection"\n      parameters:\n        - name: "limit"\n          in: "query"\n          schema:\n            type: "integer"\n            default: 50\n            minimum: 1\n            maximum: 200\n        - name: "cursor"\n          in: "query"\n          schema:\n            type: "string"\n      responses:\n        "200":\n          description: "Paginated orders page"\n          content:\n            application/json:\n              schema:\n                type: "object"\n                required:\n                  - "data"\n                  - "nextCursor"\n                properties:\n                  data:\n                    type: "array"\n                    items:\n                      $ref: "#/components/schemas/Order"\n                  nextCursor:\n                    type:\n                      - "string"\n                      - "null"\ncomponents:\n  schemas:\n    Order:\n      type: "object"\n      required:\n        - "id"\n        - "status"\n        - "total"\n        - "createdAt"\n      properties:\n        id:\n          type: "string"\n        status:\n          type: "string"\n          enum: ["pending", "paid", "refunded", "cancelled"]\n        total:\n          type: "object"\n          properties:\n            amount:\n              type: "integer"\n            currency:\n              type: "string"\n        createdAt:\n          type: "string"\n          format: "date-time"\n`,
  ["migrations/0042_orders_currency.sql"]: `-- Migration: Add currency and update total_amount\nALTER TABLE orders ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD';\nALTER TABLE orders RENAME COLUMN total_cents TO total_amount;\n`,
  ["migrations/0043_drop_legacy_tokens.sql"]: `-- Migration: Clean up legacy tokens table\nDROP TABLE IF EXISTS legacy_tokens;\n`,
};
const LUMEN_VIRTUAL_TREE: Record<string, string> = {
  ["README.md"]: `# Lumen Analytics UI\n\nModern web dashboard for realtime store telemetry and KPI metrics.\n\n\`\`\`bash\nnpm install\nnpm run dev\nnpx playwright test\n\`\`\`\n`,
  ["package.json"]: `{\n  "name": "lumen-web",\n  "version": "0.9.0",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build",\n    "test:visual": "playwright test"\n  }\n}\n`,
  ["src/styles/tokens.css"]: TOKENS_AFTER,
  ["src/pages/Dashboard.tsx"]: DASHBOARD_AFTER,
  ["src/components/SettingsDialog.module.css"]: `/* Settings dialog modal styling */\n.dialog {\n  background: var(--surface);\n  color: var(--text);\n  border-radius: 12px;\n  padding: 20px 24px;\n}\n\n.hint {\n  margin-top: 4px;\n  color: var(--text-muted);\n  font-size: 13px;\n}\n`,
};
const ORBIT_VIRTUAL_TREE: Record<string, string> = {
  ["README.md"]: `# Orbit CLI Repository Manager\n\nWorkspace tool for multi-repository synchronization and health inspection.\n\n\`\`\`bash\ngo install ./...\norbit status --json | jq '.[] | select(.dirty)'\n\`\`\`\n`,
  ["go.mod"]: `// Orbit Go module\nmodule orbit\n\ngo 1.23\n`,
  ["main.go"]: `// Orbit CLI Entrypoint\npackage main\n\nimport (\n\t"fmt"\n\t"os"\n\n\t"orbit/cmd"\n)\n\nfunc main() {\n\tif err := cmd.Run(os.Args[1:], os.Stdout); err != nil {\n\t\tfmt.Fprintln(os.Stderr, "orbit error:", err)\n\t\tos.Exit(1)\n\t}\n}\n`,
  ["cmd/status.go"]: STATUS_GO_AFTER,
  ["internal/workspace/repo.go"]: REPO_GO_AFTER,
  ["internal/sync/walker.go"]: WALKER_GO,
};
const DEMO_WORKSPACE_SCHEMAS: Record<string, Record<string, string>> = {
  [PROJECTS.atlas]: ATLAS_VIRTUAL_TREE,
  [PROJECTS.lumen]: LUMEN_VIRTUAL_TREE,
  [PROJECTS.orbit]: ORBIT_VIRTUAL_TREE,
};
interface VirtualNodeRecord {
  readonly content: string;
  readonly mtimeMs: number;
}
function countUtf8Bytes(str: string): number {
  return new TextEncoder().encode(str).length;
}
// In-memory file provider modeling file tree queries, reads, updates, and searches
export class DemoFiles {
  private readonly projectCaches = new Map<string, Map<string, VirtualNodeRecord>>();
  public constructor(private readonly epochBaseMs: number) {}
  private getOrInitWorkspace(workingDir: string): Map<string, VirtualNodeRecord> {
    let tree = this.projectCaches.get(workingDir);
    if (tree === undefined) {
      const blueprint = DEMO_WORKSPACE_SCHEMAS[workingDir] ?? {
        "README.md": `# ${workingDir.split("/").pop() ?? "project"}\n`,
      };
      tree = new Map(
        Object.entries(blueprint).map(([filePath, data], index) => [
          filePath,
          { content: data, mtimeMs: this.epochBaseMs - (index + 1) * 3_600_000 },
        ]),
      );
      this.projectCaches.set(workingDir, tree);
    }
    return tree;
  }
  private cleanPath(workingDir: string, filePath: string): string {
    const prefix = `${workingDir}/`;
    if (filePath.startsWith(prefix)) {
      return filePath.slice(prefix.length);
    }
    return filePath.replace(/^\.\//, "");
  }
  public list(cwd: string, targetDirectory: string): FileListing {
    const directoryPrefix = targetDirectory ? `${targetDirectory.replace(/\/+$/, "")}/` : "";
    const itemsMap = new Map<string, FileEntry>();
    // Traverse virtual workspace entries
    for (const [nodePath, node] of this.getOrInitWorkspace(cwd)) {
      if (!nodePath.startsWith(directoryPrefix)) {
        continue;
      }
      const subPath = nodePath.slice(directoryPrefix.length);
      const slashIndex = subPath.indexOf("/");
      const isDirectLeaf = slashIndex === -1;
      const childSegment = isDirectLeaf ? subPath : subPath.slice(0, slashIndex);

      if (!childSegment) {
        continue;
      }
      // Compute child entry path
      const itemFullPath = `${directoryPrefix}${childSegment}`;
      if (isDirectLeaf) {
        itemsMap.set(itemFullPath, {
          name: childSegment,
          path: itemFullPath,
          kind: "file",
          size: countUtf8Bytes(node.content),
          mtimeMs: node.mtimeMs,
        });
      } else {
        itemsMap.set(itemFullPath, {
          name: childSegment,
          path: itemFullPath,
          kind: "dir",
          size: 0,
          mtimeMs: node.mtimeMs,
        });
      }
    }

    const sortedList = [...itemsMap.values()].sort((first, second) => {
      if (first.kind !== second.kind) {
        return first.kind === "dir" ? -1 : 1;
      }
      return first.name.localeCompare(second.name);
    });
    // Assemble directory listing descriptor
    const directoryListing: FileListing = {
      path: targetDirectory,
      entries: sortedList,
      truncated: false as const,
    };
    return directoryListing;
  }
  public read(cwd: string, unnormalizedPath: string): FileContent {
    const relativeKey = this.cleanPath(cwd, unnormalizedPath);
    const targetNode = this.getOrInitWorkspace(cwd).get(relativeKey);
    if (!targetNode) {
      const err = new Error(`Virtual file not found: ${relativeKey}`);
      (err as unknown as { status: number }).status = 404;
      throw err;
    }

    const baseName = relativeKey.split("/").pop() ?? relativeKey;
    const isMarkdown = /\.(md|markdown|mdx)$/i.test(baseName);
    const inferredKind: FileKind = isMarkdown ? "markdown" : "text";

    const contentDescriptor: FileContent = {
      path: relativeKey,
      name: baseName,
      size: countUtf8Bytes(targetNode.content),
      mtimeMs: targetNode.mtimeMs,
      kind: inferredKind,
      mediaType: isMarkdown ? "text/markdown" : "text/plain",
      content: targetNode.content,
      truncated: false as const,
    };
    return contentDescriptor;
  }
  public write(cwd: string, unnormalizedPath: string, payload: string): { path: string; size: number; mtimeMs: number } {
    const relativeKey = this.cleanPath(cwd, unnormalizedPath);
    const updatedRecord: VirtualNodeRecord = {
      content: payload,
      mtimeMs: Date.now(),
    };
    this.getOrInitWorkspace(cwd).set(relativeKey, updatedRecord);
    const writeResult = {
      path: relativeKey,
      size: countUtf8Bytes(payload),
      mtimeMs: updatedRecord.mtimeMs,
    };
    return writeResult;
  }
  public search(cwd: string, searchTerm: string): FileEntry[] {
    const queryParts = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
    const results: FileEntry[] = [];

    for (const [entryPath, node] of this.getOrInitWorkspace(cwd)) {
      const lowerPath = entryPath.toLowerCase();
      const allMatched = queryParts.every((word) => lowerPath.includes(word));
      if (allMatched) {
        results.push({
          name: entryPath.split("/").pop() ?? entryPath,
          path: entryPath,
          kind: "file",
          size: countUtf8Bytes(node.content),
          mtimeMs: node.mtimeMs,
        });
      }
    }

    return results;
  }
}
