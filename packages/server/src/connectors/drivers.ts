import { CALL_MS, ConnectorError, explainError, type LiveConnection } from "./connection.js";
import type { RestDriverId, ServerTool } from "./manifest.js";

/**
 * Official REST API drivers wrapped as `LiveConnection`s so that Gmail, Google Drive, and Hostinger pass through the
 * exact same curated tool allowlist, schema sanitizer, secret redactor, taint tracker (`ReadLog`), SHA-256 argument-bound
 * `WriteGate` approval cards, and `activity.jsonl` audit log as MCP connectors.
 */

interface DriverTool {
  name: string;
  inputSchema: Record<string, unknown>;
  run(ctx: RestContext, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
}

interface RestContext {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}

function str(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function combinedSignal(signal: AbortSignal, timeoutMs = CALL_MS): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function requestJson(
  ctx: RestContext,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  let res: Response;
  try {
    res = await ctx.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: combinedSignal(signal),
    });
  } catch (error) {
    throw new ConnectorError(explainError(error, ctx.token));
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError(explainError(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), ctx.token));
  }
  let data: unknown = null;
  if (text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function requestText(
  ctx: RestContext,
  url: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; contentType: string; text: string }> {
  let res: Response;
  try {
    res = await ctx.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${ctx.token}` },
      signal: combinedSignal(signal),
    });
  } catch (error) {
    throw new ConnectorError(explainError(error, ctx.token));
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError(explainError(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), ctx.token));
  }
  return { ok: res.ok, status: res.status, contentType: res.headers.get("content-type") ?? "", text };
}

function apiFailure(status: number, data: unknown, fallbackText: string): { text: string; isError: true } {
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const err = obj["error"];
    if (typeof err === "object" && err !== null && typeof (err as Record<string, unknown>)["message"] === "string") {
      return { text: `HTTP ${status}: ${String((err as Record<string, unknown>)["message"])}`, isError: true };
    }
    if (typeof obj["message"] === "string") {
      return { text: `HTTP ${status}: ${obj["message"]}`, isError: true };
    }
  }
  return { text: `HTTP ${status}: ${fallbackText.slice(0, 300) || "request failed"}`, isError: true };
}

// ---------------------------------------------------------------------------------------------------------------- Gmail REST driver

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name?: string; value?: string }>;
}

function decodeBase64Url(encoded: string): string {
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractGmailBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data).trim();
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        const plain = decodeBase64Url(part.body.data).trim();
        if (plain !== "") return plain;
      }
    }
    for (const part of payload.parts) {
      const nested = extractGmailBody(part);
      if (nested !== "") return nested;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtmlTags(decodeBase64Url(payload.body.data));
  }
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data).trim();
  }
  return "";
}

function headerMap(headers: Array<{ name?: string; value?: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (typeof h.name === "string" && typeof h.value === "string") {
      out[h.name.toLowerCase()] = h.value;
    }
  }
  return out;
}

function formatGmailMessage(raw: Record<string, unknown>): Record<string, unknown> {
  const payload = raw["payload"] as GmailPart | undefined;
  const headers = headerMap(payload?.headers);
  const body = extractGmailBody(payload) || (typeof raw["snippet"] === "string" ? raw["snippet"] : "");
  return {
    id: raw["id"] ?? null,
    threadId: raw["threadId"] ?? null,
    from: headers["from"] ?? "",
    to: headers["to"] ?? "",
    cc: headers["cc"] ?? "",
    subject: headers["subject"] ?? "",
    date: headers["date"] ?? "",
    messageIdHeader: headers["message-id"] ?? "",
    body,
  };
}

function buildRfc2822Base64Url(fields: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
}): string {
  const lines = [
    `To: ${cleanHeader(fields.to)}`,
    ...(fields.cc ? [`Cc: ${cleanHeader(fields.cc)}`] : []),
    `Subject: ${cleanHeader(fields.subject)}`,
    ...(fields.inReplyTo ? [`In-Reply-To: ${cleanHeader(fields.inReplyTo)}`, `References: ${cleanHeader(fields.inReplyTo)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    fields.body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

const GMAIL_TOOLS: readonly DriverTool[] = [
  {
    name: "get_profile",
    inputSchema: { type: "object", properties: {} },
    async run(ctx, _args, signal) {
      const res = await requestJson(ctx, `${ctx.baseUrl}/users/me/profile`, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "list_messages",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
    },
    async run(ctx, args, signal) {
      const url = new URL(`${ctx.baseUrl}/users/me/messages`);
      const q = str(args["query"], 300);
      if (q !== "") url.searchParams.set("q", q);
      const max = Math.min(15, Math.max(1, Number(args["max_results"]) || 10));
      url.searchParams.set("maxResults", String(max));
      const res = await requestJson(ctx, url.toString(), { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      const list = Array.isArray((res.data as Record<string, unknown> | null)?.["messages"])
        ? ((res.data as Record<string, unknown>)["messages"] as Array<{ id?: string; threadId?: string }>)
        : [];
      const summaries: Array<Record<string, unknown>> = [];
      for (const item of list.slice(0, max)) {
        const id = str(item.id, 120);
        if (!id) continue;
        const metaUrl = new URL(`${ctx.baseUrl}/users/me/messages/${encodeURIComponent(id)}`);
        metaUrl.searchParams.set("format", "metadata");
        for (const h of ["From", "To", "Subject", "Date"]) metaUrl.searchParams.append("metadataHeaders", h);
        const detail = await requestJson(ctx, metaUrl.toString(), { method: "GET" }, signal);
        if (detail.ok && typeof detail.data === "object" && detail.data !== null) {
          const obj = detail.data as Record<string, unknown>;
          const headers = headerMap((obj["payload"] as GmailPart | undefined)?.headers);
          summaries.push({
            id,
            threadId: obj["threadId"] ?? item.threadId ?? null,
            from: headers["from"] ?? "",
            to: headers["to"] ?? "",
            subject: headers["subject"] ?? "",
            date: headers["date"] ?? "",
            snippet: obj["snippet"] ?? "",
          });
        } else {
          summaries.push({ id, threadId: item.threadId ?? null });
        }
      }
      return { text: JSON.stringify({ count: summaries.length, messages: summaries }), isError: false };
    },
  },
  {
    name: "get_message",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
    },
    async run(ctx, args, signal) {
      const id = str(args["message_id"], 120);
      if (!id) return { text: "message_id is required.", isError: true };
      const res = await requestJson(ctx, `${ctx.baseUrl}/users/me/messages/${encodeURIComponent(id)}?format=full`, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(formatGmailMessage((res.data ?? {}) as Record<string, unknown>)), isError: false };
    },
  },
  {
    name: "get_thread",
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string" } },
      required: ["thread_id"],
    },
    async run(ctx, args, signal) {
      const id = str(args["thread_id"], 120);
      if (!id) return { text: "thread_id is required.", isError: true };
      const res = await requestJson(ctx, `${ctx.baseUrl}/users/me/threads/${encodeURIComponent(id)}?format=full`, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      const data = (res.data ?? {}) as Record<string, unknown>;
      const rawMessages = Array.isArray(data["messages"]) ? (data["messages"] as Array<Record<string, unknown>>) : [];
      return {
        text: JSON.stringify({ id: data["id"] ?? id, messages: rawMessages.map(formatGmailMessage) }),
        isError: false,
      };
    },
  },
  {
    name: "list_labels",
    inputSchema: { type: "object", properties: {} },
    async run(ctx, _args, signal) {
      const res = await requestJson(ctx, `${ctx.baseUrl}/users/me/labels`, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "create_draft",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        cc: { type: "string" },
        thread_id: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
    async run(ctx, args, signal) {
      const to = str(args["to"], 320);
      const subject = str(args["subject"], 300);
      const body = typeof args["body"] === "string" ? args["body"] : "";
      const cc = str(args["cc"], 320);
      const threadId = str(args["thread_id"], 120);
      if (!to || !subject) return { text: "to and subject are required.", isError: true };
      const raw = buildRfc2822Base64Url({ to, subject, body, ...(cc ? { cc } : {}) });
      const res = await requestJson(
        ctx,
        `${ctx.baseUrl}/users/me/drafts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
        },
        signal,
      );
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "send_message",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        cc: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
    async run(ctx, args, signal) {
      const to = str(args["to"], 320);
      const subject = str(args["subject"], 300);
      const body = typeof args["body"] === "string" ? args["body"] : "";
      const cc = str(args["cc"], 320);
      if (!to || !subject) return { text: "to and subject are required.", isError: true };
      const raw = buildRfc2822Base64Url({ to, subject, body, ...(cc ? { cc } : {}) });
      const res = await requestJson(
        ctx,
        `${ctx.baseUrl}/users/me/messages/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw }),
        },
        signal,
      );
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "send_reply",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        in_reply_to: { type: "string" },
      },
      required: ["thread_id", "to", "subject", "body"],
    },
    async run(ctx, args, signal) {
      const threadId = str(args["thread_id"], 120);
      const to = str(args["to"], 320);
      const rawSubject = str(args["subject"], 300);
      const body = typeof args["body"] === "string" ? args["body"] : "";
      const inReplyTo = str(args["in_reply_to"], 240);
      if (!threadId || !to || !rawSubject) return { text: "thread_id, to and subject are required.", isError: true };
      const subject = /^re:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`;
      const raw = buildRfc2822Base64Url({ to, subject, body, ...(inReplyTo ? { inReplyTo } : {}) });
      const res = await requestJson(
        ctx,
        `${ctx.baseUrl}/users/me/messages/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw, threadId }),
        },
        signal,
      );
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
];

// --------------------------------------------------------------------------------------------------------- Google Drive REST driver

function driveUploadBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/drive/v3")) {
    return `${trimmed.slice(0, -"/drive/v3".length)}/upload/drive/v3`;
  }
  return `${trimmed}/upload`;
}

