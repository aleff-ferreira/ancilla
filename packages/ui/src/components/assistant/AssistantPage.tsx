import { useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { useOverlayDragProps } from "../../app/frame.js";
import { errorMessage } from "../../client.js";
import type { AssistantStatusView } from "../../types.js";
import { TopBar } from "../chrome.js";
import { Pick } from "../settings/SettingsPage.js";
import { ArrowLeftIcon } from "../ui/icons.js";
import { Modal } from "../ui/overlays.js";
import { Button, Toggle } from "../ui/primitives.js";
import { useAssistantCall, useAssistantData } from "./api.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { Notice } from "./parts.js";
import { ProfilePanel } from "./ProfilePanel.js";
import { TasksPanel } from "./TasksPanel.js";

type Tab = "memory" | "tasks" | "profile";

/**
 * The assistant: a memory that keeps what you told it with the exact words, can be read, corrected and erased, and a
 * task executive that works on what you approve and says what it does not know. Off until you switch it on.
 */
export function AssistantPage() {
  const controller = useController();
  const drag = useOverlayDragProps();
  const collapsed = useApp((s) => s.prefs.sidebarCollapsed);
  const call = useAssistantCall();
  const [bump, setBump] = useState(0);
  const status = useAssistantData<AssistantStatusView>("", bump);
  const [tab, setTab] = useState<Tab>("memory");
  const [confirmOn, setConfirmOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = () => setBump((n) => n + 1);
  const data = status.data;
  const profile = data?.profile;

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
            {profile ? (
              <div className="order-2 ml-auto @min-[520px]:order-3 @min-[520px]:ml-0">
                <Toggle checked={profile.enabled} label="Switch the assistant on" onChange={(on) => (on ? setConfirmOn(true) : void setEnabled(false))} />
              </div>
            ) : null}
          </header>
        </div>

        <div className="mx-auto w-full min-w-0 max-w-[820px] px-4 pb-16 @min-[520px]:px-6">
          {status.error && !data ? <div className="mt-6"><Notice tone="error">{status.error}</Notice></div> : null}
          {!data && !status.error ? <p className="mt-6 text-sm text-subtle">Opening the assistant...</p> : null}
          {error ? <div className="mt-6"><Notice tone="error">{error}</Notice></div> : null}
          {data && profile && !profile.enabled ? <Intro data={data} onEnable={() => setConfirmOn(true)} changed={changed} /> : null}
          {data && profile?.enabled ? (
            <>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Pick<Tab>
                  value={tab}
                  options={[
                    { value: "memory", label: `Memory (${data.stats.items.active + data.stats.items.contested})` },
                    { value: "tasks", label: `Tasks${data.tasks && data.tasks.needsYou > 0 ? ` (${data.tasks.needsYou} need you)` : data.tasks && data.tasks.open > 0 ? ` (${data.tasks.open})` : ""}` },
                    { value: "profile", label: "Settings" },
                  ]}
                  onChange={setTab}
                />
                {profile.capturePaused ? <span className="text-xs text-warn-text">Not remembering new things: capture is paused.</span> : null}
              </div>
              {tab === "memory" ? <MemoryPanel profile={profile} changed={changed} bump={bump} /> : null}
              {tab === "tasks" ? (data.executive === false ? <div className="mt-6"><Notice>Tasks need a Muse host, and this server was not given one.</Notice></div> : <TasksPanel profile={profile} changed={changed} bump={bump} />) : null}
              {tab === "profile" ? <ProfilePanel profile={profile} changed={changed} bump={bump} /> : null}
            </>
          ) : null}
        </div>
      </div>

      <Modal
        open={confirmOn}
        onOpenChange={setConfirmOn}
        title="Switch the assistant on?"
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

function Intro(props: { data: AssistantStatusView; onEnable: () => void; changed: () => void }) {
  const kept = props.data.stats.items.active + props.data.stats.items.contested;
  return (
    <div className="mt-6 space-y-4 rounded-xl bg-raised p-5 shadow-panel">
      <h2 className="text-base font-semibold text-fg">An assistant that keeps what you told it</h2>
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
        <li>
          <span className="text-fg">It remembers.</span> Rules, preferences, decisions, deadlines and facts, in your own words, with where each came from. A change of mind replaces a note and keeps the old one as history.
        </li>
        <li>
          <span className="text-fg">It stays honest.</span> A guess never replaces what you said, a note that may be out of date says so, and when nothing it saved answers a question, it says that.
        </li>
        <li>
          <span className="text-fg">It forgets when you say.</span> Forgetting erases the words everywhere, and the same old words are not learned again.
        </li>
        <li>
          <span className="text-fg">It works for you.</span> Tasks run one step at a time in a thread you can open, within limits you set, and finish as &quot;done&quot; only when something it can read confirms the result.
        </li>
        <li>It costs no extra: no model call of its own, no account, nothing sent anywhere.</li>
      </ul>
      {kept > 0 ? <Notice>{kept} saved note{kept === 1 ? " is" : "s are"} kept and not used while it is off. Switch it on to use them again.</Notice> : null}
      <Button variant="accent" onClick={props.onEnable}>
        Switch it on
      </Button>
    </div>
  );
}
