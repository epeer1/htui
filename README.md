<p align="center">
  <br />
  <strong>htui</strong>
  <br />
  <em>Horizontal Terminal UI</em>
  <br />
  <br />
  Turn terminal output into horizontally paged cards.<br />
  Builds, test suites, agent traces, and log streams — visible as a flowing timeline.
  <br />
  <br />

  [![npm version](https://img.shields.io/npm/v/htui.svg)](https://www.npmjs.com/package/htui)
  [![license](https://img.shields.io/npm/l/htui.svg)](https://github.com/epeer1/htui/blob/main/LICENSE)
  [![node](https://img.shields.io/node/v/htui.svg)](https://nodejs.org)
  [![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#zero-dependencies)

</p>

---

```
┌─────────────────┬─────────────────┬─────────────────┐
│ ✔ npm lint      │ ✘ npm test      │ ⊘ npm build     │
│─────────────────│─────────────────│─────────────────│
│ ✓ 0 errors      │ PASS utils.test  │                  │
│ ✓ 0 warnings    │ PASS app.test    │                  │
│                  │ FAIL auth.test   │   ⊘ blocked      │
│                  │   Expected: 200  │                  │
│                  │   Received: 401  │                  │
│                  │                  │                  │
│                  │ 5/6 passed       │                  │
│─────────────────│─────────────────│─────────────────│
│ ✔ done ── 1.1s  │ ✘ failed ─ 2.4s │ ⊘ blocked ──── │
└─────────────────┴─────────────────┴─────────────────┘
 ← → scroll  Enter expand  f follow  q quit     1 of 3
```

> **The flow direction is the feature.**
>
> Instead of output scrolling endlessly downward, each command or page of output becomes a card that flows left-to-right — like pages of a book. You see where you are, what passed, what failed, at a glance.

---

## Table of Contents

- [Why htui?](#why-htui)
- [Quick Start](#quick-start)
- [Modes](#modes)
  - [Shell Mode](#shell-mode)
  - [Run Mode](#run-mode)
  - [Pipe Mode](#pipe-mode)
  - [Wrap Mode](#wrap-mode)
  - [API Mode](#api-mode)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Chunking Strategies](#chunking-strategies)
- [Architecture](#architecture)
  - [Module Map](#module-map)
  - [Data Flow](#data-flow)
  - [Rendering Pipeline](#rendering-pipeline)
  - [Terminal Abstraction](#terminal-abstraction)
  - [Design Decisions](#design-decisions)
- [API Mode Protocol](#api-mode-protocol)
- [AI Agent Integration](#ai-agent-integration)
- [Design Philosophy](#design-philosophy)
- [Cross-Platform Support](#cross-platform-support)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [License](#license)

---

## Why htui?

Terminal output is vertical. You run a command, it scrolls down. Run another, it scrolls more. Run ten, and the first one is gone — buried above the fold, unreachable without scrolling back through hundreds of lines.

**htui changes the axis.** Output still flows top-to-bottom *within* a card — that's normal reading. But when a card fills the screen, it slides left and a new card appears on the right. The result is a **horizontal timeline** of your terminal work:

- **Builds and CI pipelines** — see lint, test, build side-by-side instead of hunting through scroll history
- **AI agent traces** — each reasoning step is a card; the entire chain of thought is visible as a storyboard
- **Log monitoring** — time-sliced log windows that let you spot the anomaly by *position*, not by scrolling
- **Multi-step workflows** — any sequential process becomes a visual timeline

Existing tools solve adjacent problems, but none focus on this interaction model:

| Tool | What it does | How htui differs |
|------|-------------|-----------------|
| tmux | Side-by-side terminal panes | Static split, not a flowing timeline |
| concurrently | Parallel command output interleaved | Still vertical, just colored prefixes |
| multitail | Tail multiple files side-by-side | Static columns, not horizontal flow |
| less -S | Horizontal scroll for wide lines | Still vertical line flow |
| **htui** | **Horizontally paged output cards** | **The flow direction is the feature** |

---

## Quick Start

```bash
# Run it instantly — no install required
npx htui run "echo hello" "echo world"

# Or install globally
npm install -g htui

# Interactive shell — type commands, each becomes a card
htui

# Run three commands as a visual pipeline
htui run "npm lint" "npm test" "npm build"

# Pipe any command's output into horizontal pages
npm test 2>&1 | htui

# Wrap a command (works everywhere, including Windows)
htui wrap "npm test"
```

**Requirements:** Node.js >= 18. Zero runtime dependencies.

---

## Modes

htui has five modes, each suited to a different workflow.

### Shell Mode

```bash
htui
```

An interactive shell. Type commands at the prompt, and each one becomes a card flowing left-to-right. You get a persistent visual history of everything you've run in the session.

```
┌─────────────────┬─────────────────┬─────────────────┐
│ ✔ ls -la        │ ✔ git status    │ ⠹ npm test      │
│─────────────────│─────────────────│─────────────────│
│ total 128       │ On branch main  │ PASS utils.test  │
│ drwxr-xr-x  12 │ Changes:        │ PASS app.test    │
│ -rw-r--r--   1 │  M src/app.ts   │ ⠹ running...     │
│ -rw-r--r--   1 │  M src/card.ts  │                  │
│─────────────────│─────────────────│─────────────────│
│ ✔ done ── 0.1s  │ ✔ done ── 0.3s  │ ⠹ active ─ 1.2s │
└─────────────────┴─────────────────┴─────────────────┘
── card 3 of 3 ─────────────────────────────────────────
❯ _
 Tab browse  ← → scroll  Enter expand  Ctrl+C quit
```

- **Tab** switches between typing commands and browsing cards
- **↑ ↓** navigates command history (like a normal shell)
- **← →** scrolls through cards when in browse mode
- **Enter** on a card expands it full-screen
- Type `exit` or `quit` to leave

### Run Mode

```bash
htui run "npm lint" "npm test" "npm build"
```

The killer demo. Run N commands sequentially, each as its own card. See your entire pipeline at a glance.

```
┌─────────────────┬─────────────────┬─────────────────┐
│ ✔ npm lint      │ ⠹ npm test      │ ◦ npm build     │
│─────────────────│─────────────────│─────────────────│
│ ✓ 0 errors      │ PASS utils.test  │                  │
│ ✓ 0 warnings    │ PASS app.test    │   ◦ queued       │
│                  │ ⠹ running...     │                  │
│                  │                  │                  │
│─────────────────│─────────────────│─────────────────│
│ ✔ done ── 1.1s  │ ⠹ active ─ 1.8s │ ◦ queued ────── │
└─────────────────┴─────────────────┴─────────────────┘
```

- Commands run sequentially — card 2 starts after card 1 finishes
- If a command fails, remaining cards are marked **blocked**
- The active card shows a spinning indicator (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) at 80ms
- Auto-follow keeps the active card in view as it runs

### Pipe Mode

```bash
npm test 2>&1 | htui
cat large-log.txt | htui
```

Pipe any output into htui. Content flows down within each card. When a card fills the terminal height, it slides left and a new card starts:

```
     page full → drifts left        currently filling ↓
┌─────────────┬─────────────┬─────────────┐
│ ⠹ page 1    │ ⠹ page 2    │ ⠹ page 3    │
│─────────────│─────────────│─────────────│
│ Compiling   │ Compiling   │ Bundle size:│
│ src/index.ts│ src/app.ts  │ 42kb        │
│ Compiling   │ Compiling   │ ✓ Build     │
│ src/utils.ts│ src/routes  │ complete    │
│ Compiling   │ Compiling   │ ▌           │
│ src/auth.ts │ src/db.ts   │             │
│ Compiling   │ Bundling... │             │
│ src/api.ts  │ Optimizing..│             │
│─────────────│─────────────│─────────────│
│ ⠹ active    │ ⠹ active    │ ⠹ active    │
└─────────────┴─────────────┴─────────────┘
```

Change the chunking strategy to group output differently:

```bash
# New card every 5 seconds
tail -f app.log | htui --chunk-by time --interval 5s

# New card on blank lines (great for agent traces)
my-agent run --task "refactor" | htui --chunk-by blank
```

**Platform note:** Pipe mode uses `/dev/tty` on Unix for keyboard input while stdin is piped. On Windows, pipe mode works but is non-interactive (output displays, no keyboard navigation). Use [wrap mode](#wrap-mode) on Windows for full interactivity.

### Wrap Mode

```bash
htui wrap "npm test"
htui wrap "npm test" --chunk-by time --interval 3s
```

htui spawns the command, captures its output into horizontally paged cards. This works everywhere, including Windows, because stdin isn't piped — htui owns both the child process and the terminal.

Wrap mode supports all chunking strategies:

```bash
htui wrap "npm test" --chunk-by page-fill    # default: new card when screen fills
htui wrap "npm test" --chunk-by time --interval 5s  # new card every 5 seconds
htui wrap "npm test" --chunk-by blank        # new card on blank lines
```

### API Mode

```bash
htui --api
```

Machine-readable JSONL protocol for AI agents and programmatic control. No TUI, no ANSI codes — pure structured JSON on stdin/stdout. See [API Mode Protocol](#api-mode-protocol) for full documentation.

---

## Keyboard Shortcuts

htui has four contexts, each with appropriate keybindings:

### Card View (Run / Pipe / Wrap modes)

| Key | Action |
|-----|--------|
| `←` `→` | Scroll between cards |
| `Enter` | Expand selected card full-screen |
| `f` | Toggle auto-follow (stick to newest card) |
| `q` | Quit |
| `Ctrl+C` | Quit |

### Shell Mode — Input

| Key | Action |
|-----|--------|
| Type | Enter command text |
| `Enter` | Submit command |
| `←` `→` | Move cursor in input |
| `↑` `↓` | Navigate command history |
| `Tab` | Switch to card browse mode |
| `Backspace` | Delete character before cursor |
| `Delete` | Delete character after cursor |
| `Ctrl+C` | Cancel running command / quit |

### Shell Mode — Browse

| Key | Action |
|-----|--------|
| `←` `→` | Scroll between cards |
| `Enter` | Expand selected card full-screen |
| `Tab` | Switch back to input mode |
| `Esc` | Switch back to input mode |
| `q` | Quit |

### Expanded Card View

| Key | Action |
|-----|--------|
| `↑` `↓` | Scroll content up/down |
| `G` | Jump to end |
| `g` | Jump to top |
| `Esc` | Back to card view |

---

## Chunking Strategies

Chunking controls when htui creates a new card (turns the page):

| Strategy | Flag | New card when... | Best for |
|----------|------|-----------------|----------|
| **page-fill** | *(default)* | Terminal height is filled | General output, builds |
| **time** | `--chunk-by time --interval 5s` | Time interval elapses | Log tailing, monitoring |
| **blank** | `--chunk-by blank` | Blank line appears in output | Agent traces, structured output |
| **run** | *(automatic in run mode)* | Each command gets its own card | CI pipelines, workflows |

Examples:

```bash
# Page-fill: cards wrap at terminal height (default)
cat big-log.txt | htui

# Time-based: 5-second windows of log output
tail -f /var/log/app.log | htui --chunk-by time --interval 5s

# Blank-line: agent output separated by blank lines
my-agent run | htui --chunk-by blank

# Run mode: each command = one card (automatic)
htui run "lint" "test" "build"
```

Time intervals support `ms`, `s`, and `m` suffixes:

```bash
--interval 500ms   # half a second
--interval 3s      # 3 seconds
--interval 1m      # 1 minute
```

---

## Architecture

htui is built as a set of focused modules, each with one responsibility. The architecture is deliberately simple — no plugin system, no event bus, no framework. Just TypeScript modules calling each other through clean interfaces.

### Module Map

```
src/
├── cli.ts          Entry point — arg parsing, mode dispatch, version/help
├── app.ts          Main orchestrator — wires terminal + renderer + cards + input
├── terminal.ts     Raw mode, alternate screen, keyboard input, resize handling
├── renderer.ts     ANSI card layout — box drawing, borders, colors, hint bars
├── card.ts         Card data model — status, title, lines, spinner animation
├── runner.ts       Run mode — sequential command execution with status tracking
├── chunker.ts      Pipe/wrap mode — distributes lines into cards by strategy
├── api.ts          API mode — JSONL protocol, command spawning, event emission
├── init.ts         Agent instruction installer — creates config files for AI agents
└── index.ts        Public barrel exports
```

### Data Flow

The following diagram shows how data flows from user input to rendered output:

```
                         ┌─────────────┐
                         │   cli.ts    │
                         │  arg parse  │
                         │ mode detect │
                         └──────┬──────┘
                                │
                    ┌───────────┼───────────┐
                    │           │           │
                    ▼           ▼           ▼
             ┌──────────┐ ┌─────────┐ ┌─────────┐
             │  app.ts  │ │ api.ts  │ │ init.ts │
             │   TUI    │ │  JSONL  │ │  files  │
             └────┬─────┘ └─────────┘ └─────────┘
                  │
      ┌───────────┼──────────────┐
      │           │              │
      ▼           ▼              ▼
┌──────────┐ ┌──────────┐ ┌───────────┐
│runner.ts │ │chunker.ts│ │ shell cmd │
│ run mode │ │pipe/wrap │ │  spawn()  │
└────┬─────┘ └────┬─────┘ └─────┬─────┘
     │            │              │
     └────────────┼──────────────┘
                  │
                  ▼  lines pushed to Card[]
           ┌──────────┐
           │ card.ts  │
           │ Card[]   │
           └────┬─────┘
                │
                ▼  scheduleRender()
         ┌────────────┐
         │renderer.ts │
         │ ANSI write │
         └─────┬──────┘
               │
               ▼  process.stdout.write()
         ┌────────────┐
         │terminal.ts │
         │ raw cursor │
         │ alt screen │
         └────────────┘
```

**Key paths:**

1. **Run mode:** `cli → app → runner → Card[] → renderer → terminal`
2. **Pipe/wrap mode:** `cli → app → chunker → Card[] → renderer → terminal`
3. **Shell mode:** `cli → app → spawn() → Card[] → renderer → terminal`
4. **API mode:** `cli → api → spawn() → Card[] → stdout (JSONL)`

### Rendering Pipeline

Rendering is the most performance-sensitive part of htui. Here's how a single frame gets to the screen:

```
  Event (keystroke, data, resize, spinner tick)
       │
       ▼
  scheduleRender()
       │
       │  if (!renderQueued) {
       │    renderQueued = true
       │    setImmediate(() => render())
       │  }
       │
       ▼  (coalesced — one render per event loop tick)
  render()
       │
       ├── expandedCard ? → renderExpanded(card)
       ├── shell mode ?   → renderShellCards(cards, input, ...)
       └── normal ?       → renderCards(cards, scroll, selected, ...)
                │
                ▼
        ┌─ Card Layout Calculation ─┐
        │                           │
        │  availableWidth = cols-2  │
        │  minCardWidth = 20        │
        │  maxCardWidth = 60        │
        │                           │
        │  Cards expand to fill     │
        │  available space when     │
        │  fewer cards are visible  │
        └───────────┬───────────────┘
                    │
                    ▼
        ┌─ Row-by-Row ANSI Write ───┐
        │                           │
        │  Row 0: ┌─ title ─┬─ ... │
        │  Row 1: │ content │ ...  │
        │   ...   │  ...    │ ...  │
        │  Row N: ├─ status ─┼─ ... │
        │  Row N+1: └────────┴─ ... │
        │  Row N+2: position bar    │
        │  Row N+3: hint bar        │
        │                           │
        │  cursor: moveTo(col, row) │
        │  style:  \x1b[...m        │
        │  text:   process.stdout   │
        └───────────────────────────┘
```

**Why coalesced rendering?** When a command produces 100 lines in a single data event, each line gets pushed to the card, but we only render *once* — at the next `setImmediate`. This prevents flicker and keeps the terminal responsive. Without coalescing, rapid output would cause hundreds of full-screen redraws per second.

**Card width calculation:** Cards dynamically size between 20 and 60 columns. When only 1-2 cards are visible, they expand to use available space. As more cards appear, they shrink to minimum width to fit more on screen. The algorithm:

```
available    = terminal_cols - 2 (outer borders)
max_fittable = floor((available + 1) / (min_width + 1))
visible      = min(max_fittable, card_count - scroll_offset)
card_width   = min(max_width, floor((available - (visible-1)) / visible))
```

### Terminal Abstraction

The `Terminal` class handles all raw terminal I/O:

```
Terminal
  ├── enter()     → alternate screen buffer + hide cursor + raw mode
  ├── exit()      → restore screen + show cursor + cooked mode
  ├── write()     → process.stdout.write (raw text)
  ├── writeStyled() → ANSI escape + text + reset
  ├── moveTo()    → cursor positioning \x1b[row;colH
  ├── clear()     → full screen clear
  ├── onKey()     → keyboard input handler
  └── onResize()  → terminal resize handler
```

**TTY input when stdin is piped:** On Unix, when stdin is a pipe (e.g. `cmd | htui`), the terminal opens `/dev/tty` directly for keyboard input. This allows simultaneous stdin data reading and interactive keyboard control. On Windows, `/dev/tty` doesn't exist, so pipe mode falls back to non-interactive display.

**Keystroke parsing:** Raw mode delivers bytes, not keystrokes. The terminal parses escape sequences (`\x1b[A` = Up, `\x1b[B` = Down, `\x1b[C` = Right, `\x1b[D` = Left) and control characters (`\x03` = Ctrl+C, `\x1b` = Escape, `\r` = Enter) into named key constants.

### Design Decisions

#### Why raw ANSI escape codes?

htui uses raw ANSI CSI sequences (`\x1b[...`) instead of a TUI framework like blessed, ink, or terminal-kit. This is the #1 design decision and it has consequences:

**Benefits:**
- **Zero dependencies** — `npx htui` downloads just htui, no dependency tree
- **Instant startup** — no framework initialization overhead
- **Full control** — precise cursor positioning, exact color control, no framework abstractions leaking
- **Small package** — the entire tool is a handful of TypeScript files
- **Same technique as vim/htop/less** — proven approach for terminal UIs

**Costs:**
- Harder to build — manual cursor math, manual escape sequence handling
- No layout engine — all positioning is calculated by hand
- Cross-platform quirks must be handled manually (Windows Console API differences)

This tradeoff is intentional. htui is a CLI tool that should feel **instant** — `npx htui run "cmd"` should launch in under a second. A dependency tree that needs to download blessed (or similar) defeats the purpose.

#### Why alternate screen buffer?

htui enters the alternate screen buffer (`\x1b[?1049h`) on startup, same as vim, less, and htop. When you quit htui, your terminal history is exactly as it was before — no pollution from htui's rendering. This is critical for a tool that redraws the full screen every frame.

#### Why setImmediate for render coalescing?

When output arrives from a command, it often comes in chunks of many lines. Each line updates the Card model, but we only need to render once per event loop tick. `setImmediate` queues a single render after all synchronous work (line processing) completes. This means:

- 100 lines arrive → 100 card updates → 1 render (not 100 renders)
- No `requestAnimationFrame` equivalent needed — `setImmediate` is the Node.js equivalent
- No debounce timer — renders happen as fast as the event loop allows, just not redundantly

#### Why a spinner at 80ms?

Active cards show a braille-pattern spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) cycling at 80ms. This matches the cadence of popular CLI spinners (ora uses 80ms). The spinner interval triggers a re-render only when at least one card has `status: 'active'`, so idle htui uses zero CPU for animation.

#### Why min 20 / max 60 card width?

- **20 columns minimum:** Below this, text is unreadable. Even error messages get truncated to meaninglessness.
- **60 columns maximum:** Cards wider than 60 columns waste space. Most terminal output (lint results, test names, log lines) fits comfortably in 50-60 characters. The max prevents a single card from consuming the entire terminal width.
- **Dynamic expansion:** When you have only 1-2 cards, they expand from 20 toward 60 to use available space. This prevents a narrow lonely card on a wide terminal.

---

## API Mode Protocol

API mode turns htui into a structured terminal runner for AI agents and automation. Communication happens via JSONL (one JSON object per line) on stdin (commands) and stdout (events).

### Starting API Mode

```bash
htui --api
```

Or via npx:

```bash
npx htui --api
```

### Commands (stdin → htui)

#### Run a command

```json
{"cmd": "run", "command": "npm test"}
```

Spawns the command in a shell. Output streams back as `card_output` events. The command runs asynchronously — you can send more commands while it's running.

#### List all cards

```json
{"cmd": "list"}
```

Returns status of all cards.

#### Get card content

```json
{"cmd": "get", "card": 0}
```

Returns full output of card 0.

#### Get partial card content

```json
{"cmd": "get", "card": 0, "lines": [0, 20]}
```

Returns lines 0-19 of card 0. Useful for long output.

#### Exit

```json
{"cmd": "exit"}
```

Terminates htui and all running commands.

### Events (htui → stdout)

#### ready

```json
{"event": "ready"}
```

Emitted once on startup. Safe to send commands after this.

#### card_created

```json
{"event": "card_created", "card": 0, "title": "npm test", "status": "active"}
```

A new card has been created. `card` is the zero-based index.

#### card_output

```json
{"event": "card_output", "card": 0, "line": "PASS utils.test.ts"}
```

A line of output from the command. Emitted for each line as it arrives.

#### card_done

```json
{"event": "card_done", "card": 0, "status": "done", "exitCode": 0, "duration": "2.1s", "lineCount": 42}
```

The command has finished. `status` is `"done"` (exit 0) or `"failed"` (non-zero exit).

#### cards (list response)

```json
{
  "event": "cards",
  "cards": [
    {"card": 0, "title": "npm test", "status": "done", "exitCode": 0, "duration": "2.1s", "lineCount": 42},
    {"card": 1, "title": "npm build", "status": "active", "duration": "0.8s", "lineCount": 12}
  ]
}
```

#### card_content (get response)

```json
{
  "event": "card_content",
  "card": 0,
  "title": "npm test",
  "status": "done",
  "exitCode": 0,
  "duration": "2.1s",
  "lineCount": 42,
  "lines": ["PASS utils.test.ts", "PASS app.test.ts", "..."]
}
```

#### error

```json
{"event": "error", "message": "Invalid card index: 5"}
```

### Example Session

```bash
$ htui --api
{"event":"ready"}
```

Send:
```json
{"cmd": "run", "command": "echo hello world"}
```

Receive:
```json
{"event":"card_created","card":0,"title":"echo hello world","status":"active"}
{"event":"card_output","card":0,"line":"hello world"}
{"event":"card_done","card":0,"status":"done","exitCode":0,"duration":"0.1s","lineCount":1}
```

Send:
```json
{"cmd": "get", "card": 0}
```

Receive:
```json
{"event":"card_content","card":0,"title":"echo hello world","status":"done","exitCode":0,"duration":"0.1s","lineCount":1,"lines":["hello world"]}
```

### Why API Mode?

AI coding agents (GitHub Copilot, Claude Code, Cursor, Windsurf) run terminal commands and parse the output. Raw terminal output is noisy — ANSI codes, interleaved stderr, truncated buffers. API mode gives agents:

- **Isolated output** — each command in its own card, no interleaving
- **Structured status** — exit code, duration, line count as JSON fields
- **Query previous commands** — retrieve any card's output by index
- **Partial reads** — get just the first 20 lines instead of 10,000
- **No ANSI parsing** — clean text lines, no escape code stripping

---

## AI Agent Integration

htui ships with `htui init` — a command that installs instruction files for all major AI coding agents. These files teach your AI agent how to use `htui --api` for structured terminal output instead of raw terminal commands.

### Quick Setup

```bash
# Interactive — select which agents you use
npx htui init

# Or specify directly
npx htui init copilot claude
npx htui init cursor --legacy
npx htui init antigravity --skill
npx htui init copilot --path-instructions
```

With no arguments, `htui init` shows an interactive menu where you pick your agents with arrow keys and spacebar.

### What Gets Created

| Agent | Default file | Optional (with flag) |
|-------|-------------|---------------------|
| *(always)* | `AGENTS.md` (full protocol) | — |
| `copilot` | `.github/copilot-instructions.md` | `--path-instructions` → `.github/instructions/htui.instructions.md` |
| `claude` | `CLAUDE.md` | — |
| `cursor` | `.cursor/rules/htui.mdc` | `--legacy` → `.cursorrules` |
| `windsurf` | `.windsurfrules` | — |
| `antigravity` | `GEMINI.md` | `--skill` → `skills/htui/SKILL.md` |

`AGENTS.md` is the **canonical source of truth** — it contains the full API mode protocol (all commands, events, and options). Agent-specific files are short shims that tell the agent to use `htui --api` and point to `AGENTS.md` for the complete reference. This avoids duplicating the protocol in every file and keeps agent context windows small.

### Upsert Behavior

Most agent files use `<!-- htui:start -->` / `<!-- htui:end -->` markers so that re-running `htui init` **updates in place** without touching your existing content. Files outside the markers are preserved.

`AGENTS.md`, `.cursor/rules/htui.mdc`, and `skills/htui/SKILL.md` are fully owned by htui and overwritten entirely on each run.

### Workflow

Once initialized, your AI agent will:

```
1. Start htui --api (once per session)
2. For each terminal command:
   a. Send {"cmd": "run", "command": "npm test"}
   b. Read card_output events as they stream
   c. Wait for card_done to know it finished
   d. Check exitCode and status
3. Query previous commands with {"cmd": "get", "card": N}
4. Send {"cmd": "exit"} when done
```

This replaces the typical "run command, parse raw terminal output, hope nothing was truncated" workflow with structured, queryable data.

---

## Design Philosophy

### Flow Direction Is the Feature

The core insight behind htui is that **reading direction matters**. Terminal output scrolls vertically, which means earlier output disappears upward. This is fine for single commands, but breaks down for sequential workflows:

- You can't see the lint results while reading the test results
- You can't see step 1 of an agent trace while it's on step 5
- You can't see the 10:00 AM logs while looking at 10:05 AM

By changing the flow to horizontal, htui makes **position meaningful**. Earlier output is to the left, later output is to the right. You can see multiple stages simultaneously. The spatial layout tells you where you are in the workflow.

### Cards, Not Panes

htui cards are not tmux panes. They're not side-by-side terminals. They're **pages** — sequential, ordered, flowing. A card represents a discrete unit of output: one command, one time window, one page of content. The metaphor is a book laid open, not a multi-monitor setup.

### Zero-Dependency by Design

htui uses zero runtime dependencies. This is not an accident or a flex — it's a product requirement:

1. **`npx htui` must feel instant.** Dependency trees add download time. A tool that takes 30 seconds to install won't get tried.
2. **Terminal tools have low tolerance for bloat.** If someone sees `node_modules/` with 200 packages for a terminal tool, trust erodes.
3. **ANSI escape codes are a stable API.** They don't need a framework. They've been the same since the VT100 in 1978.

The cost is more manual work in rendering and input handling. The benefit is that htui is a single `npm install` away from a working tool, every time.

### Progressive Enhancement

htui works at different levels depending on what the environment supports:

- **Full interactive TUI** — alternate screen, keyboard navigation, card browsing (run/wrap/shell modes)
- **Non-interactive display** — pipe mode on Windows shows output without keyboard controls
- **Pure data** — API mode strips all visual rendering and gives you structured JSON

This means htui is useful even in environments where a TUI isn't possible (CI pipelines, agent automation, redirected output).

---

## Cross-Platform Support

| Feature | macOS / Linux | Windows |
|---------|:------------:|:-------:|
| Shell mode | ✔ | ✔ |
| Run mode | ✔ | ✔ |
| Wrap mode | ✔ | ✔ |
| Pipe mode (interactive) | ✔ | — |
| Pipe mode (display only) | ✔ | ✔ |
| API mode | ✔ | ✔ |
| Alternate screen | ✔ | ✔ |
| Resize handling | ✔ (SIGWINCH) | ✔ (stdout resize event) |

**Why no interactive pipe mode on Windows?** On Unix, when stdin is a pipe, htui opens `/dev/tty` directly for keyboard input. This file doesn't exist on Windows. Windows pipe mode still displays output in cards, but without keyboard navigation. Use **wrap mode** (`htui wrap "command"`) for full interactivity on Windows — it works identically across all platforms.

---

## Contributing

htui is TypeScript, built with `tsc`, zero runtime dependencies.

### Setup

```bash
git clone https://github.com/epeer1/htui.git
cd htui
npm install     # dev dependencies only (typescript, @types/node)
npm run build   # compile TypeScript
```

### Development

```bash
npm run dev     # tsc --watch

# Test run mode
node dist/cli.js run "echo hello" "echo world" "echo done"

# Test pipe mode
echo "line 1\nline 2\nline 3" | node dist/cli.js

# Test wrap mode
node dist/cli.js wrap "echo hello"

# Test shell mode
node dist/cli.js

# Test API mode
node dist/cli.js --api
```

### Project Structure

Where to look when making changes:

| Change | File(s) |
|--------|---------|
| Add a CLI flag | `cli.ts` — arg parsing |
| Change card appearance | `renderer.ts` — ANSI rendering |
| Change card data model | `card.ts` — Card interface |
| Add a chunking strategy | `chunker.ts` — Chunker class |
| Change run mode behavior | `runner.ts` — runCommands() |
| Change keyboard shortcuts | `app.ts` — handleNormalInput(), handleShellInput() |
| Change API protocol | `api.ts` — ApiMode class |
| Change terminal handling | `terminal.ts` — Terminal class |
| Add an agent target | `init.ts` — TARGETS array |

### Coding Standards

- **Zero external dependencies** — use only Node.js built-in modules
- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Explicit types** on function signatures
- **`const` by default**, `let` only when mutation is needed
- **ANSI escape codes** via `Style` constants, not inline magic strings
- **Handle Windows + Unix differences** in terminal code

---

## Roadmap

### Implemented

- [x] Shell mode — interactive command entry with card output
- [x] Run mode — sequential command execution as cards (`htui run "cmd1" "cmd2"`)
- [x] Pipe mode — `command | htui` with page-fill, time, and blank chunking
- [x] Wrap mode — `htui wrap "command"` for cross-platform paged output
- [x] API mode — JSONL protocol for AI agents (`htui --api`)
- [x] Horizontal card rendering with box-drawn borders
- [x] Arrow key scrolling + card expand/collapse
- [x] Auto-follow mode (`f` toggle)
- [x] Dynamic terminal resize handling
- [x] Spinner animation for active/running cards
- [x] Status-colored borders (green=done, red=failed, yellow=active, cyan=selected)
- [x] Shell command history (↑ ↓)
- [x] Shell browse/input mode switching (Tab)
- [x] `htui init` — agent instruction installer for all major AI agents
- [x] Antigravity/Gemini support in `htui init` with optional skill generation
- [x] Cross-platform support (macOS, Linux, Windows)
- [x] Card expand view with line numbers, vim-style navigation (G, g)

### Planned

- [ ] `--chunk-by regex --pattern "..."` — regex-based chunking
- [ ] `--continue-on-error` — run mode continues past failures
- [ ] Mouse wheel horizontal scroll
- [ ] Parallel run mode (`htui run --parallel "cmd1" "cmd2"`)
- [ ] Search within cards
- [ ] Card summary footers (line counts, error counts)
- [ ] Color/theme customization
- [ ] Export timeline as HTML/image
- [ ] VS Code extension (`htui-vscode`)

---

## License

MIT
