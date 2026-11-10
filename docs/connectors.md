# Connectors

A connector is an account the assistant can work in: GitHub, Supabase and Brevo today. You connect one with a token you make
yourself, under **Assistant, Connectors**, and then ask by voice ("what is open on my GitHub?") or in the box on that page. The
assistant answers in a task under **Assistant, Tasks**, and says where the answer came from.

A connected account starts **read only**. For GitHub you can also switch on kinds of change (a comment, an issue, a pull request,
a merge). The assistant may then ask for one, and **nothing happens until you say yes to that exact change**: you are shown the
account, the tool and every argument, and an approval is good for those arguments only, once, for ten minutes. Supabase and
Brevo have no changes yet; they come after this one, through the same gate.

## Connecting an account

| Account | What to make | Where |
| --- | --- | --- |
| GitHub | A fine-grained personal access token, with the repositories it may see and **Read-only** on Contents, Issues, Pull requests and Metadata. To let the assistant ask for changes too, **Read and write** on Issues and Pull requests (and Contents, for branches) | github.com/settings/personal-access-tokens |
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

For each account, a list of tools that **Ancilla** wrote down (`packages/server/src/connectors/catalog.ts`), each with a class:

- **read** looks and changes nothing. GitHub 12: who you are, search repositories, issues and pull requests, list and read issues
  and pull requests, read a file, list and read commits, list notifications. Supabase 10: list and read projects, tables,
  migrations, extensions, advisories, logs and edge functions, search the docs. Brevo 12: the account, email campaigns and their
  statistics and events, contacts, lists, segments, senders, templates, SMS campaigns.
- **reversible** can be undone in a click: GitHub `create_branch`.
- **communicates** is seen by other people: GitHub `add_issue_comment`, `issue_write` (open or edit an issue) and
  `create_pull_request`.
