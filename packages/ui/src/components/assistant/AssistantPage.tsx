import { useEffect, useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { useOverlayDragProps } from "../../app/frame.js";
import { errorMessage } from "../../client.js";
import type { AssistantStatusView, AssistantSuggestionView } from "../../types.js";
import { TopBar } from "../chrome.js";
import { Pick, Section } from "../settings/SettingsPage.js";
import { ArrowLeftIcon, MicrophoneIcon, PhoneDisconnectIcon } from "../ui/icons.js";
import { Modal } from "../ui/overlays.js";
import { Button, Toggle } from "../ui/primitives.js";
import { onWantedTab, takeWantedTab } from "../voice/nav.js";
import { useTalk } from "../voice/talk.js";
import { VoicePanel } from "../voice/VoicePanel.js";
import { useAssistantCall, useAssistantData } from "./api.js";
import { CompanionHero, History, IdentityBar, Rules } from "./companion/Companion.js";
import { ConnectorsPanel } from "./ConnectorsPanel.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { Onboarding } from "./Onboarding.js";
import { Notice } from "./parts.js";
import { PersonaPanel } from "./PersonaPanel.js";
import { ProfilePanel } from "./ProfilePanel.js";
import { Suggestion, TasksPanel } from "./TasksPanel.js";

type Tab = "home" | "memory" | "tasks" | "connectors" | "persona" | "voice" | "settings";
const TABS: readonly Tab[] = ["home", "memory", "tasks", "connectors", "persona", "voice", "settings"];

/**
 * The assistant's home. A first visit is an introduction: a face, a voice, a name, and only then is it switched on. After
 * that, Home is the assistant itself with what waits on you and what the two of you have done; then its memory, its tasks,
 * who it is, and what it may do alone.
 */
export function AssistantPage() {
  const controller = useController();
  const drag = useOverlayDragProps();
  const collapsed = useApp((s) => s.prefs.sidebarCollapsed);
  const call = useAssistantCall();
  const [bump, setBump] = useState(0);
  const status = useAssistantData<AssistantStatusView>("", bump);
  const [tab, setTab] = useState<Tab>(() => {
    const wanted = takeWantedTab();
    return TABS.includes(wanted as Tab) ? (wanted as Tab) : "home";
  });
  // Something elsewhere (the call card, the sidebar) can send the person to a tab while this page is open.
  useEffect(() => onWantedTab((wanted) => {
    if (TABS.includes(wanted as Tab)) {
      takeWantedTab();
      setTab(wanted as Tab);
    }
  }), []);
  const voice = useTalk();
  const [making, setMaking] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = () => {
    setBump((n) => n + 1);
    void controller.loadAssistantGlance();
  };
  const data = status.data;
  const profile = data?.profile;
  const configured = profile ? profile.character.setupAt !== null : false;
  const firstVisit = Boolean(data && profile && !profile.enabled && !configured);
  const meeting = firstVisit || making;

  const setEnabled = async (enabled: boolean) => {
    if (!profile) return;
    setError(null);
    try {
      await call("PATCH", "/profile", { enabled, expectedUpdatedAt: profile.updatedAt });
      changed();
    } catch (e) {
      setError(errorMessage(e));
      changed();
    }
  };

  return (
    <div className="@container flex h-full min-w-0 flex-col">
      {collapsed ? <TopBar /> : null}
      <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div data-drag-region {...drag} className="shrink-0">
          <header className="mx-auto flex w-full max-w-[820px] flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-8 pb-1 @min-[520px]:flex-nowrap @min-[520px]:px-6">
            <Button size="sm" variant="ghost" className="order-1" onClick={() => controller.goBack()}>
              <ArrowLeftIcon size={14} /> Back
            </Button>
            <div className="order-3 min-w-0 basis-full @min-[520px]:order-2 @min-[520px]:flex-1 @min-[520px]:basis-auto">
              <h1 className="text-lg font-semibold text-fg">Assistant</h1>
              <p className="text-xs text-muted">Remembers what you tell it, with your exact words, and works on what you approve. Kept on this device, in its own file.</p>
            </div>
            {profile && configured && !meeting ? (
              <div className="order-2 ml-auto flex items-center gap-3 @min-[520px]:order-3 @min-[520px]:ml-0">
                {profile.enabled && controller.hasVoice ? (
                  <Button size="sm" variant={voice.live ? "danger" : "accent"} onClick={voice.talk} onPointerEnter={voice.warm} onFocus={voice.warm} aria-label={voice.live ? "End the call" : `Talk to ${profile.name}`}>
                    {voice.live ? <PhoneDisconnectIcon size={14} /> : <MicrophoneIcon size={14} />}
                    {voice.live ? "End call" : "Talk"}
                  </Button>
                ) : null}
                <Toggle checked={profile.enabled} label="Switch the assistant on" onChange={(on) => (on ? setConfirmOn(true) : void setEnabled(false))} />
              </div>
            ) : null}
          </header>
        </div>

        <div className="mx-auto w-full min-w-0 max-w-[820px] px-4 pb-16 @min-[520px]:px-6">
          {status.error && !data ? <div className="mt-6"><Notice tone="error">{status.error}</Notice></div> : null}
          {!data && !status.error ? <p className="mt-6 text-sm text-subtle">Opening the assistant...</p> : null}
          {error ? <div className="mt-6"><Notice tone="error">{error}</Notice></div> : null}

          {data && profile && meeting ? (
            <Onboarding
              profile={profile}
              onDone={() => {
                setMaking(false);
                setTab("home");
                changed();
              }}
              onCancel={() => (firstVisit ? controller.goBack() : setMaking(false))}
            />
          ) : null}

          {data && profile && !meeting ? (
            <>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Pick<Tab>
                  value={tab}
                  options={[
                    { value: "home", label: "Home" },
                    { value: "memory", label: `Memory (${data.stats.items.active + data.stats.items.contested})` },
                    { value: "tasks", label: `Tasks${data.tasks && data.tasks.needsYou > 0 ? ` (${data.tasks.needsYou} need you)` : data.tasks && data.tasks.open > 0 ? ` (${data.tasks.open})` : ""}` },
                    { value: "connectors", label: "Connectors" },
                    { value: "persona", label: "Persona" },
                    ...(controller.hasVoice ? [{ value: "voice" as const, label: "Voice" }] : []),
                    { value: "settings", label: "Settings" },
                  ]}
                  onChange={setTab}
                />
                {profile.enabled && profile.capturePaused ? <span className="text-xs text-warn-text">Not remembering new things: capture is paused.</span> : null}
              </div>

              {tab === "home" ? <Home status={data} bump={bump} changed={changed} onMake={() => setMaking(true)} onWake={() => setConfirmOn(true)} onTab={setTab} /> : null}
              {tab === "memory" ? <><IdentityBar status={data} />{profile.enabled ? <MemoryPanel profile={profile} changed={changed} bump={bump} /> : <Asleep onWake={() => setConfirmOn(true)} />}</> : null}
              {tab === "tasks" ? (
                <>
                  <IdentityBar status={data} />
                  {!profile.enabled ? <Asleep onWake={() => setConfirmOn(true)} /> : data.executive === false ? <div className="mt-6"><Notice>Tasks need a Muse host, and this server was not given one.</Notice></div> : <TasksPanel profile={profile} changed={changed} bump={bump} />}
                </>
              ) : null}
              {tab === "connectors" ? <><IdentityBar status={data} />{!profile.enabled ? <Asleep onWake={() => setConfirmOn(true)} /> : <ConnectorsPanel changed={changed} bump={bump} />}</> : null}
              {tab === "persona" ? <PersonaPanel profile={profile} changed={changed} /> : null}
              {tab === "voice" ? <><IdentityBar status={data} /><VoicePanel changed={changed} /></> : null}
              {tab === "settings" ? <><IdentityBar status={data} /><ProfilePanel profile={profile} changed={changed} bump={bump} /></> : null}
            </>
          ) : null}
        </div>
      </div>

      <Modal
        open={confirmOn}
        onOpenChange={setConfirmOn}
        title={`Switch ${profile?.name ?? "the assistant"} on?`}
        description="From now on it reads what you type in threads for things worth keeping, and puts the notes that apply in front of your messages. It makes no model call of its own, and nothing leaves this device through it."
      >
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Notes are kept in assistant.db in Ancilla&apos;s data folder, with the exact words each came from.</li>
          <li>Passwords, keys and ID numbers are never kept.</li>
          <li>You can read, correct, pin, export and erase any note, pause remembering, or switch it all off.</li>
          <li>Tasks run through Muse on your plan, in threads you can open, under limits you set.</li>
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmOn(false)}>
            Not now
          </Button>
          <Button
            variant="accent"
            onClick={() => {
              setConfirmOn(false);
              void setEnabled(true);
            }}
          >
            Switch it on
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function Asleep(props: { onWake: () => void }) {
  return (
    <div className="mt-6 rounded-xl bg-raised p-5 shadow-panel">
      <p className="text-sm text-fg">It is switched off, so it keeps nothing new and starts nothing. What it already holds is still here, and unused.</p>
      <div className="mt-3">
        <Button variant="accent" onClick={props.onWake}>
          Switch it on
        </Button>
      </div>
    </div>
  );
}

/** Home: the assistant, what waits on you, the rules it follows and what the two of you have done. */
function Home(props: { status: AssistantStatusView; bump: number; changed: () => void; onMake: () => void; onWake: () => void; onTab: (tab: Tab) => void }) {
  const { status } = props;
  const suggestions = useAssistantData<{ suggestions: AssistantSuggestionView[] }>(status.profile.enabled ? "/suggestions" : null, props.bump);
  const waiting = suggestions.data?.suggestions.slice(0, 4) ?? [];
  return (
    <div className="mt-6">
      <CompanionHero status={status} onMake={props.onMake} onWake={props.onWake} onPersona={() => props.onTab("persona")} />
      {status.profile.enabled && waiting.length > 0 ? (
        <Section title={status.profile.autonomy === "ask" ? "Waiting on you" : "What it would do next"}>
          {waiting.map((s) => (
            <Suggestion key={s.id} suggestion={s} autonomy={status.profile.autonomy} changed={props.changed} />
          ))}
        </Section>
      ) : null}
      {status.profile.enabled ? <Rules bump={props.bump} onMemory={() => props.onTab("memory")} /> : null}
      {status.profile.enabled ? <History status={status} /> : null}
    </div>
  );
}
