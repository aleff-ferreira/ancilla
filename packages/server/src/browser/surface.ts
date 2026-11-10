import { CdpError } from "./cdp.js";
import { describeClick, looksLikeCommit, typingRefusal, type ActionAsk } from "./commit.js";
import { BrowserError, type BrowserService, type ElementFacts } from "./service.js";
import { originOf } from "./sites.js";

/**
 * The browser as the browsing agent sees it: one tab in the assistant's own context, and a handful of verbs that each answer with
 * the page as it is afterwards. Nothing here reaches the person's tabs, and every refusal comes back as words the model can act on.
 */

export interface PageView {
  url: string;
  title: string;
  /** The page as compact text with refs (see snapshot.ts); it opens with a line saying it is untrusted data. */
  text: string;
  /** What the page did that the model should hear about: a site that was refused, a popup that was closed, a dialog that was dismissed. */
  notes: string[];
}

export interface BrowseSurface {
  open(url: string): Promise<PageView>;
  read(): Promise<PageView>;
  click(ref: string): Promise<PageView>;
  type(ref: string | null, text: string, submit: boolean): Promise<PageView>;
  press(key: string): Promise<PageView>;
  scroll(direction: "up" | "down"): Promise<PageView>;
  back(): Promise<PageView>;
  /** Done with the browser: the assistant's context (cookies, storage, tabs) is thrown away. */
  close(): Promise<void>;
}

/** An error whose message is for the model: it says what went wrong and what to do about it. */
export class SurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceError";
  }
}

/** How much of a page goes to the model at a time. */
export const VIEW_MAX_CHARS = 6000;
const SCROLL_PX = 600;
/** A page that is still loading is given this long, after a question was answered, to arrive. */
const AFTER_QUESTION_LOAD_MS = 15_000;

/** What the surface needs of the sites gate: ask before a page is opened, and wait for any question the page itself raised. */
export interface SurfaceGate {
  /** Resolves true when the site may be opened (a rule or an earlier answer says so, or the person answers yes). */
  request(url: string): Promise<boolean>;
  /** Resolves when no question about this task is waiting. */
  settled(): Promise<void>;
  /** Resolves true when the person allows this action: asked every time, nothing is remembered. */
  confirm(ask: ActionAsk): Promise<boolean>;
  /** The click that was approved has been sent: it covers nothing more. */
  endApproval(): void;
}

const NOT_ALLOWED = "The person did not allow that, so it was not done. Nothing was changed. Do not try again by another route: call done and say what you could not do.";
/** Keys that activate the focused button or send the form it is in. */
const ACTIVATING = new Set(["Enter", "NumpadEnter", " ", "Space"]);

export class ServiceSurface implements BrowseSurface {
  private tabId: string | null = null;

  constructor(
    private readonly service: BrowserService,
    private readonly gate: SurfaceGate,
  ) {}

  private async tab(): Promise<string> {
    if (this.tabId && (await this.service.listTabs()).some((t) => t.id === this.tabId)) return this.tabId;
    const tab = await this.service.openTab("assistant");
    this.tabId = tab.id;
    return tab.id;
  }

  private async view(id: string): Promise<PageView> {
    // A click may have led to a site the person is being asked about: the page waits for the answer, and so does the look at it.
    await this.gate.settled();
    await this.service.waitLoaded(id, AFTER_QUESTION_LOAD_MS);
    // A page that was refused is aborted, so the page that had the link is still there: the note says what happened.
    const notes = this.service.takeNotes(id);
    const [snapshot, tabs] = await Promise.all([this.service.snapshot(id, { maxChars: VIEW_MAX_CHARS }), this.service.listTabs()]);
    const info = tabs.find((t) => t.id === id);
    return { url: info?.url ?? "", title: info?.title ?? "", text: snapshot.text, notes };
  }

  private async act(run: (id: string) => Promise<unknown>): Promise<PageView> {
    try {
      this.gate.endApproval();
      const id = await this.tab();
      await run(id);
      return await this.view(id);
    } catch (error) {
      throw toSurfaceError(error);
    }
  }

