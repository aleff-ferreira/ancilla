import { useApp, useController } from "../../../app/context.js";
import { XIcon } from "../../ui/icons.js";
import { Tip } from "../../ui/overlays.js";
import { cn } from "../../ui/primitives.js";
import { Avatar } from "./Avatar.js";
import { stateOf, useFaceMood, type CompanionState } from "./mood.js";

/** The words under the name, plain on purpose: this is the one place that has to say clearly what is going on. */
export function chipSub(state: CompanionState, needsYou: number): string {
  switch (state) {
    case "invite": return "Give it a face and a voice";
    case "off": return "Switched off";
    case "needs": return needsYou === 1 ? "1 needs you" : `${needsYou} need you`;
    case "working": return "Working";
    default: return "Ready";
  }
}

/**
 * The assistant in the sidebar, under New thread and Search, where it is seen every time the app is. Until it is set up
 * it asks, with a light moving round its card; the "x" says "not now" and stops the light, and the card keeps asking in
 * words. Once it is set up it is its face, its name and one plain line, and a badge when something waits on you.
 */
export function CompanionChip() {
  const controller = useController();
  const glance = useApp((s) => s.assistantGlance);
  const reaction = useApp((s) => s.assistantReaction);
  const invite = useApp((s) => s.prefs.assistantInvite);
  const active = useApp((s) => s.route.kind === "assistant");
  const face = useFaceMood(glance, reaction);
  if (!glance || invite === "hidden") return null;
  const state = stateOf(glance);
  const asking = state === "invite";
  const sub = chipSub(state, glance.needsYou);
  return (
    <div className="group/cc relative">
      <button
        type="button"
        data-state={state}
        data-invite={asking ? invite : undefined}
        aria-current={active ? "page" : undefined}
        aria-label={asking ? "Meet your assistant: give it a face and a voice" : `${glance.name}: ${sub}`}
        onClick={() => controller.navigate({ kind: "assistant" })}
        className={cn("companion-chip", active && "active")}
      >
        <span className="cc-face">
          <Avatar spec={glance.character.avatar} name={glance.name} mood={face.mood} burst={face.burst} size={36} stage look />
        </span>
        <span className="cc-tx">
          <span className="cc-name">{asking ? "Meet your assistant" : glance.name}</span>
          <span className="cc-sub">{sub}</span>
        </span>
        {state === "needs" ? <span className="cc-badge" aria-hidden="true">{glance.needsYou}</span> : null}
        {asking ? <span className="cc-go" aria-hidden="true">Set up</span> : null}
      </button>
      {asking && invite === "pulse" ? (
        <Tip label="Not now">
          <button
            type="button"
            aria-label="Not now: stop the light, keep the card"
            onClick={() => controller.setPrefs({ assistantInvite: "calm" })}
            className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-md text-subtle opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/cc:opacity-100"
          >
            <XIcon size={11} />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}
