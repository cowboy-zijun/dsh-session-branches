# dsh-session-branches

Let the model in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) **see and read conversation branches**.

English | [中文](README.md)

## The problem

A DSH "branch" on a completed turn is a fork: it copies every Session event up to that turn into a **brand-new independent Session**.

- the child header records `isSeeded: true` but **no `parentSession`** — a branch is an independent conversation, not a subagent;
- so `sessionQuery.traceSession()` cannot see it, and the sidebar does not indent it;
- the only durable link left is the copied prefix.

In practice: inside one branch you keep everything before the fork, but **you cannot see what the other branch did afterwards**, and the model has no tool to enumerate or read those Sessions.

This plugin closes that gap. It groups Sessions whose first event is byte-identical (a fork copies it verbatim, timestamp included), then compares logs event by event to find the exact divergence point, and exposes the result as tools.

## Tools

| Tool | Purpose |
|---|---|
| `branch_list` | Lists Sessions sharing this conversation's history: id, title, relation (`source` / `fork` / `descendant`), fork-point `seq`, own event count, and the prompts the human typed in that branch |
| `branch_read` | Reads one branch's messages from its fork point; `from_seq` pages, `include_tools` adds tool names |

A prompt section (`conversation-branches`) tells the model when to call them, so it does not wait to be reminded.

## Install

A DSH bundle (`package.json` declares `dsh.bundle.patch`), plain JS, no build step, no dependencies.

1. Clone or download this repository anywhere on disk.
2. Install that directory as a bundle: Plugin Manager → install bundle with the directory's **absolute path**, or let an agent call `plugin_manager` with `action: install_bundle` and that path as `target`.

`install_bundle` also accepts an installation spec, so `github:<owner>/dsh-session-branches` works.

> Let the plugin manager write the profile's dependency and `dsh.profile.bundles` entry; do not hand-edit the profile's `package.json` or `cordis.patch.yml`.

After install: both tools appear in the model's tool list, the system prompt gains `## Conversation branches`, and the plugin inventory shows "Conversation branches" (English) or "对话分支" (Chinese).

## How it works

1. `ctx.sessionQuery.listSessions()` yields candidates (subagent Sessions and Sessions older than this lineage's first event are skipped).
2. Each candidate gets one cheap `readEvent({ seq: 0 })` probe returning `inheritedEventCount` and the first event.
3. An identical first event (`time + type + data`) means the same branch tree.
4. Matching candidates are read in full and compared event by event; the identical leading run is the fork point.
5. After the fork point only `user/message` (`source.kind === 'user'`) and `assistant/message` text is kept; injected context (`runtime-context`, `time-context`, `skill-catalog`, …) is filtered by `source.kind`.

## Limits

- Text only: images, files, reasoning, and tool output are not reproduced; `include_tools` adds tool names only.
- Subagent Sessions are excluded (use the subagent tools for those).
- At most 80 recent Sessions are probed per call and 8 branches reported by default.
- It is not "read any Session": only Sessions sharing this conversation's history are returned.

## Test

```powershell
node test/smoke.test.mjs
```

Covers discovery, relation labels, fork point, preview filtering, paging, and the error path on a hand-built source/branch pair.

## Package name

The package is named `@local/dsh-session-branches` to match the installed copy, so one profile never holds two packages that register the same tool names.

To publish on npm, change `name` (and drop `"private": true`), reinstall, and remove the earlier `@local/...` copy first — two plugins registering `branch_list` conflict.

## License

MIT
