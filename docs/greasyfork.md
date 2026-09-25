<!-- The long description on Greasy Fork (greasyfork.org/scripts/597323). Greasy Fork syncs it from this file. -->

**Bulk delete, archive and rename your ChatGPT chats, without the "Too many requests" lockout.**

ChatGPT has no way to select several chats at once, and deleting them quickly gets you this:

> Too many requests. You're making requests too quickly. We've temporarily limited access to your conversations to protect your data.

Triage adds a cleanup workspace to chatgpt.com.
- You go through your chats oldest first, reading each one in a side panel, and mark it: delete, archive, rename or protect.
- Nothing changes until you press **Run Queue**.
- Triage then makes one change at a time. If ChatGPT says "too many requests", Triage stops, waits as long as ChatGPT asks, and carries on by itself.

**[Try the demo](https://nasircissistic.github.io/chatgpt-triage/demo/)** on a made-up account, with nothing real touched. The source is **[on GitHub](https://github.com/NASIRCISSISTIC/chatgpt-triage)**.

![Triage open on chatgpt.com: the list of chats on the left, the selected chat on the right](https://nasircissistic.github.io/chatgpt-triage/docs/review-light.png)

## What It Does

- **Read before you decide.** Click a chat or move with the arrow keys, and the whole conversation opens next to the list.
- **One queue for everything.** Delete, archive, unarchive and rename, marked with a click or a single key (`D`, `A`, `R`).
- **Protect what matters.** Press `P` and a chat can never be queued, not even by Select All.
- **Project chats stay out of the way.** The main list leaves out chats that live in Projects, so a cleanup can't empty a project by accident.
- **Pick up where you left off.** Marks, protected chats and read chats are saved in your browser. An interrupted run resumes from the same chat.
- **Built for big cleanups.** Filters, search, three sort orders, shift-click ranges, Select All and Invert. It stays fast with thousands of chats.
- **See exactly what will happen.** Before a run, Triage lists every chat that's about to change, deletions first.
- **A backup before deleting.** Triage can save every chat about to be deleted to a Markdown file first.
- **Checks its own work.** At the end of a run, Triage reloads your list and flags anything that didn't actually go.
- **Light or dark.** Triage matches ChatGPT's theme, or you can switch it yourself.

![The confirmation before a run, listing the chats about to change](https://nasircissistic.github.io/chatgpt-triage/docs/confirm.png)

## How It Stays Under ChatGPT's Limit

- **One change at a time**, 8 seconds apart by default. You can change this in Settings, down to a minimum of 3 seconds.
- **Every request is spaced out**, including loading your list and reading chats.
- **"Too many requests"** makes Triage stop and wait exactly as long as ChatGPT asks. If ChatGPT doesn't say how long, Triage waits 2 minutes, then 5, 15 and 30 if it keeps happening.
- **If your sign-in expires mid-run**, Triage refreshes it once and continues.
- **Pause and Stop** work at any point. Stopping never loses marks for chats it didn't reach.

![Waiting out ChatGPT's limit, with a countdown](https://nasircissistic.github.io/chatgpt-triage/docs/waiting.png)

## Using It

After installing, go to chatgpt.com. A **Triage** button appears in the bottom-right corner, or press `Alt` + `Shift` + `T`.

| Key | Does |
| --- | --- |
| `↑` `↓` or `J` `K` | Move through the list; the chat opens on the right |
| `Shift` + `↑` `↓` | Select as you move |
| `D` | Queue delete, then move on |
| `A` | Queue archive (unarchive in the Archived tab) |
| `R` | Queue a new name |
| `P` | Protect or unprotect |
| `C` | Clear the queued change |
| `/` | Search |
| `?` | All shortcuts |

**Chrome and Edge:** userscript managers need one extra switch. Turn on **Developer mode** on your browser's extensions page, or **Allow User Scripts** in Tampermonkey's details, whichever your browser shows.

## Privacy

- Triage runs entirely in your browser. The only server it talks to is chatgpt.com, using your existing sign-in.
- There are no analytics, no accounts, no server of its own and no remote code.
- Your marks and settings stay in your browser's local storage.
- The **Network** button lists every request Triage has sent. Your sign-in token is never shown or saved.

## Good to Know

- **Deleting is permanent.** OpenAI can't restore deleted chats. If you're unsure, archive instead, and turn on the backup when you delete.
- **Unofficial.** Triage uses ChatGPT's private web API, which OpenAI can change at any time.
- **Built for personal accounts.** Team, Business and Enterprise workspaces haven't been tested.
- **ChatGPT's list can lag.** After an archive or unarchive, ChatGPT's own chat list can take several minutes to catch up. Triage asks about the chat itself before calling a change failed.
- **One tab at a time.** Other ChatGPT tabs and the desktop app share the same request limit, so close them during a long run.

Bug reports and ideas are welcome on [GitHub Issues](https://github.com/NASIRCISSISTIC/chatgpt-triage/issues).

Triage is an independent project. It isn't affiliated with, endorsed by or sponsored by OpenAI.
