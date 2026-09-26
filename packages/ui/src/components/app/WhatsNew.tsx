import { useEffect, useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { CHANGELOG, newEntries } from "../../model/changelog.js";
import { Markdown } from "../ui/Markdown.js";
import { Modal } from "../ui/overlays.js";
import { Button } from "../ui/primitives.js";

/**
 * What changed, either because the app updated itself or because Settings asked for it. The notes
 * are built in, so this costs no request and says the same thing offline; opening it sends nothing.
 *
 * Shown by itself only after an update, which needs the running version, and only the desktop shell
 * reports one. A first run records the version and stays quiet: there is nothing to have missed.
 */
export function WhatsNew() {
  const controller = useController();
  const current = useApp((s) => s.updates?.currentVersion ?? null);
  const seen = useApp((s) => s.prefs.lastSeenVersion);
  const asked = useApp((s) => s.whatsNewOpen);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // A version with nothing to show is recorded straight away, so the notes are not kept waiting
    // for a release that happens to have an entry.
    if (current && seen === null) {
      controller.setPrefs({ lastSeenVersion: current });
    }
  }, [controller, current, seen]);

  const missed = newEntries(seen, current);
  // Asked for with nothing missed: the latest notes, which is what someone reading Settings wants.
  const entries = asked && missed.length === 0 ? CHANGELOG.slice(0, 1) : missed;
  const open = entries.length > 0 && (asked || !dismissed);

  const close = () => {
    setDismissed(true);
    controller.setWhatsNewOpen(false);
    if (current) {
      controller.setPrefs({ lastSeenVersion: current });
    }
  };

  if (!open) {
    return null;
  }
  const title = entries.length === 1 ? `What's new in ${entries[0].version}` : `What's new since ${seen}`;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={title}
      description={entries.length === 1 ? undefined : `${entries.length} releases while you were away.`}
      className="top-[12vh] w-[min(560px,calc(100dvw-32px))]"
    >
      <div className="mt-4 flex max-h-[min(60dvh,520px)] flex-col gap-6 overflow-y-auto">
        {entries.map((entry) => (
          <section key={entry.version} className="flex flex-col gap-2">
            {entries.length > 1 ? <h3 className="text-[13px] font-semibold text-fg tabular-nums">{entry.version}</h3> : null}
            <Markdown text={entry.body} className="text-[14px] leading-relaxed text-muted" />
          </section>
        ))}
      </div>
      <div className="mt-5 flex justify-end">
        <Button onClick={close}>Got it</Button>
      </div>
    </Modal>
  );
}
