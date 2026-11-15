// Ancilla Notification Subsystem Bridge
// Handles permission queries, user approval prompts, and desktop/browser delivery
import {
  isPermissionGranted as checkTauriNotificationPermission,
  requestPermission as askTauriNotificationPermission,
  sendNotification as deliverTauriNotification,
} from "@tauri-apps/plugin-notification";
import type { Notifier, NotifyPermission } from "@ancilla/ui";
function parsePermissionStatus(rawStatus: string): NotifyPermission {
  if (rawStatus === "granted" || rawStatus === "denied") {
    return rawStatus;
  }
  return "default";
}
// Web browser notification provider using standard W3C Web Notifications API
function createBrowserNotificationProvider(): Notifier | undefined {
  const notificationApiPresent = typeof window !== "undefined" && "Notification" in window;
  if (!notificationApiPresent) {
    return undefined;
  }
  const queryCurrentStatus = (): NotifyPermission => parsePermissionStatus(Notification.permission);
  const browserNotifierAdapter: Notifier = {
    permission: async () => queryCurrentStatus(),
    // Prompt user for notification authorization
    async request(): Promise<NotifyPermission> {
      const current = queryCurrentStatus();
      if (current !== "default") {
        return current;
      }
      try {
        const result = await Notification.requestPermission();
        return parsePermissionStatus(result);
      } catch (_err) {
        return "denied";
      }
    },
    // Display notification banner
    async show({ title, body, tag, onClick }) {
      const banner = new Notification(title, { body, tag });
      if (onClick) {
        banner.onclick = () => {
          window.focus();
          banner.close();
          onClick();
        };
      }
    },
  };
  // Return browser notifier instance
  return browserNotifierAdapter;
}
// Desktop notification provider dispatching OS alerts through Tauri plugin
function createDesktopNotificationProvider(): Notifier {
  const desktopNotifierAdapter: Notifier = {
    async permission(): Promise<NotifyPermission> {
      try {
        const isGranted = await checkTauriNotificationPermission();
        return isGranted ? "granted" : "default";
      } catch (_err) {
        return "denied";
      }
    },
    // Request desktop permission
    async request(): Promise<NotifyPermission> {
      try {
        const outcome = await askTauriNotificationPermission();
        return parsePermissionStatus(outcome);
      } catch (_err) {
        return "denied";
      }
    },
    // Post desktop notification
    async show({ title, body }: { title: string; body?: string }) {
      deliverTauriNotification({ title, body });
    },
  };
  // Return adapter instance
  return desktopNotifierAdapter;
}
// Unified application notification dispatcher
export function appNotifier(): Notifier | undefined {
  const hasTauriInternals = Boolean("__TAURI_INTERNALS__" in window);
  if (hasTauriInternals) {
    return createDesktopNotificationProvider();
  }
  return createBrowserNotificationProvider();
}
