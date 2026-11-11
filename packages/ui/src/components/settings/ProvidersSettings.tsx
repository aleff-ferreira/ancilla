import { useEffect, useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { providerBadgeName } from "../../model/models.js";
import type { AccountView, ApiProviderKind, ProviderAccountView, ProviderAuthStatus, ProviderId, ProviderView } from "../../types.js";
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, CheckCircleIcon, PencilSimpleIcon, PlusIcon, SignInIcon, TrashIcon, WarningIcon } from "../ui/icons.js";
import { CopyButton } from "../ui/Markdown.js";
import { Modal } from "../ui/overlays.js";
import { Button, Spinner, cn } from "../ui/primitives.js";
import { Pick, Row, Section } from "./SettingsPage.js";

const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-line bg-sunken px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus";

const API_PRESETS: readonly {
  id: string;
  label: string;
  apiKind: ApiProviderKind;
  baseUrl: string;
  defaultModelId: string;
  customModels: string;
  needsKey: boolean;
}[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    apiKind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModelId: "anthropic/claude-sonnet-4.6",
    customModels: "openai/gpt-5.4, google/gemini-2.5-pro, deepseek/deepseek-r1",
    needsKey: true,
  },
  {
    id: "venice",
    label: "Venice",
    apiKind: "openai",
    baseUrl: "https://api.venice.ai/api/v1",
    defaultModelId: "llama-3.3-70b",
    customModels: "qwen-2.5-coder-32b, deepseek-r1-671b",
    needsKey: true,
  },
  {
    id: "openai",
    label: "OpenAI API",
    apiKind: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModelId: "gpt-5.4",
    customModels: "gpt-5.3-codex, gpt-5-mini, o3",
    needsKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic API",
    apiKind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModelId: "claude-sonnet-4-6",
    customModels: "claude-opus-4-6, claude-haiku-4-5",
    needsKey: true,
  },
  {
    id: "google",
    label: "Google Gemini API",
    apiKind: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModelId: "gemini-2.5-pro",
    customModels: "gemini-2.5-flash",
    needsKey: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    apiKind: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModelId: "qwen3:8b",
    customModels: "",
    needsKey: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    apiKind: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    defaultModelId: "local-model",
    customModels: "",
    needsKey: false,
  },
  {
    id: "vllm",
    label: "vLLM / llama.cpp",
    apiKind: "openai",
    baseUrl: "http://127.0.0.1:8000/v1",
    defaultModelId: "local-model",
    customModels: "",
    needsKey: false,
  },
];

function StatusPill(props: { tone: "ok" | "warn" | "neutral"; children: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-2xs font-medium",
        props.tone === "ok"
          ? "bg-ok-soft text-ok-text"
          : props.tone === "warn"
            ? "bg-warn-soft text-warn-text"
            : "bg-active text-muted",
      )}
    >
      {props.children}
    </span>
  );
}

function isProviderAccount(a: ProviderAccountView | AccountView): a is ProviderAccountView {
  return "providerId" in a;
}

function authBadge(auth: ProviderAuthStatus | null | undefined, binaryAvailable: boolean): { tone: "ok" | "warn" | "neutral"; label: string } {
  if (!binaryAvailable) {
    return { tone: "neutral", label: "Not installed" };
  }
  if (!auth) {
    return { tone: "neutral", label: "CLI ready" };
  }
  switch (auth.state) {
    case "authenticated":
      return { tone: "ok", label: auth.planTier ? `Signed in (${auth.planTier})` : "Signed in" };
    case "ready":
      return { tone: "ok", label: "Ready" };
    case "unauthenticated":
    case "missing-key":
      return { tone: "warn", label: "Sign in required" };
    default:
      return { tone: "neutral", label: "CLI manages login" };
  }
}

