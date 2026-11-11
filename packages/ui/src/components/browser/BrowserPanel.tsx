import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useApp, useController } from "../../app/context.js";
import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, ArrowSquareOutIcon, GlobeIcon, PlusIcon, XIcon } from "../ui/icons.js";
import { Tip } from "../ui/overlays.js";
import { IconButton, MOD, cn } from "../ui/primitives.js";
import { DOCK_MIN_THREAD, useWindowWidth } from "../crew/CrewPanel.js";
import { PanelResize } from "../crew/PanelResize.js";
import { AssistantBar } from "./AssistantBar.js";
import { DownloadBox, UploadBox, isLocalBrowserHost } from "./DownloadForm.js";
import { type Frame, type PaneDialog, type PaneTab, type SelectProbe } from "./protocol.js";
import { MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, TextGate, planKeyDown, planKeyUp, resolveAddress, toPagePoint, toScreenRect } from "./input.js";
import { BrowserSession, EMPTY_VIEW, type SessionView, type SocketLike } from "./session.js";

/**
 * The Browser pane: the browser the server owns, drawn on a canvas and driven from here. The person's tabs, an address
 * bar, and the things a picture of a page cannot show (a select's list, a script's dialog, a refused download).
 * Input goes through a hidden text field so a Brazilian keyboard's dead keys and composed letters arrive whole.
 */

const VIEWPORT_DEBOUNCE_MS = 120;
const BUTTON_OF = ["left", "middle", "right"] as const;
const BUTTON_MASK = [1, 4, 2];

export function tabLabel(tab: PaneTab): string {
  if (tab.title.trim()) return tab.title.trim();
  if (!tab.url || tab.url === "about:blank") return "New tab";
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}

/** What the address bar shows for a tab: nothing for a blank one. */
export function addressOf(tab: PaneTab | undefined): string {
  return !tab || tab.url === "about:blank" ? "" : tab.url;
}

/** What the transient toast shows: never `message` when `<Status>` is already showing it (or would clear it on timer). */
export function toastText(view: Pick<SessionView, "status" | "notice" | "message">): string | null {
  return view.notice ?? (view.status === "open" ? view.message : null);
}

export function openInMyBrowser(url: string): void {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
}

