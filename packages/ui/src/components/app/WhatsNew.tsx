import { type JSX, useEffect, useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { CHANGELOG, newEntries, type ChangelogEntry } from "../../model/changelog.js";
import { Markdown } from "../ui/Markdown.js";
import { Modal } from "../ui/overlays.js";
import { Button, cn } from "../ui/primitives.js";

function ReleaseItem({ note, displayHeading }: { note: ChangelogEntry; displayHeading: boolean }): JSX.Element {
  return (
    <article key={note.version} className="flex flex-col gap-2">
      {displayHeading ? (
        <h3 className="text-[13px] font-semibold text-fg tabular-nums">{note.version}</h3>
      ) : null}
      <Markdown text={note.body} className="text-[14px] leading-relaxed text-muted" />
    </article>
  );
}

export function WhatsNew(): JSX.Element | null {
  const { setPrefs, setWhatsNewOpen } = useController();
  const runningVersion = useApp((s) => s.updates?.currentVersion ?? null);
  const storedVersion = useApp((s) => s.prefs.lastSeenVersion);
  const manualOpen = useApp((s) => s.whatsNewOpen);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (runningVersion && storedVersion === null) {
      setPrefs({ lastSeenVersion: runningVersion });
    }
  }, [setPrefs, runningVersion, storedVersion]);

  const unreadChangelog = newEntries(storedVersion, runningVersion);
  const displayedEntries: readonly ChangelogEntry[] = manualOpen && unreadChangelog.length === 0
    ? CHANGELOG.slice(0, 1)
    : unreadChangelog;

  const shouldDisplay = displayedEntries.length > 0 && (manualOpen || !closed);

  if (!shouldDisplay) return null;

  const onDismiss = () => {
    setClosed(true);
    setWhatsNewOpen(false);
    if (runningVersion) {
      setPrefs({ lastSeenVersion: runningVersion });
    }
  };

  const headerTitle = displayedEntries.length === 1
    ? `What's new in ${displayedEntries[0].version}`
    : `What's new since ${storedVersion}`;

  const subtitleText = displayedEntries.length === 1
    ? undefined
    : `${displayedEntries.length} releases while you were away.`;

  return (
    <Modal
      open={shouldDisplay}
      onOpenChange={(visible) => {
        if (!visible) onDismiss();
      }}
      title={headerTitle}
      description={subtitleText}
      className={cn("top-[12vh]", "w-[min(560px,calc(100dvw-32px))]")}
    >
      <div className="mt-4 flex max-h-[min(60dvh,520px)] flex-col gap-6 overflow-y-auto">
        {displayedEntries.map((item) => (
          <ReleaseItem
            key={item.version}
            note={item}
            displayHeading={displayedEntries.length > 1}
          />
        ))}
      </div>
      <footer className="mt-5 flex justify-end">
        <Button onClick={onDismiss}>Got it</Button>
      </footer>
    </Modal>
  );
}
