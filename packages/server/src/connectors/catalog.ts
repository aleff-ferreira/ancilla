import type { ConnectorManifest, Target, ToolEntry, WriteClass } from "./manifest.js";

/**
 * The connectors Ancilla ships: curated, not open-ended. A server's tool descriptions are text the model reads as instructions,
 * so a server nobody checked is not offered, and no one can add one here. Each tool below was named from the provider's own
 * documentation (GitHub, Supabase) or from the tool list of its hosted server (Brevo); none was called against a live account in
 * this slice, so Test says what a server really lists, and a name that has changed is simply not offered.
 */

const read = (text: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({ class: "read", text, ...extra });
const write = (cls: WriteClass, text: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({ class: cls, text, ...extra });

function word(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, 100) : "";
}

/** The repository, and the issue or pull request number when there is one, of a GitHub call. */
export function githubTarget(args: Record<string, unknown>): Target | null {
  const owner = word(args["owner"]);
  const repo = word(args["repo"]);
  if (owner === "" || repo === "") return null;
  const slug = `${owner}/${repo}`;
  const number = [args["issue_number"], args["pullNumber"], args["pull_number"], args["number"]].map(word).find((n) => /^\d{1,9}$/.test(n)) ?? "";
  return {
    label: number === "" ? slug : `${slug} #${number}`,
    item: number === "" ? null : `${slug.toLowerCase()}#${number}`,
    parts: [{ shown: slug, accepts: [slug, repo] }, ...(number === "" ? [] : [{ shown: `#${number}`, accepts: [number] }])],
  };
}

export const GITHUB: ConnectorManifest = {
  id: "github",
  name: "GitHub",
  summary: "Your repositories, issues and pull requests.",
  transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
  token: {
    label: "Fine-grained personal access token",
    helpUrl: "https://github.com/settings/personal-access-tokens/new",
    recipe: "Choose the repositories it may see, then under Repository permissions set Contents, Issues, Pull requests and Metadata to Read-only and leave every other permission off. Give it an expiry. To let the assistant also ask to change things, set Issues and Pull requests (and Contents, for branches) to Read and write instead, and switch the kind of change on below after you connect.",
  },
  revoke: { url: "https://github.com/settings/personal-access-tokens", text: "Open Settings, Developer settings, Personal access tokens, and delete the token." },
  tools: {
    get_me: read("Who the token belongs to: the login, the name and the profile.", { own: true }),
    search_repositories: read("Find repositories. The query uses GitHub search syntax, for example user:NAME."),
    search_issues: read("Find issues. The query uses GitHub search syntax, for example is:open involves:LOGIN, or repo:OWNER/NAME is:open."),
    search_pull_requests: read("Find pull requests. The query uses GitHub search syntax, for example is:open author:LOGIN, or review-requested:LOGIN."),
    list_issues: read("List the issues of one repository."),
    issue_read: read("Read one issue: its text, its comments or its labels.", { target: githubTarget }),
    list_pull_requests: read("List the pull requests of one repository."),
    pull_request_read: read("Read one pull request: its details, files, comments or checks.", { target: githubTarget }),
    get_file_contents: read("Read a file, or list a folder, of a repository."),
    list_commits: read("List the recent commits of a repository."),
    get_commit: read("Read one commit."),
    list_notifications: read("List the user's unread notifications."),
    // What changes something. Each is offered only where the person switched its class on, and every call waits for their approval.
    create_branch: write("reversible", "Create a branch in a repository.", { target: githubTarget }),
    add_issue_comment: write("communicates", "Comment on an issue or a pull request.", { target: githubTarget }),
    issue_write: write("communicates", "Open an issue (method create), or change one (method update, which can also close it).", {
      target: githubTarget,
      escalate: (args) => (word(args["state"]).toLowerCase() === "closed" ? "destructive" : null),
    }),
    create_pull_request: write("communicates", "Open a pull request from one branch into another.", { target: githubTarget }),
    merge_pull_request: write("destructive", "Merge a pull request.", { target: githubTarget }),
  },
  probe: { tool: "get_me", args: {} },
};

export const SUPABASE: ConnectorManifest = {
  id: "supabase",
  name: "Supabase",
  summary: "Your projects, their tables, logs and functions.",
  transport: { kind: "http", url: "https://mcp.supabase.com/mcp?read_only=true" },
  token: {
    label: "Personal access token",
    helpUrl: "https://supabase.com/dashboard/account/tokens",
    recipe: "Create an access token with a name you will recognise and an expiry.",
  },
  revoke: { url: "https://supabase.com/dashboard/account/tokens", text: "Open Account, Access Tokens, and revoke the token." },
  caution: "A Supabase access token cannot be limited to one project or to reading, so it can do everything your account can. Ancilla asks the server for read-only mode and offers only its read tools.",
  tools: {
    list_projects: read("List the user's projects.", { own: true }),
    get_project: read("Read the details of one project.", { own: true }),
    list_tables: read("List the tables of a project's database."),
    list_migrations: read("List the database migrations of a project."),
    list_extensions: read("List the database extensions of a project."),
    get_advisors: read("Read the security and performance advisories of a project."),
    query_logs: read("Read the recent logs of a project."),
    list_edge_functions: read("List the edge functions of a project."),
    get_edge_function: read("Read one edge function of a project."),
    search_docs: read("Search the Supabase documentation."),
  },
  probe: { tool: "list_projects", args: {} },
};

export const BREVO: ConnectorManifest = {
  id: "brevo",
  name: "Brevo",
  summary: "Your email campaigns, contacts and lists.",
  transport: { kind: "http", url: "https://mcp.brevo.com/v1/brevo/mcp" },
  token: {
    label: "MCP API key",
    helpUrl: "https://app.brevo.com/settings/keys/api",
    recipe: "Under SMTP & API, API Keys, generate a new API key and switch on the option that makes it an MCP server key. An ordinary API key does not work here.",
  },
  revoke: { url: "https://app.brevo.com/settings/keys/api", text: "Open SMTP & API, API Keys, and delete the key." },
  caution: "A Brevo MCP key cannot be limited to reading: it can do everything your account can, sending campaigns included. Ancilla offers its read tools only, and that list is the only wall, so make the key just for Ancilla and delete it if you stop using it.",
  tools: {
    accounts_get_account: read("The account: its plan, its credits and the company.", { own: true }),
    email_campaign_management_get_email_campaigns: read("List the email campaigns with their status, newest first."),
    email_campaign_management_get_email_campaign: read("Read one email campaign and its statistics."),
    campaign_analytics_get_email_event_report: read("The events of email campaigns: sent, delivered, opened, clicked."),
    contacts_get_contacts: read("List the contacts."),
    contacts_get_contact_info: read("Read one contact."),
    contacts_get_contact_stats: read("The statistics of one contact."),
    lists_get_lists: read("List the contact lists."),
    segments_get_segments: read("List the segments."),
    senders_get_senders: read("List the senders."),
    templates_get_smtp_templates: read("List the email templates."),
    sms_campaigns_get_sms_campaigns: read("List the SMS campaigns."),
  },
  probe: { tool: "accounts_get_account", args: {} },
};

export const CATALOG: readonly ConnectorManifest[] = [GITHUB, SUPABASE, BREVO];