export function BrowserPanel() {
  const controller = useController();
  const prefWidth = useApp((s) => s.prefs.crewWidth);
  const sidebar = useApp((s) => (s.prefs.sidebarCollapsed ? 0 : s.prefs.sidebarWidth));
  const windowWidth = useWindowWidth();
  const room = Math.max(0, windowWidth - sidebar);
  const overlay = room - prefWidth < DOCK_MIN_THREAD;
  const width = overlay ? Math.max(320, Math.min(prefWidth, room)) : prefWidth;

  const [view, setView] = useState<SessionView>(EMPTY_VIEW);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const page = useRef({ width: 0, height: 0 });
  const activeRef = useRef<string | null>(null);
  activeRef.current = view.active;
  const sessionRef = useRef<BrowserSession | null>(null);
  const gate = useRef(new TextGate());
  const cutPending = useRef(false);
  const waiting = useRef<Frame | null>(null);
  const decoding = useRef(false);

  const session = useMemo(() => {
    const created = new BrowserSession({
      url: () => controller.browserSocketUrl(),
      open: (url) => new WebSocket(url) as unknown as SocketLike,
      prepare: () => controller.prepareBrowserSocket(),
      retryMs: 1500,
      onChange: setView,
      // A picture is acknowledged when it arrives, so the server never waits on the decoder; one still waiting to be decoded
      // when a newer one comes is dropped, so a slow machine shows the latest picture, not a queue of old ones.
      onFrame: (frame: Frame, done: () => void) => {
        done();
        waiting.current = frame;
        if (decoding.current) return;
        decoding.current = true;
        void (async () => {
          while (waiting.current) {
            const next = waiting.current;
            waiting.current = null;
            const target = canvas.current;
            if (!target) continue;
            try {
              const bitmap = await createImageBitmap(new Blob([next.jpeg as BlobPart], { type: "image/jpeg" }));
              if (target.width !== bitmap.width || target.height !== bitmap.height) {
                target.width = bitmap.width;
                target.height = bitmap.height;
              }
              page.current = { width: next.width, height: next.height };
              target.getContext("2d")?.drawImage(bitmap, 0, 0);
              bitmap.close();
            } catch {
              /* a picture that cannot be decoded is skipped */
            }
          }
          decoding.current = false;
        })();
      },
      onSelection: (text) => {
        if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
        if (cutPending.current) {
          cutPending.current = false;
          const id = activeRef.current;
          if (id && text) {
            created.send({ type: "key", id, input: { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 } });
            created.send({ type: "key", id, input: { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 } });
          }
        }
      },
    });
    sessionRef.current = created;
    return created;
  }, [controller]);

  useEffect(() => {
    session.connect();
    const w = window as unknown as { __ancillaBrowser?: BrowserSession };
    w.__ancillaBrowser = session;
    return () => {
      session.disconnect();
      if (w.__ancillaBrowser === session) delete w.__ancillaBrowser;
    };
  }, [session]);

  // The page is as large as the pane (at density 1: the screencast gives no more pixels than the page's CSS size).
  useEffect(() => {
    const el = stage.current;
    if (!el || view.status !== "open" || !view.active) return;
    const id = view.active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      const box = el.getBoundingClientRect();
      const w = Math.round(box.width);
      const h = Math.round(box.height);
      if (w >= 100 && h >= 100) session.send({ type: "viewport", id, width: w, height: h });
    };
    send();
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(send, VIEWPORT_DEBOUNCE_MS);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [session, view.status, view.active]);

  const active = view.tabs.find((t) => t.id === view.active);
  const id = view.active;

  const point = useCallback((clientX: number, clientY: number) => {
    const box = canvas.current?.getBoundingClientRect();
    return box ? toPagePoint(box, page.current, clientX, clientY) : null;
  }, []);

  const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
    (e.altKey ? MOD_ALT : 0) | (e.ctrlKey ? MOD_CTRL : 0) | (e.metaKey ? MOD_META : 0) | (e.shiftKey ? MOD_SHIFT : 0);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!id) return;
    e.preventDefault();
    input.current?.focus({ preventScroll: true });
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    session.closeSelect();
    session.send({ type: "mouse", id, input: { type: "mousePressed", ...p, button: BUTTON_OF[e.button] ?? "left", buttons: BUTTON_MASK[e.button] ?? 1, clickCount: Math.min(3, Math.max(1, e.detail)), modifiers: modifiers(e) } });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!id) return;
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    session.send({ type: "mouse", id, input: { type: "mouseReleased", ...p, button: BUTTON_OF[e.button] ?? "left", buttons: 0, clickCount: Math.min(3, Math.max(1, e.detail)), modifiers: modifiers(e) } });
  };
  const moveFrame = useRef(0);
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!id || moveFrame.current) return;
    const { clientX, clientY, buttons } = e;
    const mods = modifiers(e);
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      const p = point(clientX, clientY);
      if (p) session.send({ type: "mouse", id, input: { type: "mouseMoved", ...p, button: buttons & 1 ? "left" : "none", buttons, modifiers: mods } });
    });
  };

  // A wheel must not scroll the app behind the pane, which a passive React handler cannot prevent.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const current = activeRef.current;
      if (!current) return;
      e.preventDefault();
      const p = point(e.clientX, e.clientY);
      if (!p) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1;
      sessionRef.current?.send({ type: "mouse", id: current, input: { type: "mouseWheel", ...p, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, modifiers: modifiers(e) } });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [point]);

  // Text, composition and the clipboard come as events of the hidden field.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const text = (value: string | null) => {
      const current = activeRef.current;
      if (value && current) sessionRef.current?.send({ type: "text", id: current, text: value });
    };
    const clear = () => {
      el.value = "";
    };
    const onBefore = (e: InputEvent) => {
      const value = gate.current.beforeInput(e.inputType, e.data, e.isComposing, performance.now());
      if (e.cancelable) e.preventDefault();
      text(value);
      clear();
    };
    const onCompositionStart = () => gate.current.compositionStart();
    const onCompositionEnd = (e: CompositionEvent) => {
      text(gate.current.compositionEnd(e.data, performance.now()));
      clear();
    };
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      text(e.clipboardData?.getData("text/plain").slice(0, 100_000) ?? null);
    };
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      const current = activeRef.current;
      if (current) sessionRef.current?.send({ type: "selection", id: current });
    };
    const onCut = (e: ClipboardEvent) => {
      onCopy(e);
      cutPending.current = true;
    };
    el.addEventListener("beforeinput", onBefore);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    el.addEventListener("paste", onPaste);
    el.addEventListener("copy", onCopy);
    el.addEventListener("cut", onCut);
    return () => {
      el.removeEventListener("beforeinput", onBefore);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("copy", onCopy);
      el.removeEventListener("cut", onCut);
    };
  }, []);

  const onKey = (down: boolean) => (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!id) return;
    const plan = (down ? planKeyDown : planKeyUp)({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing });
    if (plan.kind === "ignore") return;
    if (plan.prevent) e.preventDefault();
    if (down && e.key === "Escape") e.stopPropagation();
    for (const key of plan.inputs) session.send({ type: "key", id, input: key });
  };

  const close = () => controller.toggleBrowserPanel(false);

  const aside = (
    <aside
      id="browser-panel"
      aria-label="Browser"
      style={{ width }}
      className={cn(
        "@container flex h-full shrink-0 flex-col outline-none",
        overlay ? "absolute inset-y-0 right-0 z-[var(--z-overlay)] bg-raised shadow-pop" : "relative border-l border-line bg-bg",
      )}
    >
      {overlay ? null : <PanelResize label="Resize the Browser panel" />}
      <TabStrip tabs={view.tabs} active={view.active} onNew={() => session.send({ type: "open", url: null })} onSwitch={(tabId) => session.send({ type: "activate", id: tabId })} onClose={(tabId) => session.send({ type: "close", id: tabId })} onHide={close} />
      <Toolbar
        tab={active}
        disabled={!id || view.status !== "open"}
        onBack={() => id && session.send({ type: "back", id })}
        onForward={() => id && session.send({ type: "forward", id })}
        onReload={() => id && session.send({ type: "reload", id })}
        onGo={(text) => {
          const url = resolveAddress(text);
          if (id) session.send({ type: "navigate", id, url });
          else session.send({ type: "open", url });
          input.current?.focus({ preventScroll: true });
        }}
      />
      <div
        ref={stage}
        data-testid="browser-stage"
        className="relative min-h-0 flex-1 touch-none overflow-hidden bg-sunken"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-label={active ? `Page: ${tabLabel(active)}` : "Page"} role="img" />
        <textarea
          ref={input}
          aria-label="Type into the page"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={onKey(true)}
          onKeyUp={onKey(false)}
          className="pointer-events-none absolute top-0 left-0 size-px resize-none border-0 p-0 opacity-0 outline-none"
        />
        {view.select ? <SelectList select={view.select} stage={stage} page={page} onPick={(index) => { session.send({ type: "choose", id: view.select!.tabId, index }); session.closeSelect(); }} onClose={() => session.closeSelect()} /> : null}
        {view.dialog ? <DialogBox dialog={view.dialog} onAnswer={(accept, promptText) => session.send({ type: "dialog", id: view.dialog!.tabId, accept, ...(promptText !== undefined ? { promptText } : {}) })} /> : null}
        {view.status !== "open" ? <Status view={view} onConnect={(takeover) => session.connect(takeover)} /> : null}
        {toastText(view) ? (
          <Toast text={toastText(view) as string} onDismiss={() => (view.notice ? session.clearNotice() : session.clearMessage())} />
        ) : null}
      </div>
      <AssistantBar />
      {view.downloads[0] ? (
        <DownloadBox
          download={view.downloads[0]}
          onPickNative={
            isLocalBrowserHost() && controller.hasBrowserHttp
              ? (current) => controller.browser<{ supported: boolean; folder: string | null }>("POST", "/downloads/pick-folder", { folder: current })
              : undefined
          }
          onAnswer={(accept, folder, remember) =>
            session.send({
              type: "save",
              id: view.downloads[0]!.id,
              accept,
              ...(folder !== undefined ? { folder } : {}),
              ...(remember !== undefined ? { remember } : {}),
            })
          }
        />
      ) : null}
      {view.uploads[0] ? (
        <UploadBox
          upload={view.uploads[0]}
          onPickNativeFiles={
            isLocalBrowserHost() && controller.hasBrowserHttp
              ? (current, multiple) => controller.browser<{ supported: boolean; files: string[] | null }>("POST", "/uploads/pick-files", { folder: current, multiple })
              : undefined
          }
          onAnswer={(accept, files) =>
            session.send({
              type: "upload",
              id: view.uploads[0]!.id,
              accept,
              ...(files !== undefined ? { files } : {}),
            })
          }
        />
      ) : null}
    </aside>
  );
  return aside;
}

