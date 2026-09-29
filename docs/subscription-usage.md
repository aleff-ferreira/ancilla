# Subscription usage

Usage separates Muse Code subscription allowance from local token history and API-rate cost estimates. Local tokens
cannot establish a subscription percentage: Meta owns the allowance and its accounting rules.

## Sources

| Source | What Ancilla reads | Freshness |
| --- | --- | --- |
| Meta | The subscription snapshot returned by Muse's device-login exchange | Fetched when Usage opens or Refresh is selected; visible Usage pages poll once a minute |
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
- A missing `subs_usage` field is not a zero. Meta can omit it while the short window is idle, even if weekly usage
  exists. The panel keeps the reported plan name and explains that current quota was not included.
- Account selection is explicit. Readings from a different account cannot take over the selected meter.

## Fallbacks

WSL and Keychain-only credentials stay with Muse and use labelled runtime observations. Ancilla does not read browser
cookies or trigger Keychain prompts to fill a missing quota. An inherited `META_API_KEY` overrides subscription sign-in,
so that process does not query the browser login's allowance. A global `MUSE_AUTH_PATH` override also prevents assigning
that credential to every named profile.

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
