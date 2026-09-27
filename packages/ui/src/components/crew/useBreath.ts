import { useEffect, useState, type RefObject } from "react";

/** How many working sigils may breathe at once (SPEC §8); the rest hold still until one of them leaves the viewport. */
export const BREATH_BUDGET = 12;

interface Entry {
  visible: boolean;
  allowed: boolean;
  set: (still: boolean) => void;
}

/**
 * The gate every working sigil registers with: an IntersectionObserver tells it which are in view, and the first
 * twelve of those breathe. A hidden tab holds every one still, since nobody is watching.
 */
class BreathGate {
  private readonly entries = new Map<Element, Entry>();
  private observer: IntersectionObserver | null = null;
  private hidden = false;

  register(element: Element, set: (still: boolean) => void): () => void {
    this.entries.set(element, { visible: false, allowed: false, set });
    this.observer ??= this.observe();
    this.observer?.observe(element);
    this.recompute();
    return () => {
      this.observer?.unobserve(element);
      this.entries.delete(element);
      this.recompute();
    };
  }

  private observe(): IntersectionObserver | null {
    if (typeof IntersectionObserver === "undefined") return null;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        this.hidden = document.visibilityState === "hidden";
        this.recompute();
      });
    }
    return new IntersectionObserver((records) => {
      for (const record of records) {
        const entry = this.entries.get(record.target);
        if (entry) entry.visible = record.isIntersecting;
      }
      this.recompute();
    });
  }

  private recompute(): void {
    let breathing = 0;
    for (const entry of this.entries.values()) {
      // Without an observer (an old browser, a test) everything counts as visible.
      const visible = this.observer === null || entry.visible;
      const allowed = !this.hidden && visible && breathing < BREATH_BUDGET;
      if (allowed) breathing += 1;
      if (allowed !== entry.allowed) {
        entry.allowed = allowed;
        entry.set(!allowed);
      }
    }
  }
}

let gate: BreathGate | null = null;

/**
 * Whether a working sigil should hold still: it is out of view, past the breathing budget, or the tab is hidden.
 * Sigils that are not working never register and never breathe, so `working: false` costs nothing.
 */
export function useBreath(ref: RefObject<Element | null>, working: boolean): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!working || !element) {
      setStill(false);
      return;
    }
    gate ??= new BreathGate();
    return gate.register(element, setStill);
  }, [ref, working]);
  return working && still;
}
