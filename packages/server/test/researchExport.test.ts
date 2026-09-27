import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { ResearchEvent, ResearchInput, ResearchRunState } from "@ancilla/daemon";
import type { ResearchEngine } from "../src/research/index.js";
import {
  modernizeCitations,
  parseReport,
  questionSlug,
  renderDocx,
  renderHtml,
  renderPdf,
  splitReport,
  toWinAnsi,
} from "../src/research/export/index.js";
import { FakeConnection, get, send, start, waitFor } from "./harness.js";

// ---------------------------------------------------------------- fixtures

const QUESTION = "Why does the Amazon rainforest matter?";
const META = { question: QUESTION, endedAt: "2026-09-26T10:05:00.000Z" };

const REPORT = `# Why the Amazon matters

The Amazon holds roughly **10%** of known species[^1] and stores 150–200 billion tonnes of carbon[^2][^3].
See *“The lungs of the planet”* — a phrase that is still used. A comparison: 1 < 2 and <script>alert(1)</script>.

## Threats

1. Deforestation for cattle[^1]
2. Mining and \`illegal\` logging
   - Nested bullet with [a link](https://example.org/nested)
   - Another one
3. Climate feedbacks

> A blockquote with a citation[^3].

\`\`\`js
const carbon = 150e9; // tonnes
\`\`\`

| Region | Loss (km²) | Share |
| --- | ---: | :---: |
| Brazil | 11,000 | 60% |

---

![A map](https://example.org/map.png)

## Sources

[^1]: [Protecting the Amazon: Why This Rainforest Matters | WWF](https://www.worldwildlife.org/places/amazon)
[^2]: [Fauna of the Amazon rainforest](https://en.wikipedia.org/wiki/Fauna_of_the_Amazon_rainforest)
[^3]: <https://example.com/bare>
`;

const OLD_REPORT = `# Q

An answer [1] and more [2][1]. Not a citation: [7] or [1](https://x.example/).

## Sources

[1] Title One (https://a.example/x)
[2] https://b.example/y
`;

/** The files of a zip, by name: the central directory read back to front, entries stored or deflated. */
function unzip(buffer: Buffer): Map<string, Buffer> {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) {
    eocd -= 1;
  }
  assert.ok(eocd >= 0, "zip end-of-central-directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory entry");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert.equal(buffer.readUInt32LE(local), 0x04034b50, "local file header");
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataAt, dataAt + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function count(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}

// ---------------------------------------------------------------- markdown

describe("research export: markdown", () => {
  it("brings an older [n] report to the footnote form and leaves a newer one alone", () => {
    const modern = modernizeCitations(OLD_REPORT);
    assert.match(modern, /An answer \[\^1\] and more \[\^2\]\[\^1\]\./);
    assert.match(modern, /Not a citation: \[7\] or \[1\]\(https:\/\/x\.example\/\)\./, "unknown numbers and link text keep their brackets");
    assert.match(modern, /^\[\^1\]: \[Title One\]\(https:\/\/a\.example\/x\)$/m);
    assert.match(modern, /^\[\^2\]: \[https:\/\/b\.example\/y\]\(https:\/\/b\.example\/y\)$/m);
    assert.equal(modernizeCitations(REPORT), REPORT);
    assert.equal(modernizeCitations("# Q\n\nNo sources [1] here.\n"), "# Q\n\nNo sources [1] here.\n");
  });

  it("splits the body from the sources, numbering them in order of first citation", () => {
    const root = parseReport(`Second[^b] then first[^a] and second again[^b].\n\n## Sources\n\n[^a]: [A](https://a.example/)\n[^b]: [B](https://b.example/)\n[^c]: Only a title\n`);
    const split = splitReport(root);
    assert.deepEqual(
      split.sources.map((s) => [s.id, s.number, s.title, s.url]),
      [
        ["b", 1, "B", "https://b.example/"],
        ["a", 2, "A", "https://a.example/"],
        ["c", 3, "Only a title", null],
      ],
    );
    assert.equal(split.numberOf.get("b"), 1);
    assert.deepEqual(split.body.map((node) => node.type), ["paragraph"], "definitions and the empty Sources heading are gone");
  });

  it("parses an older report's sources through the same path", () => {
    const split = splitReport(parseReport(OLD_REPORT));
    assert.deepEqual(split.sources.map((s) => [s.number, s.title, s.url]), [[1, "Title One", "https://a.example/x"], [2, "https://b.example/y", "https://b.example/y"]]);
  });
});

// ---------------------------------------------------------------- html

