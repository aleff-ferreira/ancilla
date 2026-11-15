// Ancilla Web Client - Daemon Connection Setup Modal
// Handles remote endpoint specification, authentication verification, and storage
import { useState, type FormEvent, type ReactElement } from "react";
import { currentDaemon, setDaemon } from "./webClient.js";
// Normalizes user-entered server URL into a valid protocol + host origin.
// Returns empty string if blank, or null if malformed.
function normalizeServerOrigin(userInput: string): string | null {
  const cleaned = userInput.trim().replace(/\/+$/, "");
  if (!cleaned) {
    return "";
  }
  try {
    const parsed = new URL(cleaned);
    const resolvedOrigin = `${parsed.protocol}//${parsed.host}`;
    return resolvedOrigin;
  } catch (_err) {
    return null;
  }
}
// Connect modal dialog: configures remote Ancilla daemon endpoint URL and validates access token.
export function Connect({ onDone }: { onDone: () => void }): ReactElement {
  const activeEndpoint = currentDaemon();
  const [targetAddress, setTargetAddress] = useState<string>(activeEndpoint.base);
  const [authToken, setAuthToken] = useState<string>(activeEndpoint.token ?? "");
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Form submission and daemon auth verification handler
  const handleSubmit = async (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    // Normalize address URL
    const normalizedUrl = normalizeServerOrigin(targetAddress);
    if (normalizedUrl === null) {
      setErrorMessage("Please enter a valid daemon URL (for example: https://box.example:3127).");
      return;
    }
    // Set loading indicator
    setIsVerifying(true);
    setErrorMessage(null);
    // Strip excess token whitespace
    const trimmedSecret = authToken.trim() || null;
    try {
      const authEndpoint = `${normalizedUrl}/api/auth`;
      const verificationResponse = await fetch(authEndpoint, {
        method: "POST" as const,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: trimmedSecret }),
        credentials: "include" as const,
      });
      // Check for authentication rejection
      if (verificationResponse.status === 401) {
        setErrorMessage("Authentication failed: daemon rejected the provided token.");
        return;
      }
      if (!verificationResponse.ok) {
        setErrorMessage(`Daemon returned HTTP error status ${verificationResponse.status}.`);
        return;
      }
      // Store verified daemon endpoint settings
      setDaemon({
        base: normalizedUrl,
        token: trimmedSecret,
      });
      // Notify caller of connection setup completion
      onDone();
    } catch (_networkError) {
      const isMixedContent = normalizedUrl.startsWith("http://") && window.location.protocol === "https:";
      if (isMixedContent) {
        setErrorMessage("HTTPS pages cannot connect to insecure HTTP endpoints. Please enable TLS on the daemon.");
      } else {
        setErrorMessage("Could not reach daemon. Verify the network address and ensure --allow-origin includes this origin.");
      }
    } finally {
      setIsVerifying(false);
    }
  };
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col justify-center px-6" role="main">
      <h1 className="text-lg font-semibold text-fg">{"Connect to a daemon"}</h1>
      <p className="mt-1 text-xs text-pretty text-muted" id="daemon-connect-desc">
        Leave the address empty to use the server that served this page. A daemon elsewhere has to be started with{" "}
        <code className="mx-1 rounded bg-sunken px-1 py-0.5 font-mono text-2xs">--allow-origin {window.location.origin}</code>{" "}
        {"and, unless it is on this machine, reached over HTTPS."}
      </p>
      <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
        <label className="flex flex-col gap-1" htmlFor="daemon-address-input">
          <span className="text-sm text-fg">{"Address"}</span>
          <input
            id="daemon-address-input"
            autoFocus={true}
            autoComplete="url"
            value={targetAddress}
            onChange={(e) => setTargetAddress(e.target.value)}
            placeholder={"https://box.example:3127"}
            className="h-9 rounded-lg bg-sunken px-3 text-sm text-fg shadow-[0_0_0_1px_var(--border-strong)] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus-ring)]"
          />
        </label>
        <label className="flex flex-col gap-1" htmlFor="daemon-token-input">
          <span className="text-sm text-fg">{"Token"}</span>
          <input
            id="daemon-token-input"
            type={"password"}
            autoComplete="current-password"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder={"Only if the daemon was started with --token"}
            className="h-9 rounded-lg bg-sunken px-3 text-sm text-fg shadow-[0_0_0_1px_var(--border-strong)] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus-ring)]"
          />
        </label>
        {errorMessage ? (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-pretty text-danger-text">
            {errorMessage}
          </p>
        ) : null}
        <button
          type={"submit"}
          aria-label="Connect to daemon"
          disabled={isVerifying}
          aria-busy={isVerifying}
          className="mt-1 h-9 rounded-lg bg-brand text-sm font-medium text-brand-fg transition-colors duration-100 hover:bg-brand-hover disabled:opacity-60"
        >{isVerifying ? "Verifying..." : "Connect"}</button>
      </form>
    </main>
  );
}