- **destructive** cannot be taken back: GitHub `merge_pull_request`, and `issue_write` when its arguments close the issue (a call
  is held to the class its arguments make it, never lower than its tool's).

A tool that is not on the list is not offered, and it cannot be called even by its name: the call is refused inside Ancilla and
never reaches the server. This holds for every tool the server has that Ancilla did not list (`delete_file`, `push_files`,
`actions_run_trigger` and the rest), and for odd names such as `__proto__`. What the server says about its own tools is never
used: the model is given Ancilla's words for each tool and the shape of its arguments (names, types, what is required), and
every description, title and example the server wrote is dropped, because it is text a model would read as instructions.

Arbitrary SQL (`execute_sql` on Supabase) is not offered, because a statement can be a read or a drop. It waits for the step that
reads the statement before it runs.

## Changes, and your approval

Under each account that has changes, **Changes it may ask for** has one setting per kind: **Off** or **Ask me each time**. Each
starts **Off**, so an account connected before this existed, or with a read-only token, behaves exactly as it did. A tool of a
kind that is off is not offered at all, and a call to it by name is refused and written down.

With a kind on, a change the assistant wants is **held**. The task shows as *Needs your OK* under Tasks (and you are told, if
notifications are on), and the card is answered there:

- The card is built from the call itself, never from what the model said about it: the account, the tool in Ancilla's words, what
  it is about (`owner/repo #12`), **every argument whole**, and a fingerprint of them. A text too long to be read whole (more than
  8,000 characters) is not sent at all.
- **Do it** records an approval bound to a hash of the connector, the tool and the arguments (SHA-256 over their canonical form).
  The call reaches the account only by redeeming that approval, and the redemption refuses it if it is not one Ancilla gave, was
  used already, is older than ten minutes, or the arguments differ in any way: any change asks again. A different argument
  *burns* the approval.
- **Don't**, no answer in ten minutes, or the task being stopped does nothing, and the model is told so in words ("the person
  said no, do not try again").
- The time a task waits for you does not count against its five minutes of work.

A reversible change also has **Do it, and always do small changes like this**, offered only after you have said yes to one before
and only while the task holds nothing a stranger wrote. It then runs without a card, but still with an approval bound to its
arguments, written down as a standing rule. It can be set back to *Ask me each time* on the page. Changes other people see, and
changes that cannot be taken back, are asked about **every time**: there is no "always" for them, in the page or in the file (a
hand-edited `connectors.json` that says so is read as *ask*).

### Text a stranger wrote

A task **taints** once it has read text that other people can write: an issue, a pull request, a comment, a commit, a contact (a
read of who you are, or your own projects, does not). The card then says so, and carries flags that **code worked out**, not the
model:

- the target (repository or number) is one **you did not name** in what you asked;
- the text holds a **link or an address you did not write**;
- the text holds something **shaped like a key, token or password**;
- the text **copies words from a different item** than the one it answers;
- the text holds **characters that cannot be seen** (shown as a mark on the card).

The flags inform you; they do not block. What a stranger cannot do is make a change happen: a model that does whatever an issue
tells it to do reaches a card for each change, with its flags, and with no answer nothing is sent.

### Tasks nobody started in person

A task started by a schedule, or by something that arrived, may **not change anything**. What it wants becomes a *proposal* under
**Waiting for you** on the Connectors page, and runs only if you approve that very card (the same hash check, once). A proposal
waits a day; at most five wait at once. Nothing starts a connector task from a schedule yet, so this is the rule that will hold
when something does: `createConnector` takes who started the task as a required argument, so no caller can forget to say.

## What comes back, and what a stranger can do with it

What a tool returns is text other people wrote: an issue, a campaign name, a contact. The assistant reads it as data, never as
instructions, and the system prompt says so, but that is the model's discipline and not the wall. The wall is structural: a task
on an account has no tool that reads a file or runs a command, no change without an approval whose hash matches, at most 4 calls
per reply and 12 steps, and an answer that is kept and shown as **From GitHub (not checked)**. The tests include a model that does
whatever an issue tells it to do, with an issue that tells it to comment with a link, merge a pull request and close an issue: it
asks for all three, every one waits for a card, and with no answer, or a no, nothing reaches the server.

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
refused call is written too. Every step of a **change** is written as its own line with the **hash of its arguments** (whole in
the file, eight characters on the page): held, approved, refused, expired, kept as a proposal, executed. The hash on `executed`
is the one on `approved`, so what was sent can be told from what was shown. No tool the assistant has can read or change this
file.

## How it runs

The connection uses the official MCP client (`@modelcontextprotocol/sdk`, pinned), over HTTP with the token as a bearer or to a
program on this computer that is given the token in its own small environment. A task is a row under Tasks with the origin
`connector`: it has no Muse thread, it cannot be paused, resumed or tried again (cancel it and ask again), only one runs at a
time (also while it waits for your answer), and one that Ancilla was closed around is ended, never started again.

The model is the one the voice is set to use (Assistant, Voice): a hosted one, one on this computer, or Muse. Muse is run with none of
its own tools, as web tasks do (see [the browser docs](browser.md#the-assistant-browsing)), and every step then carries about 16,000
tokens of Muse's own instructions plus about 140 for each tool offered: a short question is about 50,000 tokens of a Muse plan. A
kind of change that is on adds its tools to every step.

## The HTTP surface

Under `/api/assistant/connectors`, like the rest of `/api`: `GET` (the accounts, their settings and the tools those switch on,
and where tokens are kept), `POST /:id/connect` `{token}`, `POST /:id/test`, `PATCH /:id` `{mode: "off" | "read"}` and/or
`{policy: {reversible | communicates | destructive: "off" | "ask"}}` (`"always"` only for `reversible`, only after a yes),
`DELETE /:id`, `GET /activity?limit=`, `POST /ask` `{connector, goal, title?}` (started by you, so its changes are put to you),
`GET /question/:taskId` (the card a task waits on) and `POST /question/:cardId` `{answer: "do" | "dont" | "always"}`, and
`GET /proposals` with `POST /proposals/:id` `{answer: "do" | "dont"}`. No answer carries a token. The voice has one tool,
`use_connector`, offered only while an account is connected and switched on, and naming which.

## What is not covered

- **Nothing was tried against a live account.** The tool names come from GitHub's and Supabase's documentation and from the tool
  list of Brevo's hosted server, the changes' too (`create_branch`, `add_issue_comment`, `issue_write`, `create_pull_request`,
  `merge_pull_request`, and the argument names the card and the classes read: `owner`, `repo`, `issue_number`, `pullNumber`,
  `state`). A name that has changed is not offered, and **Test** says how many of the list were not found; an argument name that
  has changed still shows on the card, since the card shows every argument. Run Test with your own token first, and try one
  change on a throwaway repository.
- **Changes in Supabase and Brevo**, and **OAuth** sign-in (Supabase, Hostinger, GitHub), then Gmail with sending through your own
  Google client, come after this.
- **Proposals live in memory**: closing Ancilla drops them, and nothing tells you about one until you open the page. They matter
  once something starts a connector task without you; nothing does yet.
- **The approval is a click on this screen.** Approving from your phone, and a delay-and-undo for sends, are not built.
- Muse coding threads do not get connectors, and no one can add a server of their own: a server's tool descriptions are
  instructions to a model, so only reviewed ones are offered.
- Brevo's and Supabase's tokens cannot be limited at the provider (above), and the activity list is a record, not an alarm.