  async open(url: string): Promise<PageView> {
    let target: string;
    try {
      target = new URL(url).href;
    } catch {
      throw new SurfaceError(`"${url.slice(0, 80)}" is not a full web address. Use one that starts with http:// or https://.`);
    }
    // Asked here, before anything is sent: a question can take a person minutes, and a navigation that waits that long times out.
    if (!(await this.gate.request(target))) throw new SurfaceError("The person did not allow that site, so it was not opened. Try another site, or call done and say what you could not reach.");
    return this.act((id) => this.service.navigate(id, target));
  }

  read(): Promise<PageView> {
    return this.act(() => Promise.resolve());
  }

  /** Asks the person about an element that commits something, before it is clicked or pressed. Throws when they say no. */
  private async confirm(id: string, verb: string, label: string, facts: ElementFacts | null): Promise<void> {
    const info = (await this.service.listTabs()).find((t) => t.id === id);
    const origin = originOf(info?.url ?? "") ?? info?.url ?? "";
    const ask = describeClick({ origin, page: info?.title ?? "", verb, label, form: facts?.form ?? null });
    if (!(await this.gate.confirm(ask))) throw new SurfaceError(NOT_ALLOWED);
  }

  click(ref: string): Promise<PageView> {
    return this.act(async (id) => {
      const info = this.service.refInfo(id, ref);
      if (info && looksLikeCommit(info.role, info.name)) await this.confirm(id, "Click", info.name, await this.service.elementFacts(id, ref));
      await this.service.click(id, { ref });
    });
  }

  /** Enter or Space on a button, or Enter in a field whose form has a button that commits, is that button being pressed. */
  private async pressGuarded(id: string, key: string): Promise<void> {
    if (ACTIVATING.has(key)) {
      const facts = await this.service.elementFacts(id, null);
      if (facts) {
        const pressable = facts.tag === "button" || facts.tag === "a" || facts.role === "button" || (facts.tag === "input" && ["submit", "button", "image"].includes(facts.type));
        const enters = key === "Enter" || key === "NumpadEnter";
        const label = pressable ? facts.label : enters && facts.tag !== "textarea" && facts.form ? facts.form.defaultButton : "";
        if (label !== "" && looksLikeCommit("button", label)) await this.confirm(id, `Press ${key === " " ? "Space" : key} on`, label, facts);
      }
    }
    await this.service.press(id, key);
  }

  type(ref: string | null, text: string, submit: boolean): Promise<PageView> {
    return this.act(async (id) => {
      const facts = await this.service.elementFacts(id, ref);
      const refusal = typingRefusal(text, facts ? { type: facts.type, autocomplete: facts.autocomplete, name: facts.name } : null);
      if (refusal) throw new SurfaceError(refusal);
      await this.service.type(id, ref ? { ref } : null, text, { clear: ref !== null, submit: false });
      if (submit) await this.pressGuarded(id, "Enter");
    });
  }

  press(key: string): Promise<PageView> {
    return this.act((id) => this.pressGuarded(id, key));
  }

  scroll(direction: "up" | "down"): Promise<PageView> {
    return this.act((id) => this.service.scroll(id, { deltaY: direction === "up" ? -SCROLL_PX : SCROLL_PX }));
  }

  back(): Promise<PageView> {
    return this.act((id) => this.service.back(id));
  }

  async close(): Promise<void> {
    this.tabId = null;
    await this.service.resetAssistant().catch(() => undefined);
  }
}

export function toSurfaceError(error: unknown): SurfaceError {
  if (error instanceof SurfaceError) return error;
  if (error instanceof BrowserError) {
    switch (error.code) {
      case "blocked":
        return new SurfaceError("The person did not allow that site, so it was not opened. Try another site, or call done and say what you could not reach.");
      case "stale-ref":
        return new SurfaceError("That ref is not on the page any more. Call read to see the page again, then use a ref from it.");
      case "no-tab":
      case "closed":
        return new SurfaceError("The page was closed. Call open with an address to start again.");
      case "unavailable":
        return new SurfaceError(`The browser is not available: ${error.message}`);
      default:
        return new SurfaceError(error.message);
    }
  }
  if (error instanceof CdpError) return new SurfaceError("The page did not answer in time. Call read to see where it is, or try another page.");
  return new SurfaceError(error instanceof Error ? error.message : String(error));
}
