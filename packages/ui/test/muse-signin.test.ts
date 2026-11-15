import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { Onboarding } from "../src/components/home/Home.js";
import { MuseSubscriptionCard, SignInDone, signInDoneNote } from "../src/components/settings/MuseSignIn.js";
import { LinuxSetupCard } from "../src/components/settings/LinuxSetup.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { defaultPrefs, initialState, Store, type AppState } from "../src/model/store.js";
import type { LinuxSetupView } from "../src/types.js";

function render(Component: ComponentType, patch: Partial<AppState>): string {
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-28T00:00:00Z")), ...patch });
  const controller = { store } as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children:
    createElement(TooltipProvider, { children: createElement(Component) }),
  }));
}

describe("Muse subscription setup", () => {
  it("offers the default subscription directly without requiring an account profile or API key", () => {
    const html = render(MuseSubscriptionCard, { defaultLogin: { hasLogin: false, email: null } });
    assert.match(html, /Sign in with Meta/);
    assert.match(html, /No API key or extra Ancilla subscription is needed/);
    assert.doesNotMatch(html, /Account id|Add account/);
  });

  it("reuses a detected default login while leaving reauthentication available", () => {
    const html = render(MuseSubscriptionCard, { defaultLogin: { hasLogin: true, email: "person@example.test" } });
    assert.match(html, /Signed in as person@example.test/);
    assert.match(html, /Sign in again/);
    assert.doesNotMatch(html, /subscription verified/i);
  });

  it("explains unknown credential stores without claiming the user is signed out", () => {
    const html = render(MuseSubscriptionCard, { defaultLogin: { hasLogin: null, email: null } });
    assert.match(html, /Already signed in through Muse\? Ancilla reuses that login; some credential stores cannot report it here\./);
    assert.match(html, /Sign in with Meta/);
    assert.doesNotMatch(html, /Signed in as|Sign in again|not signed in|signed out/i);
  });

  it("shows the account once the server can see the login, and then drops the line about unknown stores", () => {
    const named = render(MuseSubscriptionCard, { defaultLogin: { hasLogin: true, email: "person@example.test" } });
    assert.match(named, /Signed in as person@example\.test\./);
    assert.match(named, /Sign in again/);
    assert.doesNotMatch(named, /Sign in with Meta|Already signed in through Muse|cannot report it here/);
    const nameless = render(MuseSubscriptionCard, { defaultLogin: { hasLogin: true, email: null } });
    assert.match(nameless, /Muse has a saved login\./);
    assert.match(nameless, /Sign in again/);
    assert.doesNotMatch(nameless, /Signed in as|Already signed in through Muse/);
  });

  it("tells a finished sign-in that a new usage window can start with no numbers", () => {
    const note = signInDoneNote(null, "Default login");
    assert.match(note, /Ancilla will use your default Muse login\./);
    assert.match(note, /Reported subscription limits appear in Usage after Muse receives a quota reading\./);
    assert.match(note, /In a new usage window, Meta can send no numbers until you send your first message\./);
    assert.match(signInDoneNote("work", "Work"), /^Choose Work beside the model picker when starting a new thread\./);
    assert.match(signInDoneNote("work", "Work"), /In a new usage window/);
  });

  it("shows that sentence where the finished sign-in dialog shows it", () => {
    const html = render(() => createElement(SignInDone, { accountId: null, name: "Default login" }), {});
    assert.match(html, /Muse confirmed your browser sign-in\./);
    assert.match(html, /Ancilla will use your default Muse login\./);
    assert.match(html, /In a new usage window, Meta can send no numbers until you send your first message\./);
    assert.match(html, /Continue/);
    const named = render(() => createElement(SignInDone, { accountId: "work", name: "Work" }), {});
    assert.match(named, /Choose Work beside the model picker/);
    assert.match(named, /In a new usage window/);
  });

  it("explains why an environment API key bypasses subscription sign-in", () => {
    const html = render(MuseSubscriptionCard, { metaApiKeyInherited: true });
    assert.match(html, /META_API_KEY/);
    assert.match(html, /overriding browser sign-in/);
    assert.match(html, /then restart Ancilla/);
    assert.match(html, /pay-as-you-go billing/);
  });

  for (const platform of ["darwin"]) {
    it(`provides a complete installation step on ${platform}`, () => {
      const html = render(Onboarding, { env: { platform, runtime: "posix", wslAvailable: false, defaultDistro: null, museFound: false, musePath: null, version: "0.20.1", persistent: true } });
      assert.match(html, /Open Terminal/);
      assert.match(html, /curl -fsSL https:\/\/dev.meta.ai\/install.sh \| bash/);
      assert.match(html, /Check installation/);
      assert.match(html, /Sign in with Meta/);
    });
  }

  it("offers guided Linux installation without requiring a terminal", () => {
    const html = render(Onboarding, { env: linuxEnvironment(false), linuxSetup: linuxSetup(false) });
    assert.match(html, /Install Muse Code/);
    assert.match(html, /Ancilla downloads Muse from Meta/);
    assert.match(html, /Next: Sign in with Meta/);
    assert.doesNotMatch(html, /Open Terminal|curl -fsSL|close and reopen Ancilla/);
  });

  it("shows browser approval, code and cancellation during installation without claiming completion", () => {
    const setup = linuxSetup(false);
    setup.installation = { status: "installing", phase: "signin", message: "Waiting for Meta approval", attemptId: "attempt-1", loginUrl: "https://www.meta.ai/device?code=ABCD", loginCode: "ABCD" };
    const html = render(Onboarding, { env: linuxEnvironment(false), linuxSetup: setup });
    assert.match(html, /Waiting for Meta approval/);
    assert.match(html, /Open Meta sign-in/);
    assert.match(html, /ABCD/);
    assert.match(html, /Cancel installation/);
    assert.match(html, /Installation continues automatically/);
    assert.doesNotMatch(html, /Muse Code is installed|Signed in as|Muse sign-in confirmed/);
  });

  it("offers retry after a failed or cancelled installation", () => {
    for (const status of ["error", "cancelled"] as const) {
      const setup = linuxSetup(false);
      setup.installation = { ...setup.installation, status, message: "Download interrupted" };
      const html = render(Onboarding, { env: linuxEnvironment(false), linuxSetup: setup });
      assert.match(html, /Download interrupted/);
      assert.match(html, /Try installation again/);
    }
  });

  it("shows the exact storage path and offers only a safe repair action", () => {
    const setup = linuxSetup(true);
    setup.storage = { status: "repairable", path: "/home/person/.local/share/muse", message: "The Muse folder allows other users to write. Ancilla can make it private." };
    const html = render(LinuxSetupCard, { env: linuxEnvironment(true), linuxSetup: setup });
    assert.match(html, /Fix folder permissions/);
    assert.match(html, /\/home\/person\/\.local\/share\/muse/);
    setup.storage = { ...setup.storage, status: "blocked", message: "This folder belongs to another account. Ask its owner to restore access." };
    const blocked = render(LinuxSetupCard, { env: linuxEnvironment(true), linuxSetup: setup });
    assert.match(blocked, /belongs to another account/);
    assert.doesNotMatch(blocked, /Fix folder permissions|chmod|sudo/);
  });

  it("provides desktop integration for an existing AppImage and explains the desktop permission", () => {
    const state: Partial<AppState> = { env: linuxEnvironment(true), linuxSetup: linuxSetup(true), linuxDesktop: {
      kind: "appimage", menuInstalled: false, desktopShortcutInstalled: false, desktopShortcutSupported: true, canInstall: true, restartRequired: false, installedPath: null,
    } };
    const html = render(LinuxSetupCard, state);
    assert.match(html, /Install Ancilla for my account/);
    assert.match(html, /Also add a desktop shortcut/);
    assert.match(html, /No administrator password is needed/);
    const installed = render(LinuxSetupCard, { ...state, linuxDesktop: { ...state.linuxDesktop!, menuInstalled: true, desktopShortcutInstalled: true, restartRequired: true } });
    assert.match(installed, /Relaunch installed Ancilla/);
    assert.match(installed, /Allow Launching/);
    assert.doesNotMatch(installed, /Install Ancilla for my account/);
  });

  it("explains package updates without pretending an AppImage updater is available", () => {
    const html = render(LinuxSetupCard, { env: linuxEnvironment(true), linuxSetup: linuxSetup(true), linuxDesktop: {
      kind: "package", menuInstalled: true, desktopShortcutInstalled: false, desktopShortcutSupported: true, canInstall: true, restartRequired: false, installedPath: "/usr/bin/ancilla",
    } });
    assert.match(html, /Add desktop shortcut/);
    assert.match(html, /download the latest Linux installer/);
    assert.doesNotMatch(html, /Install Ancilla for my account|automatically update/);
  });

  it("uses PowerShell for native Windows and the selected Linux distro for WSL", () => {
    const env = { platform: "win32", wslAvailable: true, defaultDistro: "Ubuntu-24.04", museFound: false, musePath: null, version: "0.20.1", persistent: true };
    const native = render(Onboarding, { env: { ...env, runtime: "native" } });
    assert.match(native, /Open PowerShell from the Start menu/);
    assert.match(native, /install.ps1/);
    assert.doesNotMatch(native, /install.sh/);
    const wsl = render(Onboarding, { env: { ...env, runtime: "wsl" } });
    assert.match(wsl, /Open Ubuntu-24.04 from the Start menu/);
    assert.match(wsl, /install.sh/);
    assert.doesNotMatch(wsl, /install.ps1/);
  });

  it("does not suggest a native install when the configured WSL runtime is missing", () => {
    const html = render(Onboarding, { env: { platform: "win32", runtime: "wsl", wslAvailable: false, defaultDistro: null, museFound: false, musePath: null, version: "0.20.1", persistent: true } });
    assert.match(html, /wsl --install/);
    assert.match(html, /configured to run Muse in WSL/);
    assert.doesNotMatch(html, /install.ps1/);
  });
});

function linuxEnvironment(museFound: boolean) {
  return { platform: "linux", runtime: "posix" as const, wslAvailable: false, defaultDistro: null, museFound, musePath: museFound ? "/home/person/.local/bin/muse" : null, version: "0.20.3", persistent: true };
}

function linuxSetup(museFound: boolean): LinuxSetupView {
  return {
    supported: true, museFound,
    installation: { status: museFound ? "installed" : "idle", phase: "idle", message: "Ready", attemptId: null, loginUrl: null, loginCode: null },
    storage: { status: "ready", path: "/home/person/.local/share/muse", message: "Muse storage is private and writable." },
  };
}
