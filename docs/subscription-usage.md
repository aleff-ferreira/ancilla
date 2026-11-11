# Subscription usage

Usage separates Muse Code subscription allowance from local token history and API-rate cost estimates. Local tokens
cannot establish a subscription percentage: Meta owns the allowance and its accounting rules.

## Sources

| Source | What Ancilla reads | Freshness |
| --- | --- | --- |
| Muse CLI (`muse usage --json`) | The official CLI allowance snapshot (`allowance`, `reason`, `hint`) | Checked when Usage opens or Refresh is selected; while Ancilla is visible it re-reads in the background, once a minute on the Usage page and every five minutes elsewhere (after a failed read, every minute until one succeeds) |
| Muse runtime | MSP `usage/read` and `usage/changed` | The host's last observation, not a request for fresh account limits |
| Saved reading | A previous observation scoped to the same login and runtime | Keeps its original observation time |

The CLI reader checks locally that `auth.json` holds an inline `oauth` device login (so Keychain-only or API-key configurations never trigger OS credential prompts) without extracting or transmitting `access_token`, and invokes `muse usage --json` directly via the configured Muse CLI (`MUSE_AUTH_PATH` natively for the default login, isolated XDG roots for named Aonia profiles, and `wsl -d <distro> -e <musePath> usage --json` for the default login under WSL). For Muse running in WSL on Windows, login identity is verified from the distro's own `auth.json` through the `\\wsl.localhost\` share: the absolute `MUSE_AUTH_PATH` or else `XDG_CONFIG_HOME` that `runtime.json`'s `wslEnv` gives Muse, else `.config/muse/auth.json` under the distro user's home folder (asked of the distro once it answers, and remembered). Never the login on the Windows side. `muse usage --json` performs no model turn and spawns no persistent `muse serve` host. Credentials never enter the browser, CLI argv, local quota database, or error messages, and Ancilla never rewrites the CLI's login file.

Requests share a short 15-second cache per login fingerprint, concurrent requests are combined, and rate-limited CLI responses delay retries. Changing or removing a login invalidates an in-flight read. A runtime observation newer than a CLI invocation wins; a slow CLI exit does not artificially make its older data newer.

## Meaning of the numbers

- The five-hour class window uses Meta's reported duration; a missing duration is not guessed.
- Percentages above 100 are retained. Only the drawn progress bar is capped at 100.
- MSP and `muse usage --json` reset stamps are epoch milliseconds.
- The last report is kept for as long as the login stays the same, however old: in memory and, once Ancilla can
  verify the login's identity, in the local database, so it survives a restart with its original age. It is never
  dropped for being old and never passes for the current allowance. Only a reading under 30 minutes old, of a window
  whose reset time has not passed, that is not a saved one from an earlier run and that the latest check did not
  contradict (Meta unavailable, no usage numbers sent, a refused login), is drawn as a live meter.
- Every other report is shown as the last report. A limit whose window is still open says "Last report", with a muted
  bar and the time left to its reset; usage may be higher now. A limit whose reset time has passed says that the window
  ended (or that the week reset) and shows what was last reported before that, without a bar: a passed reset does not
  prove that the next window is unused, and Meta sends nothing for a window that has not started.
