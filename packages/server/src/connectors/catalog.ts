import type { ConnectorManifest, Target, ToolEntry, WriteClass } from "./manifest.js";

/**
 * The connectors Ancilla ships: curated, not open-ended. A server's tool descriptions are text the model reads as instructions,
 * so a server nobody checked is not offered, and no one can add one here. Official MCP servers (GitHub, Supabase, Brevo) and
 * official REST APIs (Gmail, Google Drive, Hostinger) share the same curated allowlist, schema sanitizer, secret redactor,
 * taint tracker, and argument-bound approval gate.
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

export function supabaseProjectTarget(args: Record<string, unknown>): Target | null {
  const projectId = word(args["project_id"] ?? args["id"]);
  if (projectId === "") return null;
  return {
    label: `project ${projectId}`,
    item: `supabase:${projectId.toLowerCase()}`,
    parts: [{ shown: projectId, accepts: [projectId] }],
  };
}

export function brevoContactTarget(args: Record<string, unknown>): Target | null {
  const email = word(args["email"] ?? args["identifier"]);
  if (email === "") return null;
  return {
    label: email,
    item: `brevo:${email.toLowerCase()}`,
    parts: [{ shown: email, accepts: [email] }],
  };
}

export function brevoEmailTarget(args: Record<string, unknown>): Target | null {
  const toRaw = args["to"];
  let address = word(toRaw);
  if (address === "" && Array.isArray(toRaw) && toRaw.length > 0) {
    const first = toRaw[0];
    if (typeof first === "object" && first !== null) address = word((first as Record<string, unknown>)["email"]);
    else address = word(first);
  }
  const subject = word(args["subject"]);
  if (address === "" && subject === "") return null;
  return {
    label: address && subject ? `${address} (${subject})` : address || subject,
    item: address ? `brevo-to:${address.toLowerCase()}` : null,
    parts: address ? [{ shown: address, accepts: [address] }] : [],
  };
}

export function gmailMessageTarget(args: Record<string, unknown>): Target | null {
  const id = word(args["message_id"] ?? args["thread_id"]);
  if (id === "") return null;
  return {
    label: `message ${id}`,
    item: `gmail:${id}`,
    parts: [{ shown: id, accepts: [id] }],
  };
}

export function gmailRecipientTarget(args: Record<string, unknown>): Target | null {
  const to = word(args["to"]);
  const subject = word(args["subject"]);
  const threadId = word(args["thread_id"]);
  if (to === "" && subject === "") return null;
  return {
    label: to && subject ? `${to} — ${subject}` : to || subject,
    item: threadId ? `gmail:${threadId}` : to ? `gmail-to:${to.toLowerCase()}` : null,
    parts: to ? [{ shown: to, accepts: [to] }] : [],
  };
}

export function driveFileTarget(args: Record<string, unknown>): Target | null {
  const fileId = word(args["file_id"]);
  const name = word(args["name"]);
  if (fileId === "" && name === "") return null;
  const shown = name || fileId;
  const accepts = [name, fileId].filter((v) => v !== "");
  return {
    label: name && fileId ? `${name} (${fileId})` : shown,
    item: fileId ? `drive:${fileId}` : name ? `drive-name:${name.toLowerCase()}` : null,
    parts: [{ shown, accepts }],
  };
}

export function hostingerDomainTarget(args: Record<string, unknown>): Target | null {
  const domain = word(args["domain"]);
  if (domain === "") return null;
  return {
    label: domain,
    item: `domain:${domain.toLowerCase()}`,
    parts: [{ shown: domain, accepts: [domain] }],
  };
}

export function hostingerVpsTarget(args: Record<string, unknown>): Target | null {
  const id = word(args["virtual_machine_id"]);
  if (id === "") return null;
  return {
    label: `VPS #${id}`,
    item: `vps:${id}`,
    parts: [{ shown: `VPS #${id}`, accepts: [id, `#${id}`] }],
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
  oauth: {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["read:user", "repo"],
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
    helpUrl: "https://github.com/settings/developers",
    recipe: "Create a GitHub OAuth App with http://127.0.0.1/oauth/callback as the Authorization callback URL, then enter its Client ID and Client Secret (or set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET).",
  },
  revoke: { url: "https://github.com/settings/personal-access-tokens", text: "Open Settings, Developer settings, Personal access tokens, and delete the token (or revoke Authorized OAuth Apps)." },
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
  transport: { kind: "http", url: "https://mcp.supabase.com/mcp" },
  token: {
    label: "Personal access token",
    helpUrl: "https://supabase.com/dashboard/account/tokens",
    recipe: "Create an access token with a name you will recognise and an expiry.",
  },
  revoke: { url: "https://supabase.com/dashboard/account/tokens", text: "Open Account, Access Tokens, and revoke the token." },
  caution: "A Supabase access token cannot be limited to one project or to reading, so it can do everything your account can. Ancilla starts read only and holds every migration or branch creation for your approval.",
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
    create_branch: write("reversible", "Create a preview branch of a Supabase project.", { target: supabaseProjectTarget }),
    apply_migration: write("destructive", "Apply a database migration to a Supabase project.", { target: supabaseProjectTarget }),
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
  caution: "A Brevo MCP key cannot be limited to reading: it can do everything your account can, sending campaigns included. Ancilla starts read only and asks before creating contacts or sending transactional email, so make the key just for Ancilla and delete it if you stop using it.",
  tools: {
    accounts_get_account: read("The account: its plan, its credits and the company.", { own: true }),
    email_campaign_management_get_email_campaigns: read("List the email campaigns with their status, newest first."),
    email_campaign_management_get_email_campaign: read("Read one email campaign and its statistics."),
    campaign_analytics_get_email_event_report: read("The events of email campaigns: sent, delivered, opened, clicked."),
    contacts_get_contacts: read("List the contacts."),
    contacts_get_contact_info: read("Read one contact.", { target: brevoContactTarget }),
    contacts_get_contact_stats: read("The statistics of one contact."),
    lists_get_lists: read("List the contact lists."),
    segments_get_segments: read("List the segments."),
    senders_get_senders: read("List the senders."),
    templates_get_smtp_templates: read("List the email templates."),
    sms_campaigns_get_sms_campaigns: read("List the SMS campaigns."),
    contacts_create_contact: write("reversible", "Create or update a contact in Brevo.", { target: brevoContactTarget }),
    transactional_emails_send_transac_email: write("communicates", "Send one transactional email through Brevo.", { target: brevoEmailTarget }),
  },
  probe: { tool: "accounts_get_account", args: {} },
};

export const GMAIL: ConnectorManifest = {
  id: "gmail",
  name: "Gmail",
  summary: "Your emails, threads, labels and drafts.",
  transport: { kind: "rest", driver: "gmail", baseUrl: "https://gmail.googleapis.com/gmail/v1" },
  token: {
    label: "Google OAuth access token",
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    recipe: "Sign in with OAuth below (recommended, so Ancilla refreshes access automatically), or paste a short-lived Google OAuth token with gmail.readonly scope (plus gmail.compose / gmail.send if you enable drafts or sending).",
  },
  oauth: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    authParams: { access_type: "offline", prompt: "consent" },
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    recipe: "In Google Cloud Console, enable the Gmail API and create an OAuth 2.0 Client ID of type Desktop app. Paste its Client ID (and Client Secret if given), then sign in.",
  },
  revoke: {
    url: "https://myaccount.google.com/permissions",
    text: "Open your Google Account third-party access page to review or remove access if it was not already revoked.",
  },
  tools: {
    get_profile: read("Who the mailbox belongs to: the email address and message counts.", { own: true }),
    list_messages: read("Search or list emails in the mailbox. Uses Gmail search syntax such as is:unread or from:name."),
    get_message: read("Read one email message: its headers and plain text body.", { target: gmailMessageTarget }),
    get_thread: read("Read all messages in an email thread.", { target: gmailMessageTarget }),
    list_labels: read("List the mailbox labels.", { own: true }),
    create_draft: write("reversible", "Create a draft email without sending it.", { target: gmailRecipientTarget }),
    send_message: write("communicates", "Send an email from the user's mailbox.", { target: gmailRecipientTarget }),
    send_reply: write("communicates", "Send a reply in an existing email thread.", { target: gmailRecipientTarget }),
  },
  probe: { tool: "get_profile", args: {} },
};

export const GOOGLE_DRIVE: ConnectorManifest = {
  id: "google_drive",
  name: "Google Drive",
  summary: "Your Drive folders, documents, spreadsheets and text files.",
  transport: { kind: "rest", driver: "google_drive", baseUrl: "https://www.googleapis.com/drive/v3" },
  token: {
    label: "Google OAuth access token",
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    recipe: "Sign in with OAuth below (recommended, so Ancilla refreshes access automatically), or paste a Google OAuth token with drive.readonly scope (plus drive.file if you enable creating or updating files).",
  },
  oauth: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    authParams: { access_type: "offline", prompt: "consent" },
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    recipe: "In Google Cloud Console, enable the Google Drive API and create an OAuth 2.0 Client ID of type Desktop app. Paste its Client ID (and Client Secret if given), then sign in.",
  },
  revoke: {
    url: "https://myaccount.google.com/permissions",
    text: "Open your Google Account third-party access page to review or remove access if it was not already revoked.",
  },
  tools: {
    about_drive: read("Who the Google Drive belongs to and its storage quota.", { own: true }),
    search_files: read("Find files or folders in Google Drive by name or Drive query."),
    get_file_metadata: read("Read the metadata and link of one file or folder.", { target: driveFileTarget }),
    read_file_text: read("Read the plain text of a Google Doc, Sheet, Slide or text file.", { target: driveFileTarget }),
    create_folder: write("reversible", "Create a folder in Google Drive.", { target: driveFileTarget }),
    create_file: write("reversible", "Create a new text, markdown or CSV file in Google Drive.", { target: driveFileTarget }),
    update_file: write("communicates", "Update the text content or name of an existing Drive file.", { target: driveFileTarget }),
  },
  probe: { tool: "about_drive", args: {} },
};

export const HOSTINGER: ConnectorManifest = {
  id: "hostinger",
  name: "Hostinger",
  summary: "Your domains, DNS zones, virtual machines and subscriptions.",
  transport: { kind: "rest", driver: "hostinger", baseUrl: "https://developers.hostinger.com" },
  token: {
    label: "Hostinger API token",
    helpUrl: "https://hpanel.hostinger.com/profile/api",
    recipe: "In hPanel, open Account Information > API, generate a new API token with an expiration date, and paste it here.",
  },
  revoke: {
    url: "https://hpanel.hostinger.com/profile/api",
    text: "Open hPanel > Account Information > API and delete the token.",
  },
  caution: "A Hostinger API token has full access to your hPanel domains, DNS and virtual machines. Ancilla starts read only and asks for your approval before creating snapshots, updating DNS records, or restarting a VPS.",
  tools: {
    list_domains: read("List the domains in the user's Hostinger portfolio.", { own: true }),
    get_dns_records: read("Read the DNS zone records of a domain.", { own: true, target: hostingerDomainTarget }),
    list_vps: read("List the virtual machines in the user's Hostinger account.", { own: true }),
    get_vps: read("Read the status, IP addresses and plan of one virtual machine.", { own: true, target: hostingerVpsTarget }),
    list_subscriptions: read("List the active billing subscriptions on the account.", { own: true }),
    create_vps_snapshot: write("reversible", "Create a snapshot of a virtual machine.", { target: hostingerVpsTarget }),
    update_dns_records: write("communicates", "Add or update DNS records in a domain's zone.", {
      target: hostingerDomainTarget,
      escalate: (args) => (args["overwrite"] === true ? "destructive" : null),
    }),
    reset_vps: write("destructive", "Restart a virtual machine.", { target: hostingerVpsTarget }),
  },
  probe: { tool: "list_domains", args: {} },
};

export const CATALOG: readonly ConnectorManifest[] = [GITHUB, GMAIL, GOOGLE_DRIVE, SUPABASE, BREVO, HOSTINGER];