export function TabStrip(props: { tabs: PaneTab[]; active: string | null; onNew(): void; onSwitch(id: string): void; onClose(id: string): void; onHide(): void }) {
  return (
    <div role="tablist" aria-label="Browser tabs" className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-sunken/45 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {props.tabs.map((tab) => {
          const selected = tab.id === props.active;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex h-7 max-w-44 min-w-24 items-center gap-1.5 rounded-lg pr-1 pl-2.5 text-xs transition-colors",
                selected ? "bg-raised font-medium text-fg shadow-btn" : "text-muted hover:bg-hover/70 hover:text-fg",
              )}
            >
              {tab.loading ? <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" /> : null}
              <button type="button" role="tab" aria-selected={selected} title={tabLabel(tab)} onClick={() => props.onSwitch(tab.id)} className="min-w-0 flex-1 truncate text-left">
                {tabLabel(tab)}
              </button>
              <button type="button" aria-label={`Close ${tabLabel(tab)}`} onClick={() => props.onClose(tab.id)} className="rounded p-0.5 opacity-55 transition-opacity hover:bg-hover hover:opacity-100">
                <XIcon size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <Tip label="New tab">
        <IconButton label="New tab" onClick={props.onNew}>
          <PlusIcon size={14} />
        </IconButton>
      </Tip>
      <Tip label="Hide the browser" shortcut={[MOD, "Shift", "B"]}>
        <IconButton label="Hide the browser" onClick={props.onHide}>
          <XIcon size={14} />
        </IconButton>
      </Tip>
    </div>
  );
}

export function Toolbar(props: { tab: PaneTab | undefined; disabled: boolean; onBack(): void; onForward(): void; onReload(): void; onGo(text: string): void }) {
  const shown = addressOf(props.tab);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(shown);
  }, [shown, editing]);
  return (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-line bg-raised/60 px-2">
      <IconButton label="Back" disabled={props.disabled} onClick={props.onBack}>
        <ArrowLeftIcon size={14} />
      </IconButton>
      <IconButton label="Forward" disabled={props.disabled} onClick={props.onForward}>
        <ArrowRightIcon size={14} />
      </IconButton>
      <IconButton label="Reload" disabled={props.disabled} onClick={props.onReload}>
        <ArrowClockwiseIcon size={14} />
      </IconButton>
      <form
        className="min-w-0 flex-1 px-0.5"
        onSubmit={(e) => {
          e.preventDefault();
          props.onGo(text);
          setEditing(false);
        }}
      >
        <input
          aria-label="Address"
          value={text}
          disabled={props.disabled}
          placeholder="Search or enter an address"
          spellCheck={false}
          autoCapitalize="off"
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setText(shown);
              e.currentTarget.blur();
            }
          }}
          className="h-7 w-full rounded-lg border border-line bg-sunken px-2.5 text-xs text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
        />
      </form>
      <Tip label="Open in my browser">
        <IconButton label="Open in my browser" disabled={!/^https?:\/\//i.test(shown)} onClick={() => openInMyBrowser(shown)}>
          <ArrowSquareOutIcon size={14} />
        </IconButton>
      </Tip>
      {props.tab?.loading ? <div role="progressbar" aria-label="Loading" className="absolute right-0 bottom-0 left-0 h-0.5 animate-pulse bg-accent" /> : null}
    </div>
  );
}