- A note under the limits says what the report is (its age), why nothing newer exists (Meta sends usage numbers only
  while a 5-hour window is running, and a window starts with the first message) and how to get a current one: send a
  message in a thread that uses the account, then choose Refresh, or open Meta's usage page
  (`https://dev.meta.ai/usage`, which Meta's documentation calls the Usage dashboard), which always shows the current
  figures. For an account only the Muse runtime reports (a named account under WSL, a Keychain-only login, a login that
  lost its token, a report from a server that predates direct checks) Refresh cannot produce newer data, so the note
  says that Muse reports again when it next sends usage and that Refresh cannot update it. It does not name a trigger,
  because the protocol allows several.
- The sidebar pill follows the binding limit: the highest percentage among the limits that are current, marked as the
  weekly one when that is the one binding. When no limit is current it keeps the last report instead, muted and marked
  with its age (a window that is still open before one that has ended, the highest percentage, the short window on a
  tie), so it shows a dash only when there has never been a report. A last report never binds a limit: the "switch
  accounts" hint on the new-thread screen compares accounts by the current figures only.
- Reset countdowns count whole minutes below an hour and never show seconds, because the clock ticks once a minute.
  The pill tooltip and the Usage page describe a reading's age in the same short form, such as `28h` or `36d`.
- An `allowance: null` response with `reason: "server_sent_no_usage"` is not a zero. Meta can omit usage while the short window is idle, even if weekly usage exists, and before the first use in a new usage window. That is Meta's reply, not a fault in Ancilla: `muse usage --json` reports `allowance: null` with the reason `server_sent_no_usage`. The panel keeps any reported plan name and says that Meta confirms the plan but has sent no usage numbers yet; sending a message in a thread that uses that account and then choosing Refresh checks again; if no numbers appear after that, Meta has not sent any for the account. When a last report is kept, the line says that Meta is not sending numbers right now. Without a plan name it keeps the plainer line that Meta did not report limits. Either way a missing value is unknown, never zero usage.
- Account selection is explicit. Readings from a different account cannot take over the selected meter.

## Plan name and source labels

`accounts[].planName` is populated only when the CLI output includes a plan label (`tierName`); when `muse usage --json` omits a human-readable tier name (returning only the opaque `allowance.tier` identifier), `planName` is `null` and the UI displays the generic account label cleanly. It is also `null` wherever a CLI usage check does not run: for named accounts under WSL, for the default login under WSL when an API key is set (here or in `wslEnv`) or `MUSE_AUTH_PATH` is set in the server's own environment, for Keychain-only logins, with `META_API_KEY`, and for named accounts while `MUSE_AUTH_PATH` is set. Nothing else supplies it, and `usage.tier` is an opaque id, not a display name.

- When Meta does not answer with a plan, the account keeps the name it last gave, so the badge does not flicker. That
  covers a failed direct check (a timeout, a server error, a rate limit), a login Meta rejected (`login-required`), and
  a login that is still the same person's but no longer holds a token in `auth.json` (the Keychain-only shape, so there
  is nothing to check with).
- The name is cleared when the account's login or runtime scope changes (another person's login, or a login file that
  cannot be read at all, has no identity to match), when Meta reports no active subscription, and when the account is
  removed. It lives in memory only: after a restart it is empty until the next successful check.
- `accounts[].source` records where the current reading was observed: `meta` for the direct read, `runtime` for host
  frames and `usage/read`, `saved` for a restored row. It is recorded at observation, not worked out later, so a Meta
  reading stays `meta` after a failed check; the failed check shows in `status` (`unavailable`), not in `source`. If
  Meta and the runtime report the very same observation, it is labelled `meta`. A login that lost its token keeps its
  last Meta reading and the `meta` label too, with status `runtime-only` and no check time: nothing can be checked, so
  the panel says the allowance may have changed.

## Observation times

Readings are ordered by observation time. Meta readings carry this server's clock; runtime frames carry the host's, so
a clock that jumped ahead could stamp a frame in the future and outrank every later reading, in memory and in the saved
row, until real time caught up. A stamp more than five minutes ahead of the server's clock is therefore not believed: it
counts as the moment it first arrived. Reading the same observation again keeps that moment, so a runtime that goes
quiet still goes stale after 30 minutes. A saved row did not arrive just now, and nothing says when it was observed, so
one with such a stamp is restored as a reading half an hour old: it never looks fresh and never outranks a reading Muse
makes after the restart. The row is rewritten with that stamp, and the store lets an honest stamp replace a row that
holds a future one. A few minutes of ordinary clock skew is left alone.

## Fallbacks

