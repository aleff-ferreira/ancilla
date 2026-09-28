import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { Onboarding } from "../src/components/home/Home.js";
import { MuseSubscriptionCard } from "../src/components/settings/MuseSignIn.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { defaultPrefs, initialState, Store, type AppState } from "../src/model/store.js";

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
    assert.match(html, /some credential stores cannot report it here/);
    assert.doesNotMatch(html, /not signed in|signed out/i);
  });

  it("explains why an environment API key bypasses subscription sign-in", () => {
    const html = render(MuseSubscriptionCard, { metaApiKeyInherited: true });
    assert.match(html, /META_API_KEY/);
    assert.match(html, /overriding browser sign-in/);
    assert.match(html, /then restart Ancilla/);
    assert.match(html, /pay-as-you-go billing/);
  });

  for (const platform of ["linux", "darwin"]) {
    it(`provides a complete installation step on ${platform}`, () => {
      const html = render(Onboarding, { env: { platform, runtime: "posix", wslAvailable: false, defaultDistro: null, museFound: false, musePath: null, version: "0.20.1", persistent: true } });
      assert.match(html, /Open Terminal/);
      assert.match(html, /curl -fsSL https:\/\/dev.meta.ai\/install.sh \| bash/);
      assert.match(html, /Check installation/);
      assert.match(html, /Sign in with Meta/);
    });
  }

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