export function Status(props: { view: SessionView; onConnect(takeover: boolean): void }) {
  const { status, message } = props.view;
  const text = status === "connecting" ? "Opening the browser…" : (message ?? "The browser is not connected.");
  const action = status === "busy" || status === "taken" ? { label: "Use it here", takeover: true } : status === "closed" ? { label: "Reconnect", takeover: false } : null;
  return (
    <div role="status" className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg/92 p-6 text-center text-sm text-muted backdrop-blur-[2px]">
      <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full border border-line bg-raised text-muted shadow-sm">
        <GlobeIcon size={20} />
      </span>
      <p className="max-w-64 leading-relaxed">{text}</p>
      {action ? (
        <button type="button" onClick={() => props.onConnect(action.takeover)} className="rounded-lg bg-raised px-3.5 py-1.5 text-xs font-medium text-fg shadow-btn transition-colors hover:bg-hover">
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function Toast(props: { text: string; onDismiss(): void }) {
  useEffect(() => {
    const timer = setTimeout(props.onDismiss, 7000);
    return () => clearTimeout(timer);
  }, [props.text, props.onDismiss]);
  return (
    <div role="alert" className="absolute right-3 bottom-3 left-3 z-20 flex items-start gap-2.5 rounded-xl border border-line-strong/80 bg-raised px-3.5 py-2.5 text-xs text-fg shadow-pop">
      <span className="min-w-0 flex-1 leading-relaxed">{props.text}</span>
      <button type="button" aria-label="Dismiss" onClick={props.onDismiss} className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg">
        <XIcon size={11} />
      </button>
    </div>
  );
}

const DIALOG_TITLE: Record<string, string> = { alert: "This page says", confirm: "This page asks", prompt: "This page asks", beforeunload: "Leave this page?" };

export function DialogBox(props: { dialog: PaneDialog; onAnswer(accept: boolean, promptText?: string): void }) {
  const { dialog } = props;
  const [value, setValue] = useState(dialog.defaultPrompt ?? "");
  const leave = dialog.kind === "beforeunload";
  return (
    <div role="alertdialog" aria-modal="true" aria-label={DIALOG_TITLE[dialog.kind] ?? "This page says"} className="absolute inset-0 z-30 flex items-center justify-center bg-bg/65 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-sm rounded-xl border border-line-strong/80 bg-raised p-4 text-sm shadow-panel">
        <h2 className="mb-1 text-xs font-semibold tracking-[0.02em] text-muted uppercase">{DIALOG_TITLE[dialog.kind] ?? "This page says"}</h2>
        <p className="mb-3 break-words whitespace-pre-wrap text-fg">{dialog.message || (leave ? "Changes you made may not be saved." : "")}</p>
        {dialog.kind === "prompt" ? (
          <input autoFocus aria-label="Answer" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && props.onAnswer(true, value)} className="mb-3 h-8 w-full rounded-lg border border-line bg-sunken px-2.5 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
        ) : null}
        <div className="flex justify-end gap-2">
          {dialog.kind !== "alert" ? (
            <button type="button" onClick={() => props.onAnswer(false)} className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium text-fg shadow-btn hover:bg-hover">
              {leave ? "Stay" : "Cancel"}
            </button>
          ) : null}
          <button type="button" autoFocus={dialog.kind !== "prompt"} onClick={() => props.onAnswer(true, dialog.kind === "prompt" ? value : undefined)} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent-hover">
            {leave ? "Leave" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectList(props: { select: { tabId: string; probe: SelectProbe }; stage: React.RefObject<HTMLDivElement | null>; page: React.RefObject<{ width: number; height: number }>; onPick(index: number): void; onClose(): void }) {
  const stageBox = props.stage.current?.getBoundingClientRect();
  const page = props.page.current;
  const rect = stageBox && page ? toScreenRect({ left: 0, top: 0, width: stageBox.width, height: stageBox.height }, page, props.select.probe.rect) : { left: 8, top: 8, width: 200, height: 24 };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props]);
  return (
    <>
      <div className="absolute inset-0 z-20" onPointerDown={(e) => { e.stopPropagation(); props.onClose(); }} />
      <ul role="listbox" aria-label="Choose an option" style={{ left: rect.left, top: rect.top + rect.height + 2, minWidth: Math.max(rect.width, 120) }} className="absolute z-30 max-h-60 overflow-y-auto rounded-md border border-line bg-raised py-1 text-xs shadow-pop">
        {props.select.probe.options.map((option) => (
          <li key={option.index} role="option" aria-selected={option.selected} aria-disabled={option.disabled}>
            <button type="button" disabled={option.disabled} onPointerDown={(e) => e.stopPropagation()} onClick={() => props.onPick(option.index)} className={cn("block w-full truncate px-3 py-1 text-left hover:bg-hover disabled:opacity-40", option.selected && "bg-active font-medium")}>
              {option.label || " "}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
