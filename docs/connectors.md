# Connectors

A connector is an account the assistant can look things up in: GitHub, Supabase and Brevo today. You connect one with a token you
make yourself, under **Assistant, Connectors**, and then ask by voice ("what is open on my GitHub?") or in the box on that page.
The assistant answers in a task under **Assistant, Tasks**, and says where the answer came from.

This first version is **read only**. The assistant is given a short list of read tools for each account and nothing else, so it
cannot change, send or post anything in any of them. Changes, with an approval you give on the screen for each one, are a
later step; they are not half-built here.

## Connecting an account

| Account | What to make | Where |
| --- | --- | --- |
| GitHub | A fine-grained personal access token, with the repositories it may see and **Read-only** on Contents, Issues, Pull requests and Metadata | github.com/settings/personal-access-tokens |
| Supabase | A personal access token | supabase.com/dashboard/account/tokens |
| Brevo | An **MCP API key** (an ordinary API key does not work) | Brevo, SMTP & API, API Keys |

The page says the same, with a link, next to each account. Paste the token and press **Connect**. Ancilla keeps it only if the
account's server accepts it and one harmless read (who you are, or your projects) works, so a wrong token is refused at once and
nothing is saved. A token is typed once and never shown again.

**Switch** turns the account off for the assistant without disconnecting it. **Test** checks it again and shows what the
assistant is given. **Disconnect** deletes the token from Ancilla. It cannot revoke the token at the provider, because no provider
lets a client do that for a token it did not issue: the page shows where to delete it, and you should.

GitHub is the only one of the three whose token can be made small. A Supabase token reaches every project of your account, and a
Brevo MCP key does everything your account can, sending campaigns included. For those two the list of tools below is the only
wall, which is why the page says so before you connect. Make the key just for Ancilla.

## What the assistant is given

For each account, a list of tools that **Ancilla** wrote down (`packages/server/src/connectors/catalog.ts`):

- GitHub, 12: who you are, search repositories, issues and pull requests, list and read issues and pull requests, read a file,
  list and read commits, list notifications.
- Supabase, 10: list and read projects, tables, migrations, extensions, advisories, logs and edge functions, search the docs.
- Brevo, 12: the account, email campaigns and their statistics and events, contacts, lists, segments, senders, templates, SMS
  campaigns.

A tool that is not on the list is not offered, and it cannot be called even by its name: the call is refused inside Ancilla and
never reaches the server. This holds for every write tool the server has, for a read tool that is not on the list, and for odd
names such as `__proto__`. What the server says about its own tools is never used: the model is given Ancilla's words for each
tool and the shape of its arguments (names, types, what is required), and every description, title and example the server wrote
is dropped, because it is text a model would read as instructions.

Arbitrary SQL (`execute_sql` on Supabase) is not offered, because a statement can be a read or a drop. It waits for the step that
reads the statement before it runs.

## What comes back, and what a stranger can do with it

What a tool returns is text other people wrote: an issue, a campaign name, a contact. The assistant reads it as data, never as
instructions, and the system prompt says so, but that is the model's discipline and not the wall. The wall is structural: a task
on an account has no write tool to be talked into using, no tool that reads a file or runs a command, at most 4 calls per reply
and 12 steps, and an answer that is kept and shown as **From GitHub (not checked)**. The tests include a model that does whatever
an issue tells it to do, and an issue that tells it to merge a pull request and delete a file: it asks, every call is refused, and
nothing reaches the server.

Anything that looks like a credential in a result (a GitHub or Supabase or Brevo token, a JWT, a bearer, a private key) is
replaced by `[hidden]`, as is the account's own token if a server echoes it back. Results are cut at 4000 characters.

**What it reads goes to the model that answers**, as anything you say to it does. With a model on the internet it leaves this
computer; with one on this computer it does not. Contacts and campaign names are personal data: choose the model with that in mind
(Assistant, Voice).

## Where the token is kept

In `<data folder>/connectors/secrets.json`, a file only your user account can read (mode 0600; on Windows it keeps the rights of
the folder it is in). The page says so. It is used in one place: the `Authorization` header of the connection, or the environment
of a program started for it. It is never put in Ancilla's own environment, a prompt, a log, an answer of the API, a Muse thread or
the activity list. The OS keychain would be better, and the seam for it is `SecretStore`, but the desktop app is one bundled file
and a keychain module is a native one, so it waits for that packaging.

## Activity

Every connection, check, switch and call is written to `<data folder>/connectors/activity.jsonl` and shown under Activity: when,
which account, which tool and with what (long values cut, anything that looks like a credential hidden), and whether it worked. A
refused call is written too. No tool the assistant has can read or change this file.

## How it runs

The connection uses the official MCP client (`@modelcontextprotocol/sdk`, pinned), over HTTP with the token as a bearer or to a
program on this computer that is given the token in its own small environment. A task is a row under Tasks with the origin
`connector`: it has no Muse thread, it cannot be paused, resumed or tried again (cancel it and ask again), only one runs at a
time, and one that Ancilla was closed around is ended, never started again.

The model is the one the voice is set to use (Assistant, Voice): a hosted one, one on this computer, or Muse. Muse is run with none of
its own tools, as web tasks do (see [the browser docs](browser.md#the-assistant-browsing)), and every step then carries about 16,000
tokens of Muse's own instructions plus about 140 for each tool offered: a short question is about 50,000 tokens of a Muse plan.

## The HTTP surface

Under `/api/assistant/connectors`, like the rest of `/api`: `GET` (the accounts and where tokens are kept), `POST /:id/connect`
`{token}`, `POST /:id/test`, `PATCH /:id` `{mode: "off" | "read"}`, `DELETE /:id`, `GET /activity?limit=`, and `POST /ask`
`{connector, goal, title?}`. No answer carries a token. The voice has one tool, `use_connector`, offered only while an account is
connected and switched on, and naming which.

## What is not covered

- **Nothing was tried against a live account.** The tool names come from GitHub's and Supabase's documentation and from the tool
  list of Brevo's hosted server. A name that has changed is not offered, and **Test** says how many of the list were not found.
  Run Test with your own token first.
- **Writes**, and the approval that goes with each, come next; **OAuth** sign-in (Supabase, Hostinger, GitHub) after that, then
  Gmail with sending, through your own Google client.
- Muse coding threads do not get connectors, and no one can add a server of their own: a server's tool descriptions are
  instructions to a model, so only reviewed ones are offered.
- Brevo's and Supabase's tokens cannot be limited at the provider (above), and the activity list is a record, not an alarm.