function buildDriveQuery(raw: string): string {
  const q = raw.trim();
  if (q === "") return "trashed = false";
  if (/\b(?:contains|=|in\s+parents|mimeType|trashed)\b/.test(q)) return q;
  const escaped = q.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `name contains '${escaped}' and trashed = false`;
}

function buildMultipartRelated(metadata: Record<string, unknown>, content: string, mimeType: string): { contentType: string; body: string } {
  const boundary = `ancilla_drive_${Date.now().toString(36)}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${cleanHeader(mimeType) || "text/plain; charset=UTF-8"}`,
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n");
  return { contentType: `multipart/related; boundary=${boundary}`, body };
}

const GOOGLE_DRIVE_TOOLS: readonly DriverTool[] = [
  {
    name: "about_drive",
    inputSchema: { type: "object", properties: {} },
    async run(ctx, _args, signal) {
      const res = await requestJson(
        ctx,
        `${ctx.baseUrl}/about?fields=user(displayName,emailAddress),storageQuota(limit,usage,usageInDrive)`,
        { method: "GET" },
        signal,
      );
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "search_files",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        page_size: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      },
    },
    async run(ctx, args, signal) {
      const url = new URL(`${ctx.baseUrl}/files`);
      url.searchParams.set("q", buildDriveQuery(str(args["query"], 300)));
      const size = Math.min(30, Math.max(1, Number(args["page_size"]) || 15));
      url.searchParams.set("pageSize", String(size));
      url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,size,webViewLink)");
      const res = await requestJson(ctx, url.toString(), { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "get_file_metadata",
    inputSchema: {
      type: "object",
      properties: { file_id: { type: "string" } },
      required: ["file_id"],
    },
    async run(ctx, args, signal) {
      const id = str(args["file_id"], 160);
      if (!id) return { text: "file_id is required.", isError: true };
      const url = `${ctx.baseUrl}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,size,description,owners(displayName,emailAddress),webViewLink`;
      const res = await requestJson(ctx, url, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "read_file_text",
    inputSchema: {
      type: "object",
      properties: { file_id: { type: "string" } },
      required: ["file_id"],
    },
    async run(ctx, args, signal) {
      const id = str(args["file_id"], 160);
      if (!id) return { text: "file_id is required.", isError: true };
      const meta = await requestJson(ctx, `${ctx.baseUrl}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size`, { method: "GET" }, signal);
      if (!meta.ok) return apiFailure(meta.status, meta.data, meta.text);
      const info = (meta.data ?? {}) as Record<string, unknown>;
      const mime = str(info["mimeType"], 120);
      const name = str(info["name"], 200);
      let contentUrl: string | null = null;
      if (mime === "application/vnd.google-apps.document" || mime === "application/vnd.google-apps.presentation") {
        contentUrl = `${ctx.baseUrl}/files/${encodeURIComponent(id)}/export?mimeType=text%2Fplain`;
      } else if (mime === "application/vnd.google-apps.spreadsheet") {
        contentUrl = `${ctx.baseUrl}/files/${encodeURIComponent(id)}/export?mimeType=text%2Fcsv`;
      } else if (
        mime.startsWith("text/") ||
        mime === "application/json" ||
        mime === "application/xml" ||
        mime === "application/javascript" ||
        /\.(?:txt|md|csv|json|yaml|yml|xml|html|log)$/i.test(name)
      ) {
        contentUrl = `${ctx.baseUrl}/files/${encodeURIComponent(id)}?alt=media`;
      }
      if (!contentUrl) {
        return { text: `File "${name || id}" has binary type ${mime || "unknown"} and cannot be read as plain text.`, isError: true };
      }
      const downloaded = await requestText(ctx, contentUrl, signal);
      if (!downloaded.ok) return { text: `HTTP ${downloaded.status}: ${downloaded.text.slice(0, 240)}`, isError: true };
      return { text: downloaded.text, isError: false };
    },
  },
  {
    name: "create_folder",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        parent_id: { type: "string" },
      },
      required: ["name"],
    },
    async run(ctx, args, signal) {
      const name = str(args["name"], 240);
      const parentId = str(args["parent_id"], 160);
      if (!name) return { text: "name is required.", isError: true };
      const res = await requestJson(
        ctx,
        `${ctx.baseUrl}/files?fields=id,name,mimeType,webViewLink`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            mimeType: "application/vnd.google-apps.folder",
            ...(parentId ? { parents: [parentId] } : {}),
          }),
        },
        signal,
      );
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "create_file",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        content: { type: "string" },
        mime_type: { type: "string" },
        parent_id: { type: "string" },
      },
      required: ["name", "content"],
    },
    async run(ctx, args, signal) {
      const name = str(args["name"], 240);
      const content = typeof args["content"] === "string" ? args["content"] : "";
      const mimeType = str(args["mime_type"], 120) || "text/plain";
      const parentId = str(args["parent_id"], 160);
      if (!name) return { text: "name is required.", isError: true };
      const mp = buildMultipartRelated({ name, mimeType, ...(parentId ? { parents: [parentId] } : {}) }, content, mimeType);
      const res = await requestJson(
        ctx,
        `${driveUploadBase(ctx.baseUrl)}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink`,
        {
          method: "POST",
          headers: { "content-type": mp.contentType },
          body: mp.body,
        },
        signal,
      );
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "update_file",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        content: { type: "string" },
        name: { type: "string" },
        mime_type: { type: "string" },
      },
      required: ["file_id", "content"],
    },
    async run(ctx, args, signal) {
      const id = str(args["file_id"], 160);
      const content = typeof args["content"] === "string" ? args["content"] : "";
      const name = str(args["name"], 240);
      const mimeType = str(args["mime_type"], 120) || "text/plain";
      if (!id) return { text: "file_id is required.", isError: true };
      const mp = buildMultipartRelated({ ...(name ? { name } : {}) }, content, mimeType);
      const res = await requestJson(
        ctx,
        `${driveUploadBase(ctx.baseUrl)}/files/${encodeURIComponent(id)}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink`,
        {
          method: "PATCH",
          headers: { "content-type": mp.contentType },
          body: mp.body,
        },
        signal,
      );
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
];

