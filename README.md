# pi-tidy

<p align="center">
  <img src="https://raw.githubusercontent.com/Andy8647/pi-tidy/main/assets/cover.png" alt="pi-tidy — a reply's tool calls fold into one line" width="840">
</p>

Tool folding for the [pi](https://github.com/earendil-works/pi) coding agent: a reply's tool calls
fold into one line you can click open, while edits, failures and background jobs stay in view — and
every box gets a rounded transparent frame.

**▶ [Watch the 40-second demo](https://cdn.jsdelivr.net/gh/Andy8647/pi-tidy@v0.4.3/assets/demo.mp4)**

## Features

- **Rounded borders** — ╭╮╰╯ box drawing instead of pi's default ┌┐└┘
- **Every tool box** — built-in tools, MCP calls (pi-mcp-adapter), subagents, and any other extension's tools all get the same frame
- **Every message box** — compaction and branch summaries, skill invocations, and extension custom messages get the same frame, each kind in its own border color (user messages are left to pi-starline by default)
- **Per-tool border colors** — successful boxes take their tool's color (bash/read/edit/write/… configurable); pending stays grey, errors stay red
- **Nerd Font icons** — every box gets a kind icon; file tools show the target file's nvim-web-devicons glyph right in front of the path (`write /tmp/x.ts` renders `  write 󰛦 /tmp/x.ts`)
- **Side-by-side edit diffs** — an edit's diff renders as two panes (`old │ new`) with line numbers
  on both sides, a coloured bar and tinted row per changed line, and the changed word emphasised
  inside the line. Removed and added blocks pair up row by row, so a replaced block reads as
  before/after instead of two stacked runs. Below `splitDiffMinWidth` (or while the preview is still
  being computed) it falls back to pi's unified diff
- **Transparent background** — no solid background fill, works with terminal transparency
- **Grouped tool calls** — every tool call between two pieces of assistant text collapses to one line
  (`▸ 4 calls ·  bash×3  read×1 · 🧠 5 thoughts · 1.2s`). Click it and it turns into a `▾` header with one
  row per call under a `│` gutter; click a row to open that call's output underneath it — the row stays
  put and takes a `├─` tick off the rail, because inside a group the rail already frames it and a box
  there was a frame inside a frame. The `▾` header folds the whole group. The assistant's text always
  shows and is what separates groups, so you can still see a reply drifting; tool-only model steps
  don't split a group. Edits and writes stay outside groups (`alwaysShowTools`), but their
  individual previews still expand/collapse on a box click or `ctrl+o`. Edit previews obey
  `diffLines` in both split and unified layouts, including narrow terminals.
  Steps are separated by one blank rail row, so a long group reads as blocks rather than a wall.
  A folded group is one line: only a *running* call keeps a row, and a failure is reported once, as
  `3 failed` in red (`✗` per row once you open it). Every row says what the call produced
  (`12 lines`, `3 matches`, `exit 1`), and `ctrl+o` still expands everything (and collapses back to
  the summary)
- **Thinking, folded in** — a model step that only thinks and calls a tool used to leave a bare
  `Thinking...` behind; now it is a `thinking` row inside the group: a brain, the word, then one line of
  what the model actually thought, in order above the call it belongs to. The summary counts the runs
  and carries the same brain (`🧠 5 thoughts`), and a click opens that step's thinking full length — the
  same rounded box a tool result gets, in the new `thinkingColor` (yellow by default). While a run is
  still arriving the summary's marker spins (outside a group, the row's own glyph does, since there is
  no summary to carry it) and the preview slides over the newest words; once it stops, the row settles
  to a short head preview capped at 56 cells — a glance, not a paragraph. pi's `hideThinkingBlock`
  setting is ignored on purpose: the row is the same whether thinking is configured on or off, and the
  click is the one way to read it. A message that both thinks and writes gets the same row for its
  label (clicking it opens the same box), and its run stays out of the group's count — it renders above
  the text, not as a row in the list
- **Background jobs** — a call that starts a long-running process (pi-processes' `process start`) shows
  the *process's* state on its row: `◐ process ticker  running 12s · READY matched`, then
  `✓ … exited 0 · 20s` / `✗ … exit 1` / `⊘ … killed SIGTERM`. The summary spins while one runs
  (`◐ 1 running`), and the `[process] …` notification messages are folded into the row — pi-processes
  still delivers them to the model, pi-tidy just doesn't draw them twice. Starts inside codemode get
  independent process rows under the script, even when it starts several jobs or fails afterward.
  Each nested process has its own hover and expand target: click to see its command, working directory
  and the last 20 output lines without expanding the script. Open logs update as output arrives;
  processes whose logs are no longer retained still show their saved status
- **One-line boxes** — collapsed boxes keep a single row of output (`bashResultLines`), and a multi-line command
  plus `(+N more lines, ctrl+o to expand)`, so a long tool call no longer owns the screen; `ctrl+o`
  restores the whole command
- **Bash syntax highlighting** — commands get token-level coloring (commands, flags, strings, variables, operators, etc.)
- **Click a box to fold it** — non-link clicks land on pi's own expand toggle at the right row,
  including `renderShell: "self"` ones (edit, MCP); native filename links still open the file
- **Scroll-safe caching** — an unchanged box costs one line comparison per frame, nothing is re-framed

### Edit fold controls

Edit boxes show a separate `▸` (collapsed) / `▾` (expanded) switch before the
file icon. Click it, a border, or non-link diff text to toggle that box. Native
OSC 8 **filename links still open the file**; they are not fold buttons in Pi's
fullscreen interface. Drag selection and wheel scrolling remain native.

The default `diffLines: 0` makes collapse a real summary-only state, even for
small edits. An explicit positive `diffLines` retains that many preview rows;
a diff fitting entirely within that budget will not change height when opened.
`ctrl+o` remains Pi's **global** expand/collapse-all command, not a toggle for
the last clicked box. After individually opening a box, the first `ctrl+o` can
expand the remaining boxes rather than close that one; click `▾` to close it.

## What it looks like

A reply's tool calls, folded:

<img src="https://raw.githubusercontent.com/Andy8647/pi-tidy/main/assets/folded.png" alt="Five tool calls folded into one summary line" width="840">

A background process (pi-processes), tracked on the row that started it:

<img src="https://raw.githubusercontent.com/Andy8647/pi-tidy/main/assets/process.png" alt="A background process row with its live state" width="560">

Click `▸ 5 calls` and it becomes a `▾` header with one row per call, each step's thinking above it:

```
 ▾ 5 calls ·  bash×3  read×2 · 4 thoughts · 1 failed · 2.4s
 │ 🧠 thinking  测试挂了，先确认是哪一个断言炸的，再看是不是我们这边的问题
 │ ✓  bash git status --short  4 lines · 0.1s
 │ 🧠 thinking  看一眼改了什么
 │ ✓  read src/app.ts  120 lines · 0.0s
 │ ✗  bash pnpm test  exit 1 · 1.8s
 │ 🧠 thinking  …
```

## Installation

Install this fork (including the scroll-cache fixes, quiet input/compact footer and
collapsible unified edit previews):

```bash
pi install git:github.com/De0ta/pi-tidy
```

Disable/remove any other installed copy of pi-tidy before enabling this fork.
`npm:pi-tidy` is the upstream release and does not contain these fork changes.

Requires pi ≥ 1.1.0 (component mouse events, tool durations); on an older pi it
says so at session start. Bash highlighting and the custom write preview also need
`pi.registerToolRenderer()` (pi 1.3.0). Without that API they are skipped and Tidy
says so once, rather than falling back to a tool override that would stop another
extension from loading.

The original project is [Andy8647/pi-tidy](https://github.com/Andy8647/pi-tidy),
also available as `npm:pi-tidy`.

Restart pi to activate.

### Coming from pi-toolbox

pi-tidy is `@andy8647/pi-toolbox` renamed (from 0.4.2). Swap the package, and
remove the old one first so the two aren't loaded side by side:

```bash
pi remove npm:@andy8647/pi-toolbox
pi install npm:pi-tidy
```

Your `"toolbox"` settings keep working; rename the key to `"tidy"` when convenient.

The old package re-registered `bash` and `write` as its own tools so it could draw
the highlighted command row and the write preview. pi treats a second registration
under a built-in name as a hard failure, so Tidy could not be loaded alongside an
extension that sandboxes or gates those tools, in either load order. Since 0.4.5
both previews travel as `pi.registerToolRenderer()` resolvers instead, which is why
there is nothing left to conflict with (see [How it works](#how-it-works)).

## Releasing

`.github/workflows/publish.yml` publishes to npm on a published GitHub Release,
using npm's Trusted Publisher (OIDC) — no `NPM_TOKEN` secret. Bump `version` in
`package.json`, tag `vX.Y.Z`, and publish the release; the workflow fails fast
if the tag and the manifest version disagree.

## Configuration

Add a `tidy` key to your `~/.pi/agent/settings.json`; most changes apply on `/reload`.
For `editorStyle`, save your draft and **restart Pi** after changing the setting:

```json
{
  "tidy": {
    "enabled": true,
    "editorStyle": "native",
    "highlightBash": true,
    "frameMessages": true,
    "frameUserMessages": false,
    "icons": true,
    "bashResultLines": 1,
    "writeLines": 10,
    "diffLines": 0,
    "thinkingColor": "warning",
    "groupTools": true,
    "alwaysShowTools": ["edit", "write"],
    "backgroundJobs": true,
    "hideJobNotifications": true,
    "toolColors": {
      "bash": "bashMode",
      "read": "toolTitle",
      "edit": "syntaxVariable",
      "write": "syntaxVariable",
      "grep": "syntaxOperator",
      "find": "syntaxOperator",
      "ls": "syntaxOperator",
      "mcp": "customMessageLabel"
    },
    "messageBorderColors": {
      "user": "toolTitle",
      "compaction": "customMessageLabel",
      "branch": "mdCode",
      "skill": "accent",
      "custom": "warning"
    }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the extension |
| `editorStyle` | `"native" \| "quiet"` | `"native"` | Opt-in input frame and single-line footer; restart after changing. Unknown values use `native`. See below |
| `highlightBash` | boolean | `true` | Syntax-highlight bash commands |
| `frameMessages` | boolean | `true` | Frame compaction/branch/skill/custom-message boxes like tool boxes |
| `frameUserMessages` | boolean | `false` | Also frame user messages — off by default because pi-starline already restyles `UserMessageComponent`, and two render patches on one prototype fight over the output. Enable only without pi-starline |
| `icons` | boolean | `true` | Nerd Font icons on every box. Requires a Nerd Font; set `false` otherwise |
| `groupTools` | boolean | `true` | Fold the tool calls between two assistant text blocks (or a user message) into one summary line; click it for one row per call, click a row to open its output beneath it (no box inside the group), click the `▾` header to fold the group. `false` renders every call as its own box |
| `backgroundJobs` | boolean | `true` | A call that started a background job (pi-processes) shows the job's live state on its row and in the summary. A *running* job keeps its row while folded; a finished one folds away (the summary counts it). The spinner turns once a second for a job's first 5 minutes, then stands still (a dev server can run for hours) |
| `hideJobNotifications` | boolean | `true` | Don't draw a job's notification messages (`[process] "ticker" matched stdout: READY`) once its row shows them. Only drawing — the model still receives them. Jobs without a row keep their messages |
| `alwaysShowTools` | string[] | `["edit", "write"]` | Tools that never fold into a group: they keep their own box and end the group before them. The box's own preview still expands/collapses on click or `ctrl+o`. Set `[]` to group edits and writes like other calls |
| `splitDiff` | boolean | `true` | Render an edit's diff as two panes (`old │ new`) with line numbers, a bar and a tinted row per changed line. `false` keeps pi's unified diff |
| `splitDiffMinWidth` | number | `72` | Box width below which the split is dropped for pi's unified diff — two panes need room to stay readable |
| `thinkingColor` | theme color | `warning` | Colour of the brain, the `N thoughts` count and an expanded thinking box. Any theme color name or `#rrggbb` |
| `diffLines` | number | `0` | Collapsed edit-body rows in **both split and unified layouts**. By default only the file header, summary and hidden-line hint remain, so even a short edit visibly folds. Set a positive value (e.g. `20`) for a preview anchored at the first change; wrapped unified lines count as visual rows. Click `▸` / `▾` or a non-link part of the box to toggle |
| `bashResultLines` | number | `1` | Visual lines of bash *output* shown while collapsed. pi's renderer hard-codes 5 with no setting; raise this for more context, `0` to hide output until you expand |
| `writeLines` | number | `10` | Visual lines of a written file shown while the box is collapsed (pi's own number, now adjustable). `0` keeps just the header until you expand. Requires Pi's `registerToolRenderer` API |
| `toolColors` | object | see above | Border color per tool name for successful executions (pending stays grey, errors stay red, unlisted tools take `accent`). When set, the map **replaces** the defaults — `{}` disables per-tool colors |
| `messageBorderColors` | object | see above | Per-kind message-box border colors; merged over the defaults |

All color values are theme fg color names (`ThemeColor`), so they follow the
active theme. Default palette rationale: tool boxes reserve green/red/grey for
execution status, so message kinds get hues that don't collide —
`customMessageLabel` (mauve, matching the `[compaction]` label) for
compactions, `mdCode` (peach) for branch summaries, `accent` (sky) for skill
invocations, `warning` (yellow) for extension notices.

### Quiet-inspired input and compact footer (Pi 1.4.0)

Set `"tidy": { "editorStyle": "quiet" }` (merge into your existing `tidy` object):

```text
╭────────────────────────────────────────────────────╮
│ ❯ Your draft                                       │
│   continues here                                   │
╰─────────────────────── Model name (thinking level) ─╯
~/workspace (branch) • session name   5h 21% · 1w 60%
```

The input gets rounded sides, a prompt gutter and a right-aligned model/thinking
label. The duplicate workspace line above it is removed. The footer becomes
**one row**: workspace/session on the left, quota and other extension statuses
on the right. Cumulative token/cache/cost/context statistics and the duplicate
footer model are omitted; the model/thinking label remains on the input border.

Workspace/session formatting follows native Pi: the original path (home becomes
`~`), optional `(branch)`, optional ` • session name`, and the current theme's
`dim` color. No brackets, basename-only path or unnamed-session placeholder is
added. Names are sanitized and clipped by terminal columns (including Chinese
and emoji). The input model label uses current `muted`/`accent` colors, thinking
`off` omits its suffix, and borders retain Pi's editor border color. No global
palette is replaced.

The **original native editor instance does all editing**: completion, paste
(including collapsed large pastes), history, undo, shortcuts, multiline layout
and the hardware cursor marker for IME. Native padding settings still apply.
Completion stays below the frame; input/completion mouse coordinates account
for the horizontal margins only; no extra header row shifts clicks. Drag selection and wheel events remain
with Pi. Below 12 columns the frame and labels yield to a clipped native editor.
Pi still owns the working indicator (including an embedded native indicator).

The welcome header, transcript, scrolling, message frames, tool groups, thinking
boxes, split diffs and background jobs are not replaced. The compact footer uses
Pi's public `setFooter` API and reads **all live keyed extension statuses** on
every render. Subscription usage keeps its own percentages, reset countdowns,
colors, loading/auth-error text and refresh behavior: tidy does not parse quota,
add timers or make network requests. Existing status updates already request a
Pi render. With limited width, quota (`subscription-usage`) is shown first, then
other status keys alphabetically; long content is clipped, never moved to a
second row. At least 40% of the row is reserved for identity (up to its full
length), except below 8 columns where only clipped identity is shown.

**Other editor factories:** tidy captures the current public editor factory and
decorates its instance only when it uses Pi's native render, border and mouse
layout. Subclasses that only customize input (such as PiSessionDeck's
BrowserEditor) keep their shortcuts. Unknown layouts are left untouched with a
warning, rather than silently losing editing features. Load a cooperative editor
provider **before** tidy. A provider loaded later owns the single factory slot;
tidy will not reclaim it or overwrite it during cleanup. Keep the full pi-quiet
extension **disabled** when using this style.

**Other footer factories:** Pi has one public footer slot and no footer getter.
Quiet mode installs a compact footer; the last footer provider wins. Tidy's
`dispose` cleanup will not erase a later provider, but it cannot restore an
unknown earlier custom footer. Removing tidy's own footer restores Pi's built-in
footer. Status-only extensions remain supported through `getExtensionStatuses()`;
custom content drawn solely by another footer factory is not composed. Disable
one footer provider or choose the load order explicitly when combining them.

Installation happens at `session_start` in TUI mode only. No global editor
prototype is patched; owned instance methods and factories are cleaned up on
shutdown/runtime reload. A regular `/reload` uses Pi's runtime reset, but there
is no live style-toggle command. Save drafts and restart when changing styles:
Pi's factory replacement transfers raw text, **not undo/cursor/paste-map state**.
To restore the original input, set `"editorStyle": "native"` and restart.
Native mode registers neither editor nor footer factories/event handlers.

**Verification:** automated tests exercise native editing equivalence,
multiline/CJK/emoji widths, cursor markers, resize/narrow fallback, completion
keyboard/mouse geometry, labels, native working status and factory ownership /
cleanup. These are not a Windows Terminal end-to-end guarantee. After restarting,
check IME candidate placement, actual drag selection, bracketed/clipboard paste,
shortcuts (including SessionDeck's empty-input Left Arrow), completion menus,
scrolling through old tools/thinking/diffs and a running background process.
Also verify the native-looking identity and live quota/status content share just
one footer row and that your welcome header is unchanged. Automated tests compare
the identity's text/ANSI color with Pi's actual native footer and cover status
updates, widths, disposal and later-footer ownership. License for the adapted
input presentation: [third-party notices](THIRD_PARTY_NOTICES.md).

## How it works

pi builds one `ToolExecutionComponent` per tool call, no matter which extension
registered the tool. pi-tidy patches that component's `render` to frame the whole
box — which is why MCP and subagent boxes are framed too. Message boxes (compaction, branch
summary, skill invocation, extension custom message) never go through that
component; their own prototypes get the same treatment, with two exceptions
that keep their native styling: custom messages rendered by an
extension-provided renderer, and `!` bash-mode executions, which already draw
their own border. User messages are skipped by default because pi-starline
patches the same prototype.

Tidy registers **no tools at all**. Everything it changes about `bash` and `write`
(the highlighted command row, the collapsed output budgets, the write preview)
travels as a `pi.registerToolRenderer()` resolver, so the tool that is actually
installed keeps its execution, schema, shell and result renderer, and `next()`
hands Tidy whatever is downstream — pi's built-in renderers when an extension
defines none. Registering a tool under a built-in name is a hard failure in pi
(`Tool "write" conflicts with …`), which is why an extension that sandboxes
`bash`/`write` used to be mutually exclusive with Tidy no matter which loaded
first. It no longer is (issue #7, PR #8 and the bash follow-up).

An unchanged box returns its cached line array outright: pi re-renders the
whole transcript on every frame, including every mouse packet while scrolling.
Measured against unpatched pi at 300 boxes / 2400 lines: +0.03 ms per full
render.

### Grouping

Groups are derived at render time from transcript order — nothing is
persisted, so a reloaded session folds the same way. A boundary is a user
message or an assistant message with visible text; pi gives every model step its
own assistant message, and steps that only call a tool don't split a group.
`ctrl+o` and pi's own box clicks both arrive through `setExpanded`, which is how
the group levels stay in step with pi's per-box expand flag.

### Background jobs

pi has no notion of a job that outlives its tool call, so `background-jobs.ts`
has a small provider interface. pi-processes is the one provider: its
`processes:*` events on pi's shared extension bus keep a row live, its persisted
`ad-process:notification` messages rebuild a reloaded session, and a process it
no longer knows reads `not running`. If that protocol changes, rows fall back to
plain tool rows.

### Mouse

Clicks come from pi's own fullscreen mode (`tuiMode: "fullscreen"`, pi ≥ 0.86
component mouse events); pi-tidy never turns on mouse reporting itself. Only left
clicks on its own rows are taken — presses and drags pass through, so text
selection works as usual. Without fullscreen there are no clicks: `ctrl+o` still
toggles every box.

The transcript's scrollbar is pi's, and with `fullscreenScrollbar: "auto"` (the
default) pi paints it over the rightmost column — the one these frames put their
border in, so it covers the border while it is on screen. Set `"always"` and pi
reserves that column instead, drawing the frames one cell narrower; `"hidden"`
works too if you never want it. Nothing to configure on this side either way.

## Compatible themes

For the best transparent experience, set tool background colors to `""` in your theme:

```json
{
  "toolPendingBg": "",
  "toolSuccessBg": "",
  "toolErrorBg": ""
}
```

## License

MIT