function AddCliProfileModal(props: {
  provider: ProviderView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const controller = useController();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (props.provider) {
      setName("");
    }
  }, [props.provider]);

  const provider = props.provider;
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  const profileId = provider && slug ? `${provider.id}-${slug}` : "";

  async function submit() {
    if (!provider || !name.trim() || !profileId || saving) {
      return;
    }
    setSaving(true);
    const created = await controller.saveProviderAccount(null, {
      id: profileId,
      providerId: provider.id,
      name: name.trim(),
    });
    setSaving(false);
    if (created) {
      props.onOpenChange(false);
      void controller.beginProviderLogin(provider.id, created.id);
    }
  }

  return (
    <Modal
      open={provider !== null}
      onOpenChange={(open) => {
        if (!saving) {
          props.onOpenChange(open);
        }
      }}
      title={provider ? `Add ${provider.displayName} profile` : "Add profile"}
      description="Each profile gets its own isolated CLI configuration directory so work and personal subscriptions stay separate."
    >
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="cli-profile-name">
            Profile label
          </label>
          <input
            id="cli-profile-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Work, Personal, or Team"
            className={INPUT_CLASS}
          />
        </div>
        {profileId ? <p className="font-mono text-xs text-subtle">Profile id: {profileId}</p> : null}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" disabled={saving} onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!name.trim() || !profileId || saving} loading={saving} onClick={() => void submit()}>
          Create &amp; sign in
        </Button>
      </div>
    </Modal>
  );
}

