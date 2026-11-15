import { useEffect, useState, type RefObject } from "react";

/**
 * Maximum concurrent breathing animations permitted across active worker sigils (SPEC §8).
 * Ensures smooth rendering by pausing animations beyond the viewport budget limit.
 */
export const BREATH_BUDGET = 12;

type StillSubscriber = (holdStill: boolean) => void;

interface SigilRegistration {
  inView: boolean;
  permitted: boolean;
  readonly notify: StillSubscriber;
}

/**
 * Global coordinator regulating breathing animation budget across DOM elements.
 * Employs IntersectionObserver to detect visibility and pauses animations when the document is hidden.
 */
class BreathBudgetCoordinator {
  private readonly subscribers = new Map<Element, SigilRegistration>();
  private intersectionObserver: IntersectionObserver | null = null;
  private isTabHidden = false;

  public register(target: Element, onStateChange: StillSubscriber): () => void {
    this.subscribers.set(target, {
      inView: false,
      permitted: false,
      notify: onStateChange,
    });

    this.ensureObserverInitialized();
    this.intersectionObserver?.observe(target);
    this.reevaluateAllocations();

    return () => {
      this.intersectionObserver?.unobserve(target);
      this.subscribers.delete(target);
      this.reevaluateAllocations();
    };
  }

  private ensureObserverInitialized(): void {
    if (this.intersectionObserver !== null) {
      return;
    }

    if (typeof document !== "undefined") {
      this.isTabHidden = document.visibilityState === "hidden";
      document.addEventListener("visibilitychange", () => {
        this.isTabHidden = document.visibilityState === "hidden";
        this.reevaluateAllocations();
      });
    }

    if (typeof IntersectionObserver !== "undefined") {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const item = this.subscribers.get(entry.target);
          if (item) {
            item.inView = entry.isIntersecting;
          }
        }
        this.reevaluateAllocations();
      });
    }
  }

  private reevaluateAllocations(): void {
    let allocatedCount = 0;

    for (const item of this.subscribers.values()) {
      // In environments without IntersectionObserver (e.g., unit test environments), consider visible by default.
      const isVisible = this.intersectionObserver === null || item.inView;
      const canAnimate = !this.isTabHidden && isVisible && allocatedCount < BREATH_BUDGET;

      if (canAnimate) {
        allocatedCount += 1;
      }

      if (item.permitted !== canAnimate) {
        item.permitted = canAnimate;
        item.notify(!canAnimate);
      }
    }
  }
}

let activeCoordinator: BreathBudgetCoordinator | null = null;

function getCoordinator(): BreathBudgetCoordinator {
  if (activeCoordinator === null) {
    activeCoordinator = new BreathBudgetCoordinator();
  }
  return activeCoordinator;
}

/**
 * Hook to pause breathing animation for an agent sigil when:
 * 1. The element is scrolled outside the viewport,
 * 2. The document is hidden (background tab), or
 * 3. The concurrency budget (BREATH_BUDGET) is exceeded by earlier elements.
 *
 * Inactive agents (`working === false`) do not participate in budget allocation.
 */
export function useBreath(ref: RefObject<Element | null>, working: boolean): boolean {
  const [shouldHoldStill, setShouldHoldStill] = useState<boolean>(false);

  useEffect(() => {
    const targetElement = ref.current;
    if (!working || !targetElement) {
      setShouldHoldStill(false);
      return;
    }

    const coordinator = getCoordinator();
    return coordinator.register(targetElement, setShouldHoldStill);
  }, [ref, working]);

  return working && shouldHoldStill;
}