Keychain-only credentials, and named accounts under WSL, stay with Muse and use labelled runtime observations. Ancilla
does not read browser cookies or trigger Keychain prompts to fill a missing quota. The default login under WSL is the
distro's file (see above) and nothing else: a login on the Windows side is never used for Muse in WSL. The server
takes what Muse there was told from `runtime.json`'s `wslEnv` alone, so a variable that the user's own `WSLENV`
forwards from Windows is not seen. A login file or home folder that is a symbolic link cannot be opened through the
`\\wsl.localhost\` share, so such a login also stays with runtime observations. A stopped or slow distro is bounded:
five seconds to name the home folder (a failure is not retried for thirty seconds, except when a thread starts, which
asks again at once), six seconds for each look at the login, and once a look has run past that, later looks wait for
it to answer. The first poll on a distro that never answers can therefore take about twelve seconds, and the next ones
almost none. Settings shows the signed-in account under WSL from the same file, through `GET /api/accounts/health`
(`defaultLogin`): it says a login exists when the meta provider has a mechanism, and names its e-mail when it has one
(trimmed, and left out when it is longer than 320 characters or holds control or line-break characters).
Only the e-mail leaves the server, never the token, the path or the person's name. Where the file is missing, unreadable
or shows no login, or the distro does not answer in time, Settings does not say the user is signed out, since another
credential store could hold the login: it keeps the line that some credential stores cannot report it. The same
conditions as for the meter apply (an API key or a `MUSE_AUTH_PATH` in the server's environment leaves it unknown), and
this look has its own bound and its own hold, so a stalled distro cannot hold the page. `muse usage --json` reporting a rejected or missing login (`credential_rejected` or `not logged in`) is surfaced as `login-required`. An inherited `META_API_KEY` overrides subscription sign-in, so that process
does not query the browser login's allowance. A global `MUSE_AUTH_PATH` override also prevents assigning that credential
to every named profile. Readings with no verified login identity are never saved, so they do not survive a restart.

Rejected logins, timeouts, unavailable CLI responses and malformed payloads never produce a fabricated allowance.
The panel distinguishes these from an inactive subscription and a subscription whose current quota was omitted.
CLI output schemas are owned by Muse; parsing failures fall back to clearly labelled runtime observations.

## Implementation

- `packages/server/src/subscriptionQuota.ts`: bounded auth-metadata checks (without extracting tokens), `muse usage --json` CLI execution and output projection, login-scoped cache, timeout and rate-limit cooldown handling.
- `packages/server/src/wslLogin.ts`: where the distro's login file is, its Windows path, and the bounds on asking.
- `packages/server/src/server.ts`: account isolation, CLI runner wiring, runtime observations, saved readings and `/api/plan-usage`.
- `packages/ui/src/model/plan.ts` and `components/usage/PlanMeter.tsx`: account selection, freshness and presentation.

The Muse schema exported by `muse schema generate-ts` specifies that `usage/read` is last-observed data and `usage/changed` may omit timestamp-only refreshes, while `muse usage --json` refreshes subscription allowance without starting a model turn. Regression tests use injected CLI runners and temporary login files.

## Other AI subscriptions and endpoints

Alongside Muse Code, `/api/plan-usage` (`providerQuotas[]`) and the **Other AI subscriptions & endpoints** section on the Usage page report honest, non-fabricated allowance information for every configured non-Muse provider:

| Provider | Quota mode (`quotaSupport`) | What Ancilla reports |
| --- | --- | --- |
| **OpenAI Codex** (`codex app-server`) | `windows` | Live 5-hour and weekly used/remaining percentages and plan tier emitted by Codex's own `account/rateLimits/read` and `account/rateLimits/updated` JSON-RPC messages, plus a link to `https://chatgpt.com/codex/settings/usage`. Before the first Codex session emits rate-limit windows, Ancilla states that no live window has been observed yet rather than guessing `0%`. |
| **Anthropic Claude Code** (`claude`), **Google Gemini CLI** (`gemini`), **GitHub Copilot CLI** (`copilot`), **Kimi**, **Qwen**, **OpenCode**, **Custom ACP** | `tier-only` | Any subscription tier reported by the official CLI (such as `claude auth status --json`) and a direct link to the vendor's official usage dashboard. Because these CLIs do not expose numeric remaining percentages over `stdio`, Ancilla never scrapes browser cookies or private web endpoints and never fabricates percentage bars. |
| **Direct API & Local servers** (`api`) | `ledger-only` | Token totals and list-price estimates in the **Thread activity** ledger below (`session_usage_calls` tagged by `provider_id`), kept strictly separate from flat-rate subscription meters. |

### Ambient API-key protection

When a user has pay-as-you-go environment variables set in their shell (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `MOONSHOT_API_KEY`, `DASHSCOPE_API_KEY`), official CLIs can silently switch from a flat-rate subscription login to per-token API billing. Ancilla detects those inherited variables, warns in **Settings → AI subscriptions**, and strips them from the child environment of subscription CLI profiles by default (`stripAmbientKeys: true`).
