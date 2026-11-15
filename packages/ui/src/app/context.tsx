// React context, store subscription hooks, and equality helpers for Ancilla UI
import { IconContext, type IconProps } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PackProvider, PackStore } from "../components/assistant/companion/packs.js";
import type { AncillaController } from "../model/controller.js";
import type { AppState } from "../model/store.js";
import type { AvatarPackView } from "../types.js";
const ControllerContext = createContext<AncillaController | null>(null);
const ICON_DEFAULTS: IconProps = { weight: "bold", size: 24 };
export function ControllerProvider(props: { controller: AncillaController; children: ReactNode }) {
  // The avatars the user drew or brought are fetched by id as the faces ask for them, and held here for the whole app.
  const packs = useMemo(() => new PackStore({ get: (id) => props.controller.assistant<{ avatar: AvatarPackView }>("GET", `/avatars/${encodeURIComponent(id)}`).then((out) => out.avatar) }), [props.controller]);
  return (
    <ControllerContext.Provider value={props.controller} key="ancilla-controller-root">
      <PackProvider store={packs}>
        <IconContext.Provider value={ICON_DEFAULTS}>
          {props.children}
        </IconContext.Provider>
      </PackProvider>
    </ControllerContext.Provider>
  );
}
export function useController(): AncillaController {
  const instance = useContext(ControllerContext);
  if (instance == null) {
    throw new Error("Ancilla: useController outside of <ControllerProvider>.");
  }
  return instance;
}
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) {
    return false;
  }
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  for (const propKey of keysA) {
    if (!Object.prototype.hasOwnProperty.call(recordB, propKey)) {
      return false;
    }
    if (!Object.is(recordA[propKey], recordB[propKey])) {
      return false;
    }
  }
  return true;
}
export function useApp<T>(selector: (state: AppState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const { store } = useController();
  const activeSelectorRef = useRef<(state: AppState) => T>(selector);
  const activeEqualRef = useRef<(a: T, b: T) => boolean>(equal);
  activeSelectorRef.current = selector;
  activeEqualRef.current = equal;
  type StateSnapshotCache = { state: AppState; selector: (state: AppState) => T; value: T };
  const cacheRef = useRef<StateSnapshotCache | null>(null);
  const readSnapshot = (): T => {
    const currentState = store.get();
    const cached = cacheRef.current;
    if (cached && cached.state === currentState && cached.selector === activeSelectorRef.current) {
      return cached.value;
    }
    const nextValue = activeSelectorRef.current(currentState);
    if (cached && activeEqualRef.current(cached.value, nextValue)) {
      cacheRef.current = { state: currentState, selector: activeSelectorRef.current, value: cached.value };
      return cached.value;
    }
    cacheRef.current = { state: currentState, selector: activeSelectorRef.current, value: nextValue };
    return nextValue;
  };
  return useSyncExternalStore(store.subscribe, readSnapshot, readSnapshot);
}
export function useNow(intervalMs: number, active: boolean = true): number {
  const [currentTime, setCurrentTime] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setCurrentTime(Date.now());
    const intervalHandle = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(intervalHandle);
    };
  }, [intervalMs, active]);
  return currentTime;
}