describe("research export: html", () => {
  it("renders a standalone page with linked citations and a numbered sources list", () => {
    const html = renderHtml(parseReport(REPORT), META);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Why does the Amazon rainforest matter\?<\/title>/);
    assert.match(html, /<h1>Why does the Amazon rainforest matter\?<\/h1>/);
    assert.match(html, /Deep research report · Ancilla · 2026-09-26/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /<sup class="cite"><a href="#src-1">1<\/a><\/sup>/);
    assert.match(html, /carbon<sup class="cite"><a href="#src-2">2<\/a><\/sup><sup class="cite"><a href="#src-3">3<\/a><\/sup>/);
    assert.match(html, /<ol id="sources">/);
    assert.match(html, /<li id="src-1"><a href="https:\/\/www\.worldwildlife\.org\/places\/amazon" rel="noopener">Protecting the Amazon: Why This Rainforest Matters \| WWF<\/a> <span class="url">https:\/\/www\.worldwildlife\.org\/places\/amazon<\/span><\/li>/);
    assert.match(html, /<li id="src-3"><a href="https:\/\/example\.com\/bare"/);
    assert.equal(count(html, /<li id="src-/g), 3);
    assert.match(html, /<a href="https:\/\/example\.org\/nested">a link<\/a>/);
    assert.match(html, /<pre><code class="language-js">const carbon/);
    assert.match(html, /<th align="right">Loss \(km²\)<\/th>/);
    assert.match(html, /<blockquote>/);
    assert.match(html, /<hr>/);
    assert.match(html, /A map/, "an image renders as its alt text");
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<script>/, "text is escaped");
    assert.match(html, /1 (?:&lt;|&#x3C;) 2/);
    assert.doesNotMatch(html, /Sources<\/h1>|<h2>Sources<\/h2>/, "the report's own Sources heading is replaced by the rendered list's");
    assert.match(html, /<h2 id="sources-heading">Sources<\/h2>/);
  });

  it("renders a report without sources and no footnotes", () => {
    const html = renderHtml(parseReport("Just a paragraph."), { question: "Q", endedAt: null });
    assert.match(html, /<p>Just a paragraph\.<\/p>/);
    assert.doesNotMatch(html, /id="sources"/);
    assert.match(html, /Deep research report · Ancilla</);
  });
});

// ---------------------------------------------------------------- docx

describe("research export: docx", () => {
  it("packs a Word document with the question, hyperlinked sources and bookmarked citations", async () => {
    const buffer = await renderDocx(parseReport(REPORT), META);
    assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK");
    const files = unzip(buffer);
    const document = files.get("word/document.xml")?.toString("utf8") ?? "";
    assert.ok(document.includes(QUESTION), "the title is in the body");
    assert.ok(document.includes("Deep research report · Ancilla · 2026-09-26"));
    assert.ok(document.includes('<w:bookmarkStart w:name="src_1"'), "a bookmark on the first source");
    assert.ok(document.includes('<w:bookmarkStart w:name="src_3"'));
    assert.ok(document.includes('w:anchor="src_1"'), "citations jump to the bookmark");
    assert.ok(document.includes("<w:vertAlign w:val=\"superscript\"/>"), "citations are superscript");
    assert.ok(document.includes("Protecting the Amazon: Why This Rainforest Matters | WWF"));
    assert.ok(document.includes("https://www.worldwildlife.org/places/amazon"), "the bare URL follows the title");
    assert.ok(document.includes("<w:tbl>"), "a table");
    assert.ok(document.includes("Consolas"), "code in a monospace font");
    assert.ok(document.includes("<w:numPr>"), "list numbering");
    assert.ok(!document.includes("<img") && document.includes("A map"), "images render as alt text");
    const rels = files.get("word/_rels/document.xml.rels")?.toString("utf8") ?? "";
    assert.match(rels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/hyperlink" Target="https:\/\/www\.worldwildlife\.org\/places\/amazon" TargetMode="External"/);
    assert.match(rels, /Target="https:\/\/example\.org\/nested"/);
    const footer = [...files.entries()].find(([name]) => /^word\/footer\d*\.xml$/.test(name))?.[1].toString("utf8") ?? "";
    assert.match(footer, /PAGE/);
    assert.match(footer, /NUMPAGES/);
  });
});

// ---------------------------------------------------------------- pdf

describe("research export: pdf", () => {
  it("writes a PDF with link annotations, named destinations and one page for a short report", async () => {
    const buffer = await renderPdf(parseReport(REPORT), META);
    const text = buffer.toString("latin1");
    assert.equal(text.slice(0, 5), "%PDF-");
    assert.equal(count(text, /\/Type \/Page\b/g), 1);
    assert.ok(text.includes("/URI (https://www.worldwildlife.org/places/amazon)"), "a source title links to its URL");
    assert.ok(text.includes("/URI (https://example.org/nested)"), "a body link is clickable");
    // Three sources, each with a linked title and a linked bare URL (the third's title is its URL), one body link.
    assert.equal(count(text, /\/URI \(/g), 7);
    // Five citations in the body, each a GoTo onto a named destination at its source.
    assert.equal(count(text, /\/Type \/Annot/g), 12);
    assert.equal(count(text, /\/S \/GoTo\s+\/D \(src-1\)/g), 2);
    assert.equal(count(text, /\/S \/GoTo\s+\/D \(src-2\)/g), 1);
    assert.equal(count(text, /\/S \/GoTo\s+\/D \(src-3\)/g), 2);
    assert.ok(text.includes("(src-1) [") && text.includes("(src-2) [") && text.includes("(src-3) ["), "the names tree holds every source");
    assert.ok(text.includes("\n(Ancilla)\n"), "the Info dictionary names the author");
  });

  it("paginates a long report and stamps every page", async () => {
    const long = `# Long\n\n${Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}. ${"Words that take up room. ".repeat(12)}`).join("\n\n")}\n`;
    const buffer = await renderPdf(parseReport(long), { question: "Long", endedAt: null });
    const text = buffer.toString("latin1");
    const pages = count(text, /\/Type \/Page\b/g);
    assert.ok(pages >= 3, `expected several pages, got ${pages}`);
  });

  it("keeps WinAnsi characters and swaps the rest for ASCII or a question mark", () => {
    assert.equal(toWinAnsi("“Smart” quotes — dashes… café • €"), "“Smart” quotes — dashes… café • €");
    assert.equal(toWinAnsi("a → b ≥ c"), "a -> b >= c");
    assert.equal(toWinAnsi("Ő ș ǎ"), "O s a");
    assert.equal(toWinAnsi("tree 🌳 αβγ"), "tree ? ???");
    assert.equal(toWinAnsi("zero​width️"), "zerowidth");
  });

  it("does not throw on text outside WinAnsi", async () => {
    const buffer = await renderPdf(parseReport("# Ünïcödé\n\nGreek αβγ, emoji 🌳, CJK 日本語, arrows → and quotes “ok”.\n"), { question: "Ünïcödé → test 日本", endedAt: null });
    assert.equal(buffer.toString("latin1").slice(0, 5), "%PDF-");
  });
});

// ---------------------------------------------------------------- slug

describe("research export: file names", () => {
  it("slugs the question for the download name", () => {
    assert.equal(questionSlug(QUESTION), "why-does-the-amazon-rainforest-matter");
    assert.equal(questionSlug("  What's   new in SQLite 3.46?! "), "what-s-new-in-sqlite-3-46");
    assert.equal(questionSlug("???"), "report");
    assert.equal(questionSlug("x".repeat(100)).length, 60);
    assert.equal(questionSlug("abcdefghij ".repeat(6)), "abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcde");
    for (const cut of ["abcdefgh ".repeat(12), "abcdefghijklmnopq ".repeat(5)]) {
      const slug = questionSlug(cut);
      assert.ok(slug.length <= 60 && !slug.endsWith("-"), slug);
    }
  });
});

// ---------------------------------------------------------------- routes

function stateFor(input: ResearchInput, config: ResearchRunState["config"]): ResearchRunState {
  return {
    version: 1,
    runId: input.runId,
    eventSeq: 0,
    question: input.question,
    config,
    phase: "done",
    brief: "A brief",
    inputLanguage: "en",
    targetLanguage: "en",
    draft: null,
    rounds: [],
    registry: [],
    curated: [],
    notes: [],
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 },
    startedAt: "2026-09-26T10:00:00.000Z",
    researchDeadlineAt: "2026-09-26T10:10:00.000Z",
    nextAgentId: 1,
  };
}

function eventOf(input: ResearchInput, seq: number, type: ResearchEvent["type"]): ResearchEvent {
  return { type, runId: input.runId, seq, at: new Date().toISOString(), phase: "scoping", round: null, agentId: null, payload: {} };
}

/** An engine that completes at once with the fixture report. */
const reportingEngine: ResearchEngine = async (input, config, deps) => {
  deps.events.emit(eventOf(input, 1, "run_started"));
  const state = stateFor(input, config);
  await deps.checkpoint(state);
  deps.events.emit(eventOf(input, 2, "run_completed"));
  return { status: "completed", report: REPORT, state, failure: null };
};

/** An engine that stays running until stopped, and then has no report. */
const waitingEngine: ResearchEngine = async (input, config, deps, signal) => {
  deps.events.emit(eventOf(input, 1, "run_started"));
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return { status: "cancelled", report: null, state: { ...stateFor(input, config), aborted: true, abortReason: "stopped" }, failure: "cancelled: stopped" };
};

async function startThread(connection: FakeConnection, base: string, cwd: string): Promise<void> {
  connection.replies.set("session/start", () => ({ session: { sessionId: "s1" } }));
  const started = await send(base, "/api/sessions", { cwd });
  assert.equal(started.status, 200);
}

describe("research export routes", () => {
  it("exports a finished report to each format beside report.md and serves it as a download", async () => {
    const connection = new FakeConnection();
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-export-"));
    const { base } = await start(connection, { researchEngine: reportingEngine });
    await startThread(connection, base, cwd);
    const started = await send(base, "/api/research", { commandId: "cmd-x", sessionId: "s1", question: QUESTION });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runId: string = started.json.run.runId;
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "completed", "run completion");

    // Nothing to download before an export was asked for.
    assert.equal((await fetch(`${base}/api/research/${runId}/export/report.pdf`)).status, 404);
    assert.equal((await fetch(`${base}/api/research/${runId}/export/report.txt`)).status, 404);

    const expected = {
      pdf: { type: "application/pdf", head: "%PDF-" },
      docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", head: "PK" },
      html: { type: "text/html; charset=utf-8", head: "<!doctype html>" },
    } as const;
    for (const format of ["pdf", "docx", "html"] as const) {
      const exported = await send(base, `/api/research/${runId}/export`, { format });
      assert.equal(exported.status, 200, JSON.stringify(exported.json));
      assert.deepEqual(Object.keys(exported.json).sort(), ["name", "path", "size", "url"]);
      assert.equal(exported.json.path, `.ancilla/research/${runId}/report.${format}`);
      assert.equal(exported.json.name, `report.${format}`);
      assert.equal(exported.json.url, `/api/research/${runId}/export/report.${format}`);
      const onDisk = join(cwd, ".ancilla", "research", runId, `report.${format}`);
      const info = await stat(onDisk);
      assert.equal(exported.json.size, info.size);
      assert.ok(info.size > 500, `${format} has content`);
      const file = await readFile(onDisk);
      assert.equal(file.subarray(0, expected[format].head.length).toString("latin1"), expected[format].head);

      const res = await fetch(`${base}${exported.json.url}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), expected[format].type);
      assert.equal(res.headers.get("content-disposition"), `attachment; filename="why-does-the-amazon-rainforest-matter.${format}"`);
      assert.equal(res.headers.get("content-length"), String(info.size));
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.equals(file), `${format} download matches the file`);
    }
    const html = await readFile(join(cwd, ".ancilla", "research", runId, "report.html"), "utf8");
    assert.match(html, /<li id="src-1"><a href="https:\/\/www\.worldwildlife\.org\/places\/amazon"/);

    // Exporting again overwrites in place.
    const again = await send(base, `/api/research/${runId}/export`, { format: "html" });
    assert.equal(again.status, 200);
    assert.equal(again.json.size, (await stat(join(cwd, ".ancilla", "research", runId, "report.html"))).size);
  });

  it("answers 409 without a report, 400 for an unknown format and 404 for an unknown run", async () => {
    const connection = new FakeConnection();
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-export-"));
    const { base } = await start(connection, { researchEngine: waitingEngine });
    await startThread(connection, base, cwd);
    const started = await send(base, "/api/research", { commandId: "cmd-y", sessionId: "s1", question: "Pending" });
    assert.equal(started.status, 200);
    const runId: string = started.json.run.runId;

    const noReport = await send(base, `/api/research/${runId}/export`, { format: "pdf" });
    assert.equal(noReport.status, 409);
    assert.equal(noReport.json.error, "The run has no report to export.");

    const badFormat = await send(base, `/api/research/${runId}/export`, { format: "odt" });
    assert.equal(badFormat.status, 400);
    const noFormat = await send(base, `/api/research/${runId}/export`, {});
    assert.equal(noFormat.status, 400);

    const unknown = await send(base, "/api/research/nope/export", { format: "pdf" });
    assert.equal(unknown.status, 404);
    assert.equal((await fetch(`${base}/api/research/nope/export/report.pdf`)).status, 404);
    assert.equal((await fetch(`${base}/api/research/${runId}/export/report.pdf`)).status, 404);

    const stopped = await send(base, `/api/research/${runId}/export/report.pdf`, { format: "pdf" });
    assert.notEqual(stopped.status, 200, "POST on the download URL is not an export");
    await send(base, `/api/research/${runId}/stop`, { writeReport: false });
  });
});
