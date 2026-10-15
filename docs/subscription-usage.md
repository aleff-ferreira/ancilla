# Subscription usage

Usage separates Muse Code subscription allowance from local token history and API-rate cost estimates. Local tokens
cannot establish a subscription percentage: Meta owns the allowance and its accounting rules.

## Sources

| Source | What Ancilla reads | Freshness |
| --- | --- | --- |
| Meta | The subscription snapshot returned by Muse's device-login exchange | Fetched when Usage opens or Refresh is selected; while Ancilla is visible it re-reads in the background, once a minute on the Usage page and every five minutes elsewhere (after a failed read, every minute until one succeeds) |
| Muse runtime | MSP `usage/read` and `usage/changed` | The host's last observation, not a request for fresh account limits |
| Saved reading | A previous observation scoped to the same login and runtime | Keeps its original observation time |

The direct reader uses the CLI's `oauth` device credential from `auth.json` and sends it only to
`https://api.meta.ai/muse-code/key`, with redirects disabled. It reads the default login's `MUSE_AUTH_PATH` override
or XDG config root, and each named account's isolated config root. It does not start a Muse session or model turn.
Returned inference keys and payment details are discarded. Credentials never enter the browser, local quota database,
or error messages, and the reader never rewrites the CLI's login file.

Requests share a short 15-second cache per credential, concurrent requests are combined, and rate-limit responses
delay retries. Changing or removing a login invalidates an in-flight response. A runtime observation newer than an
HTTP request wins; the HTTP response's arrival does not artificially make its older data newer.

## Meaning of the numbers

- The five-hour class window uses Meta's reported duration; a missing duration is not guessed.
- Percentages above 100 are retained. Only the drawn progress bar is capped at 100.
- Meta's HTTP reset stamps are epoch seconds; MSP reset stamps are epoch milliseconds.
- A passed reset does not prove that the new allowance is unused. An expired window shows unknown until a new
  snapshot arrives. Old values remain available as previous readings, without active quota bars.
- A reading older than 30 minutes is treated the same way. What the panel then says depends on whether Refresh can
  help. Refresh re-reads Meta, so for an account Ancilla has checked directly (a Meta reading, a newer runtime reading
  on such an account, or a check that just failed) the panel asks for a refresh, and a failed check is reported on its
  own line. For an account only the Muse runtime reports (WSL, a Keychain-only login, a login that lost its token),
  Refresh cannot produce newer data, so the panel says that Muse reports it again when it next sends usage. It does not
  name a trigger, because the protocol allows several. A report from a server that predates direct checks carries no
  check time, so it is worded the same way.
- The sidebar pill follows the binding limit: the highest percentage among the limits that are current, marked as the
  weekly one when that is the one binding. It shows a dash only when no limit is current. The "switch accounts" hint on
  the new-thread screen compares accounts by the same figure.
- Reset countdowns count whole minutes below an hour and never show seconds, because the clock ticks once a minute.
  The pill tooltip and the Usage page describe a reading's age in the same short form, such as `28h` or `36d`.
- A missing `subs_usage` field is not a zero. Meta can omit it while the short window is idle, even if weekly usage
  exists. The panel keeps the reported plan name and explains that current quota was not included.
- Account selection is explicit. Readings from a different account cannot take over the selected meter.

## Plan name and source labels

`accounts[].planName` comes only from Meta's direct read (`subs_tier_name`). It is therefore null wherever that read
does not happen: under WSL, for Keychain-only logins, with `META_API_KEY`, and for named accounts while
`MUSE_AUTH_PATH` is set. Nothing else supplies it, and the numeric `usage.tier` is an opaque id, not a plan name.

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

WSL and Keychain-only credentials stay with Muse and use labelled runtime observations. Ancilla does not read browser
cookies or trigger Keychain prompts to fill a missing quota, and does not read a login file inside a WSL distro from
Windows. An inherited `META_API_KEY` overrides subscription sign-in, so that process does not query the browser login's
allowance. A global `MUSE_AUTH_PATH` override also prevents assigning that credential to every named profile. Readings
with no verified login identity are never saved, so they do not survive a restart.

Rejected logins, timeouts, unavailable service responses and malformed payloads never produce a fabricated allowance.
The panel distinguishes these from an inactive subscription and a subscription whose current quota was omitted.
The device-login exchange is provider-owned and may change; parsing failures fall back to clearly labelled observations.

## Implementation

- `packages/server/src/subscriptionQuota.ts`: bounded credential reads, fixed-origin request, response projection,
  credential-scoped cache, timeout and retry handling.
- `packages/server/src/server.ts`: account isolation, runtime observations, saved readings and `/api/plan-usage`.
- `packages/ui/src/model/plan.ts` and `components/usage/PlanMeter.tsx`: account selection, freshness and presentation.

The Muse 1.4.0 schema exported by `muse schema generate-json-schema` specifies that `usage/read` is last-observed data
and `usage/changed` may omit timestamp-only refreshes. The direct exchange was also checked against Meta with a signed-in
account without any session or inference call. Regression tests use injected HTTP responses and temporary login files.