// ------------------------------------------------------------------------------------------------------------ Hostinger REST driver

const HOSTINGER_TOOLS: readonly DriverTool[] = [
  {
    name: "list_domains",
    inputSchema: { type: "object", properties: {} },
    async run(ctx, _args, signal) {
      const res = await requestJson(ctx, `${ctx.baseUrl}/api/domains/v1/portfolio`, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "get_dns_records",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" } },
      required: ["domain"],
    },
    async run(ctx, args, signal) {
      const domain = str(args["domain"], 253);
      if (!domain) return { text: "domain is required.", isError: true };
      const res = await requestJson(ctx, `${ctx.baseUrl}/api/dns/v1/zones/${encodeURIComponent(domain)}`, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "list_vps",
    inputSchema: { type: "object", properties: {} },
    async run(ctx, _args, signal) {
      const res = await requestJson(ctx, `${ctx.baseUrl}/api/vps/v1/virtual-machines`, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "get_vps",
    inputSchema: {
      type: "object",
      properties: { virtual_machine_id: { type: "integer" } },
      required: ["virtual_machine_id"],
    },
    async run(ctx, args, signal) {
      const id = Number(args["virtual_machine_id"]);
      if (!Number.isInteger(id) || id <= 0) return { text: "virtual_machine_id must be a positive integer.", isError: true };
      const res = await requestJson(ctx, `${ctx.baseUrl}/api/vps/v1/virtual-machines/${id}`, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "list_subscriptions",
    inputSchema: { type: "object", properties: {} },
    async run(ctx, _args, signal) {
      const res = await requestJson(ctx, `${ctx.baseUrl}/api/billing/v1/subscriptions`, { method: "GET" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data), isError: false };
    },
  },
  {
    name: "create_vps_snapshot",
    inputSchema: {
      type: "object",
      properties: { virtual_machine_id: { type: "integer" } },
      required: ["virtual_machine_id"],
    },
    async run(ctx, args, signal) {
      const id = Number(args["virtual_machine_id"]);
      if (!Number.isInteger(id) || id <= 0) return { text: "virtual_machine_id must be a positive integer.", isError: true };
      const res = await requestJson(ctx, `${ctx.baseUrl}/api/vps/v1/virtual-machines/${id}/snapshot`, { method: "POST" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data ?? { ok: true }), isError: false };
    },
  },
  {
    name: "update_dns_records",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        overwrite: { type: "boolean", default: false },
        zone: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"] },
              ttl: { type: "integer" },
              records: {
                type: "array",
                items: {
                  type: "object",
                  properties: { content: { type: "string" } },
                  required: ["content"],
                },
              },
            },
            required: ["name", "type", "records"],
          },
        },
      },
      required: ["domain", "zone"],
    },
    async run(ctx, args, signal) {
      const domain = str(args["domain"], 253);
      const zone = Array.isArray(args["zone"]) ? args["zone"] : null;
      if (!domain || !zone) return { text: "domain and zone array are required.", isError: true };
      const res = await requestJson(
        ctx,
        `${ctx.baseUrl}/api/dns/v1/zones/${encodeURIComponent(domain)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ overwrite: args["overwrite"] === true, zone }),
        },
        signal,
      );
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data ?? { ok: true }), isError: false };
    },
  },
  {
    name: "reset_vps",
    inputSchema: {
      type: "object",
      properties: { virtual_machine_id: { type: "integer" } },
      required: ["virtual_machine_id"],
    },
    async run(ctx, args, signal) {
      const id = Number(args["virtual_machine_id"]);
      if (!Number.isInteger(id) || id <= 0) return { text: "virtual_machine_id must be a positive integer.", isError: true };
      const res = await requestJson(ctx, `${ctx.baseUrl}/api/vps/v1/virtual-machines/${id}/restart`, { method: "POST" }, signal);
      if (!res.ok) return apiFailure(res.status, res.data, res.text);
      return { text: JSON.stringify(res.data ?? { ok: true }), isError: false };
    },
  },
];

const DRIVERS: Record<RestDriverId, readonly DriverTool[]> = {
  gmail: GMAIL_TOOLS,
  google_drive: GOOGLE_DRIVE_TOOLS,
  hostinger: HOSTINGER_TOOLS,
};

export function openRestDriver(
  driver: RestDriverId,
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): LiveConnection {
  const table = DRIVERS[driver];
  const byName = new Map(table.map((t) => [t.name, t]));
  const ctx: RestContext = { baseUrl: baseUrl.replace(/\/+$/, ""), token, fetchImpl };
  return {
    async tools(): Promise<ServerTool[]> {
      return table.map((t) => ({ name: t.name, inputSchema: t.inputSchema }));
    },
    async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
      const found = byName.get(name);
      if (!found) throw new ConnectorError(`Unknown tool ${name.slice(0, 60)}.`);
      return found.run(ctx, args, signal);
    },
    async close(): Promise<void> {
      // Stateless HTTPS REST driver; no persistent socket to close.
    },
  };
}