function ApiEndpointModal(props: {
  open: boolean;
  editing: ProviderAccountView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const controller = useController();
  const [name, setName] = useState("");
  const [apiKind, setApiKind] = useState<ApiProviderKind>("openai");
  const [baseUrl, setBaseUrl] = useState("https://openrouter.ai/api/v1");
  const [apiKey, setApiKey] = useState("");
  const [defaultModelId, setDefaultModelId] = useState("");
  const [customModels, setCustomModels] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    if (props.editing) {
      setName(props.editing.name);
      setApiKind(props.editing.apiKind ?? "openai");
      setBaseUrl(props.editing.apiBaseUrl ?? "");
      setApiKey("");
      setDefaultModelId(props.editing.defaultModelId ?? "");
      setCustomModels((props.editing.customModels ?? []).join(", "));
    } else {
      const preset = API_PRESETS[0]!;
      setName(preset.label);
      setApiKind(preset.apiKind);
      setBaseUrl(preset.baseUrl);
      setApiKey("");
      setDefaultModelId(preset.defaultModelId);
      setCustomModels(preset.customModels);
    }
  }, [props.open, props.editing]);

  const applyPreset = (preset: (typeof API_PRESETS)[number]) => {
    setName(preset.label);
    setApiKind(preset.apiKind);
    setBaseUrl(preset.baseUrl);
    setDefaultModelId(preset.defaultModelId);
    setCustomModels(preset.customModels);
  };

  async function submit() {
    if (!name.trim() || !baseUrl.trim() || saving) {
      return;
    }
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "endpoint";
    const id = props.editing?.id ?? `api-${slug}-${Date.now().toString(36).slice(-4)}`;
    const models = customModels
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setSaving(true);
    const saved = await controller.saveProviderAccount(props.editing?.id ?? null, {
      ...(props.editing ? {} : { id, providerId: "api" }),
      name: name.trim(),
      apiKind,
      apiBaseUrl: baseUrl.trim(),
      defaultModelId: defaultModelId.trim() || null,
      customModels: models,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setSaving(false);
    if (saved) {
      props.onOpenChange(false);
    }
  }

  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => {
        if (!saving) {
          props.onOpenChange(open);
        }
      }}
      title={props.editing ? `Edit ${props.editing.name}` : "Add API or local model endpoint"}
      description="Connect OpenRouter, Venice, OpenAI/Anthropic/Google API keys, or local servers (Ollama, LM Studio, llama.cpp, vLLM). Keys are saved in a 0600 local file and never sent back to the browser."
      className="top-[5vh] max-h-[90dvh] w-[min(580px,calc(100%-32px))] overflow-y-auto"
    >
      <div className="mt-4 flex flex-col gap-3">
        {!props.editing ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Presets</span>
            <div className="flex flex-wrap gap-1.5">
              {API_PRESETS.map((preset) => (
                <Button key={preset.id} size="sm" variant="secondary" onClick={() => applyPreset(preset)}>
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="api-endpoint-name">
            Label
          </label>
          <input
            id="api-endpoint-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="OpenRouter, Venice, Local Ollama…"
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Wire protocol</span>
          <Pick<ApiProviderKind>
            value={apiKind}
            options={[
              { value: "openai", label: "OpenAI-compatible" },
              { value: "anthropic", label: "Anthropic Messages" },
              { value: "google", label: "Google Gemini" },
            ]}
            onChange={setApiKind}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="api-endpoint-url">
            Base URL
          </label>
          <input
            id="api-endpoint-url"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://openrouter.ai/api/v1"
            className={`${INPUT_CLASS} font-mono text-xs`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="api-endpoint-key">
            API key {props.editing?.hasApiKey ? "(leave blank to keep saved key)" : "(optional for local servers)"}
          </label>
          <input
            id="api-endpoint-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={props.editing?.hasApiKey ? "Saved locally" : "sk-…"}
            className={`${INPUT_CLASS} font-mono text-xs`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="api-endpoint-model">
            Default model id
          </label>
          <input
            id="api-endpoint-model"
            type="text"
            value={defaultModelId}
            onChange={(e) => setDefaultModelId(e.target.value)}
            placeholder="anthropic/claude-sonnet-4.6"
            className={`${INPUT_CLASS} font-mono text-xs`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="api-endpoint-models">
            Additional model ids (comma-separated)
          </label>
          <input
            id="api-endpoint-models"
            type="text"
            value={customModels}
            onChange={(e) => setCustomModels(e.target.value)}
            placeholder="openai/gpt-5.4, google/gemini-2.5-pro"
            className={`${INPUT_CLASS} font-mono text-xs`}
          />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" disabled={saving} onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!name.trim() || !baseUrl.trim() || saving} loading={saving} onClick={() => void submit()}>
          {props.editing ? "Save changes" : "Add endpoint"}
        </Button>
      </div>
    </Modal>
  );
}

function CustomAcpModal(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const controller = useController();
  const [name, setName] = useState("");
  const [binaryPath, setBinaryPath] = useState("");
  const [argsText, setArgsText] = useState("--acp");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (props.open) {
      setName("");
      setBinaryPath("");
      setArgsText("--acp");
    }
  }, [props.open]);

  async function submit() {
    if (!name.trim() || !binaryPath.trim() || saving) {
      return;
    }
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "custom";
    const providerId: ProviderId = `acp:${slug}`;
    const customArgs = argsText
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    setSaving(true);
    const saved = await controller.saveProviderAccount(null, {
      id: `acp-${slug}`,
      providerId,
      name: name.trim(),
      binaryPath: binaryPath.trim(),
      customArgs,
    });
    setSaving(false);
    if (saved) {
      props.onOpenChange(false);
    }
  }

  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => {
        if (!saving) {
          props.onOpenChange(open);
        }
      }}
      title="Add custom ACP agent"
      description="Register any CLI that speaks the open Agent Client Protocol (JSON-RPC 2.0 over stdio)."
    >
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="acp-agent-name">
            Agent name
          </label>
          <input
            id="acp-agent-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Goose, Cline ACP, Custom Agent…"
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="acp-agent-bin">
            Executable name or path
          </label>
          <input
            id="acp-agent-bin"
            type="text"
            value={binaryPath}
            onChange={(e) => setBinaryPath(e.target.value)}
            placeholder="goose"
            className={`${INPUT_CLASS} font-mono text-xs`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="acp-agent-args">
            Arguments (space-separated)
          </label>
          <input
            id="acp-agent-args"
            type="text"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            placeholder="acp"
            className={`${INPUT_CLASS} font-mono text-xs`}
          />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" disabled={saving} onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!name.trim() || !binaryPath.trim() || saving} loading={saving} onClick={() => void submit()}>
          Add ACP agent
        </Button>
      </div>
    </Modal>
  );
}

/** Mounted globally in AncillaApp so CLI provider sign-in works from any screen. */
export function ProviderLoginModal() {
  const controller = useController();
  const login = useApp((s) => s.providerLogin);
  const providers = useApp((s) => s.providers);
  const provider = providers?.find((p) => p.id === login?.providerId);
  const providerName = provider?.displayName ?? (login ? providerBadgeName(login.providerId) : "Provider");
  const accountLabel = login?.accountId
    ? (provider?.accounts.find((a) => a.id === login.accountId)?.name ?? login.accountId)
    : "Default CLI login";

  return (
    <Modal
      open={login !== null}
      onOpenChange={(open) => {
        if (!open) {
          controller.cancelProviderLogin();
        }
      }}
      title={login?.status === "done" ? `${providerName} sign-in confirmed` : `Connect ${providerName}`}
      description={`Profile: ${accountLabel}`}
      className="top-[6vh] max-h-[88dvh] w-[min(560px,calc(100%-32px))] overflow-y-auto"
    >
      {login ? (
        <div className="mt-4 flex flex-col gap-4">
          {login.status === "done" ? (
            <>
              <p role="status" className="flex items-start gap-2 text-sm text-fg">
                <CheckCircleIcon size={18} className="mt-0.5 shrink-0 text-ok-text" />
                <span>{providerName} confirmed your subscription login.</span>
              </p>
              <p className="text-xs leading-relaxed text-muted">
                Select {providerName} from the Provider &amp; Account menu beside the model picker when starting a new thread.
              </p>
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => controller.cancelProviderLogin()}>
                  Continue
                </Button>
              </div>
            </>
          ) : login.status === "starting" ? (
            <>
              <p role="status" className="flex items-center gap-2 text-sm text-muted">
                <Spinner size={14} /> Starting {providerName} sign-in…
              </p>
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => controller.cancelProviderLogin()}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              {login.message ? (
                <p className={cn("text-sm leading-relaxed", login.status === "error" ? "text-warn-text" : "text-muted")}>
                  {login.message}
                </p>
              ) : null}
              {login.code ? (
                <div className="flex w-fit max-w-full items-center gap-3 rounded-lg border border-line bg-sunken py-2 pr-2 pl-3">
                  <code className="break-all font-mono text-lg tracking-wide text-fg">{login.code}</code>
                  <CopyButton text={login.code} label="Copy sign-in code" />
                </div>
              ) : null}
              {login.terminalCommand ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted">Terminal sign-in command</span>
                  <div className="flex items-center gap-2 rounded-lg border border-line bg-sunken py-1.5 pr-1.5 pl-3 font-mono text-xs text-fg">
                    <span className="min-w-0 flex-1 break-all">{login.terminalCommand}</span>
                    <CopyButton text={login.terminalCommand} label="Copy command" />
                  </div>
                </div>
              ) : null}
              {login.status === "waiting" ? (
                <p role="status" className="flex items-center gap-2 text-xs text-subtle">
                  <Spinner size={12} /> Waiting for {providerName} browser sign-in to complete…
                </p>
              ) : null}
              <p className="text-xs leading-relaxed text-subtle">
                {providerName} manages its own credentials locally. Ancilla never reads or copies your OAuth tokens.
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => controller.cancelProviderLogin()}>
                  Close
                </Button>
                <Button variant="secondary" onClick={() => void controller.checkProviderLogin()}>
                  <ArrowsClockwiseIcon size={14} /> Check sign-in
                </Button>
                {login.url ? (
                  <a
                    href={login.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-lg bg-inverse px-3 text-sm font-medium text-inverse-fg outline-offset-4 hover:opacity-90"
                  >
                    <ArrowSquareOutIcon size={14} /> Open sign-in page
                  </a>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

export function ProvidersSettings() {
  const controller = useController();
  const providers = useApp((s) => s.providers);
  const ambientKeyOverrides = useApp((s) => s.ambientKeyOverrides);
  const [addingCliFor, setAddingCliFor] = useState<ProviderView | null>(null);
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [editingApi, setEditingApi] = useState<ProviderAccountView | null>(null);
  const [acpModalOpen, setAcpModalOpen] = useState(false);

  useEffect(() => {
    void controller.loadProviders?.();
  }, [controller]);

  if (providers === null) {
    return null;
  }

  const cliProviders = providers.filter(
    (p) => p.id !== "muse" && p.id !== "api" && !p.id.startsWith("acp:") && p.id !== "acp-custom",
  );
  const apiProvider = providers.find((p) => p.id === "api");
  const customAcpProviders = providers.filter((p) => p.id.startsWith("acp:") || p.id === "acp-custom");
  const ambientVars = [...new Set(Object.values(ambientKeyOverrides).flat())];

  return (
    <>
      <Section title="AI subscriptions">
        <Row
          label="Official subscription CLIs"
          description="Use ChatGPT Plus/Pro, Claude Pro/Max, Google AI Pro/Ultra, GitHub Copilot, Kimi, Qwen, or OpenCode alongside Muse. Ancilla invokes each vendor's unmodified official CLI over stdio and never reads or copies OAuth tokens."
        >
          <Button size="sm" variant="secondary" onClick={() => void controller.loadProviders(true)}>
            <ArrowsClockwiseIcon size={13} /> Refresh CLIs
          </Button>
        </Row>
        {ambientVars.length > 0 ? (
          <div className="border-t border-line px-4 py-3">
            <div className="rounded-lg border border-line bg-warn-soft p-3 text-xs leading-relaxed text-warn-text">
              <p className="flex items-center gap-2 font-medium">
                <WarningIcon size={14} /> Ambient API keys detected ({ambientVars.join(", ")})
              </p>
              <p className="mt-1">
                Ancilla automatically strips pay-as-you-go API environment variables when spawning subscription CLIs so your turns bill to your flat-rate subscription instead of per-token API keys.
              </p>
            </div>
          </div>
        ) : null}
        {cliProviders.map((provider) => {
          const badge = authBadge(provider.defaultAuth, provider.binary.available);
          const accounts = provider.accounts.filter(isProviderAccount);
          return (
            <div key={provider.id} className="border-t border-line">
              <Row
                label={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span>{provider.displayName}</span>
                    <StatusPill tone={badge.tone}>{badge.label}</StatusPill>
                  </span>
                }
                description={
                  provider.binary.available
                    ? `${provider.subscriptionSummary}. Found at ${provider.binary.binaryPath ?? provider.binaryName ?? provider.id}.`
                    : `${provider.subscriptionSummary}. Install the official ${provider.vendorName} CLI to use this subscription.`
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  {provider.binary.available ? (
                    <>
                      <Button
                        size="sm"
                        variant={provider.defaultAuth?.state === "authenticated" ? "secondary" : "primary"}
                        onClick={() => void controller.beginProviderLogin(provider.id, null)}
                      >
                        <SignInIcon size={13} /> {provider.defaultAuth?.state === "authenticated" ? "Sign in again" : "Sign in"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setAddingCliFor(provider)}>
                        <PlusIcon size={13} /> Add profile
                      </Button>
                    </>
                  ) : provider.installDocsUrl ? (
                    <a
                      href={provider.installDocsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-sunken px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
                    >
                      Install CLI <ArrowSquareOutIcon size={12} />
                    </a>
                  ) : null}
                </div>
              </Row>
              {accounts.map((acct) => {
                const acctBadge = authBadge(acct.auth, provider.binary.available);
                return (
                  <div key={acct.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 bg-sunken/40 px-6 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-xs font-medium text-fg">
                        <span>{acct.name}</span>
                        <StatusPill tone={acctBadge.tone}>{acctBadge.label}</StatusPill>
                      </p>
                      {acct.auth?.summary ? <p className="mt-0.5 text-2xs text-muted">{acct.auth.summary}</p> : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {provider.binary.available ? (
                        <Button size="sm" variant="secondary" onClick={() => void controller.beginProviderLogin(provider.id, acct.id)}>
                          <SignInIcon size={12} /> Sign in
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => void controller.removeProviderAccount(acct.id)}>
                        <TrashIcon size={12} /> Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </Section>

      <Section title="Direct API & local models">
        <Row
          label="API keys, aggregators & local servers"
          description="Bring your own API key for OpenRouter, Venice, OpenAI, Anthropic, or Google Gemini, or point Ancilla at Ollama, LM Studio, llama.cpp, or vLLM on localhost with full workspace tools and approval gates."
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditingApi(null);
              setApiModalOpen(true);
            }}
          >
            <PlusIcon size={13} /> Add endpoint
          </Button>
        </Row>
        {(apiProvider?.accounts ?? []).filter(isProviderAccount).map((acct) => (
          <Row
            key={acct.id}
            label={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>{acct.name}</span>
                <StatusPill tone="ok">{acct.apiKind ?? "openai"}</StatusPill>
                {acct.hasApiKey ? <StatusPill tone="neutral">Key saved</StatusPill> : null}
              </span>
            }
            description={[acct.apiBaseUrl, acct.defaultModelId ? `Default: ${acct.defaultModelId}` : null].filter(Boolean).join(" · ")}
          >
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setEditingApi(acct);
                  setApiModalOpen(true);
                }}
              >
                <PencilSimpleIcon size={13} /> Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void controller.removeProviderAccount(acct.id)}>
                <TrashIcon size={13} /> Remove
              </Button>
            </div>
          </Row>
        ))}
      </Section>

      <Section title="Custom ACP agents">
        <Row
          label="Agent Client Protocol (ACP)"
          description="Register any third-party or custom coding agent that speaks JSON-RPC 2.0 ACP over stdio."
        >
          <Button size="sm" variant="secondary" onClick={() => setAcpModalOpen(true)}>
            <PlusIcon size={13} /> Add ACP agent
          </Button>
        </Row>
        {customAcpProviders.flatMap((p) =>
          p.accounts.filter(isProviderAccount).map((acct) => (
            <Row
              key={acct.id}
              label={
                <span className="inline-flex items-center gap-2">
                  <span>{acct.name}</span>
                  <StatusPill tone={p.binary.available ? "ok" : "warn"}>
                    {p.binary.available ? "Ready" : "Binary not found"}
                  </StatusPill>
                </span>
              }
              description={`${acct.binaryPath ?? p.binaryName ?? p.id} ${(acct.customArgs ?? []).join(" ")}`.trim()}
            >
              <Button size="sm" variant="ghost" onClick={() => void controller.removeProviderAccount(acct.id)}>
                <TrashIcon size={13} /> Remove
              </Button>
            </Row>
          )),
        )}
      </Section>

      <AddCliProfileModal provider={addingCliFor} onOpenChange={(open) => !open && setAddingCliFor(null)} />
      <ApiEndpointModal
        open={apiModalOpen}
        editing={editingApi}
        onOpenChange={(open) => {
          setApiModalOpen(open);
          if (!open) {
            setEditingApi(null);
          }
        }}
      />
      <CustomAcpModal open={acpModalOpen} onOpenChange={setAcpModalOpen} />
    </>
  );
}
