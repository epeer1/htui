# HTUI — Horizontal Terminal UI

> *Flow direction is the feature.*

## Concept

A CLI tool that turns terminal output into a **horizontal timeline**. Output streams **down** within a card — normal reading, top to bottom. When the card fills the terminal height, it **drifts left** and a new card appears on the right. Like pages of a book, laid out horizontally.

Ships as an **npm package + CLI** using ANSI escape codes (the same way vim, htop, and less work). Targets cross-platform support — macOS, Linux, Windows — but terminal behavior varies, so coverage will be proven incrementally.

**One-line pitch:** `htui` turns long terminal output into horizontally paged cards, so builds, agent traces, and log windows stay visible as a flowing timeline.

---

## Positioning

This is **not** a general-purpose replacement for terminal scrolling. It is a **better view for chunked, phase-based, or stream-based output**:

- Builds and test pipelines
- Multi-step CLI workflows
- AI agent / workflow traces
- Log windows by time slice

---

## Architecture

```
htui (npm package + CLI)                  ← THE PRODUCT, works everywhere
  └── Raw ANSI-based TUI renderer (zero dependencies)
  └── pipe mode: command | htui
  └── run mode: htui run "cmd1" "cmd2"
  └── dynamic cols/rows from terminal size
  └── horizontal scroll (arrow keys, mouse wheel)

htui-vscode (optional VS Code extension)  ← BONUS, nice-to-have later
  └── toggle button in terminal toolbar
  └── deeper integration
```

### Tech Stack

- **Node.js + raw ANSI escape codes** — zero dependencies, `npx htui` feels instant
- Precise cursor control via `process.stdout.write` for card layout rendering
- Cross-platform: `SIGWINCH` on Unix, Console API on Windows for resize events
- Rendering core kept replaceable — can wrap in Ink later if needed
- **Tradeoff:** raw ANSI gives full control but is harder to build than using a TUI framework. This is a deliberate choice for zero-dep install speed and precise rendering, at the cost of slower initial development.

---

## Distribution

| Channel            | Package                      |
| ------------------ | ---------------------------- |
| npm                | `htui`                       |
| Usage (no install) | `npx htui`                   |
| VS Code (later)    | `htui-vscode` on marketplace |

---

## Core Mental Model

Within each card, it's a **normal terminal** — you read top to bottom. The horizontal flow only kicks in when you run out of vertical space. It's **pagination**, not fragmentation.

```
     page full → drifts left        currently filling ↓
┌─────────────┬─────────────┬─────────────┐
│ GET /api 200│ PUT /usr 200│ ERR db      │
│ GET /    200│ GET /api 200│  timeout    │
│ POST /  201 │ GET /css 304│ GET /api 500│
│ GET /img 200│ DELETE /  200│ POST /  201 │
│ GET /css 200│ POST /lg 201│ GET /    200│
│ PUT /usr 200│ GET /api 200│ ▌           │ ← cursor, still filling
│ GET /api 200│ ERR timeout │             │
│ POST /  201 │ GET /    200│             │
│─────────────│─────────────│─────────────│
│ page 1      │ page 2      │ page 3 ▸    │
└─────────────┴─────────────┴─────────────┘
```

The **page-turn moment** — when a card fills up and slides left — is the key visual that distinguishes htui from a normal terminal.

---

## User Scenarios

### Scenario 1: Run Mode (the killer demo)

```
htui run "npm lint" "npm test" "npm build"
```

This is the first thing anyone should see. Three commands, three cards, left to right:

```
┌─────────────────┬─────────────────┬─────────────────┐
│ npm lint         │ npm test         │ npm build        │
│─────────────────│─────────────────│─────────────────│
│ ✓ 0 errors      │ PASS utils.test  │                  │
│ ✓ 0 warnings    │ PASS app.test    │   ⏳ queued      │
│                  │ FAIL auth.test   │                  │
│                  │   Expected: 200  │                  │
│                  │   Received: 401  │                  │
│                  │                  │                  │
│                  │ 5/6 passed       │                  │
│─────────────────│─────────────────│─────────────────│
│ ✓ done   1.1s   │ ✗ fail   2.4s   │ blocked          │
└─────────────────┴─────────────────┴─────────────────┘
```

- Each command is a card. Cards fill the terminal height.
- The active card is highlighted. Finished cards show status + duration.
- If a command fails, the next card shows "blocked" (or runs anyway with `--continue-on-error`).
- Press `←` `→` to select a card. Press `Enter` to expand full-screen. `Esc` to go back.
- Press `q` to quit.

**Why this is the lead demo:** It's self-contained. No piping, no config. One command, instant value. The horizontal layout makes the workflow *visible* — you see where you are, what passed, what failed, at a glance.

---

### Scenario 2: AI Agent / Workflow Traces

```
my-agent run --task "refactor auth module" | htui --chunk-by blank
```

Agent output is naturally chunked — thinking, tool calls, results, retries, final answer. Each chunk separated by blank lines becomes a card:

```
┌─────────────┬─────────────┬─────────────┬─────────────┬─────────────┐
│ 🔍 Think     │ 📂 Read      │ 🔍 Think     │ ✏️ Edit      │ ✅ Done      │
│─────────────│─────────────│─────────────│─────────────│─────────────│
│ I need to   │ auth.ts     │ The current │ auth.ts     │ Refactored  │
│ understand  │ 45 lines    │ impl uses   │ -old code   │ auth module │
│ the current │ imports:    │ callbacks.  │ +new code   │ to async/   │
│ auth flow   │  express    │ Should move │ +new code   │ await.      │
│ first...    │  jwt        │ to async/   │             │ 3 files     │
│             │  bcrypt     │ await...    │             │ changed.    │
│─────────────│─────────────│─────────────│─────────────│─────────────│
│ step 1/5    │ step 2/5    │ step 3/5    │ step 4/5    │ step 5/5    │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────────┘
```

- Each agent step is a card. You see the full reasoning chain at a glance.
- Scroll left to revisit earlier steps. Expand any card for full detail.
- Auto-follow mode keeps the newest step visible as the agent works.

**Why this is the strongest wedge:** Agent traces are long, sequential, and phase-based. Vertical scrolling buries earlier steps. Horizontal flow makes the entire chain visible — like a storyboard of what the agent did. No tool does this today.

---

### Scenario 3: Pipe Mode (the flexible tool)

```
npm run build 2>&1 | htui
```

Output streams **down** within a card. When the card fills the terminal height, it drifts left and a new card starts filling:

```
     page full → drifts left        currently filling ↓
┌─────────────┬─────────────┬─────────────┐
│ Compiling   │ Compiling   │ Bundle size:│
│ src/index.ts│ src/app.ts  │ 42kb        │
│ Compiling   │ Compiling   │ ✓ Build     │
│ src/utils.ts│ src/routes  │ complete    │
│ Compiling   │ Compiling   │ ▌           │
│ src/auth.ts │ src/db.ts   │             │
│ Compiling   │ Bundling... │             │
│ src/api.ts  │ Optimizing..│             │
│─────────────│─────────────│─────────────│
│ page 1      │ page 2      │ page 3 ▸    │
└─────────────┴─────────────┴─────────────┘
```

- Within each card, it's a **normal terminal** — you read top to bottom.
- The horizontal flow only kicks in when you run out of vertical space.
- It's **pagination**, not fragmentation. Normal reading, just laid out in pages.

For denser output, switch to time-based chunking:

```
tail -f app.log | htui --chunk-by time --interval 5s
```

```
┌─────────────┬─────────────┬─────────────┬─────────────┐
│ 10:00:00    │ 10:00:05    │ 10:00:10    │ 10:00:15    │
│─────────────│─────────────│─────────────│─────────────│
│ GET /api 200│ POST /  201 │ GET /api 200│ ERR db      │
│ GET /    200│ GET /img 200│ PUT /usr 200│  timeout    │
│ GET /css 200│             │ GET /api 200│ GET /api 500│
│─────────────│─────────────│─────────────│─────────────│
│ 3 requests  │ 2 requests  │ 3 requests  │ 2 req ⚠ 1err│
└─────────────┴─────────────┴─────────────┴─────────────┘
```

Each card gets a **summary footer** — count, error count, timing. You spot the problem column (10:00:15) instantly because it's a spatial position, not buried in scroll.

---

## Chunking Strategies

Chunking controls what triggers a new card (page turn):

| Mode                                 | New card when...                     |
| ------------------------------------ | ------------------------------------ |
| *(pipe default)*                     | Terminal height is filled (page-fill)|
| `--chunk-by blank`                   | Blank line in output                 |
| `--chunk-by time --interval 5s`      | Time interval elapses                |
| `--chunk-by regex --pattern "^Step"` | Pattern matches a line               |
| *(run mode)*                         | Each command gets its own card        |

---

## Keyboard & Mouse Interaction

| Key          | Action                              |
| ------------ | ----------------------------------- |
| `←` `→`     | Scroll horizontally                 |
| `Enter`      | Expand selected card full-screen    |
| `Esc`        | Back to horizontal view             |
| `f`          | Toggle auto-follow (stick to newest)|
| `q`          | Quit                                |
| Mouse wheel  | Horizontal scroll                   |

---

## Dynamic Layout

- Column width and count adapt to terminal width (`process.stdout.columns`)
- Card height fills terminal height (`process.stdout.rows`)
- On resize, re-renders and re-paginates immediately
- If a chunk has more lines than terminal height, the card gets its own vertical scroll indicator

---

## How HTUI Differs From Existing Tools

Existing tools solve adjacent problems, but none focus on this interaction model — horizontally paged output as a reading and navigation paradigm:

| Existing Tool  | What it does                         | How HTUI differs                          |
| -------------- | ------------------------------------ | ----------------------------------------- |
| tmux           | Side-by-side terminal panes          | Static split, not flowing timeline        |
| concurrently   | Parallel command output interleaved  | Still vertical, just colored              |
| multitail      | Tail multiple files side-by-side     | Static columns, not horizontal flow       |
| less -S        | Horizontal scroll for wide lines     | Still vertical line flow                  |
| **htui**       | **Horizontally paged output cards**  | **The flow direction is the feature**     |

---

## Scope: v0.1 MVP

### What's in v0.1

| Feature                               | Details                             |
| ------------------------------------- | ----------------------------------- |
| `htui run "cmd1" "cmd2" ...`          | Run mode — the killer demo          |
| `command \| htui`                     | Pipe mode with page-fill chunking   |
| `--chunk-by time --interval Ns`       | Time-based chunking                 |
| `←` `→` arrow key scroll             | Horizontal navigation               |
| `Enter` expand / `Esc` back          | Card detail view                    |
| `f` auto-follow                       | Stick to newest card                |
| `q` quit                              | Exit                                |
| Dynamic resize                        | Adapts to terminal rows & cols      |

### What's NOT in v0.1

| Deferred feature                      | Why                                  |
| ------------------------------------- | ------------------------------------ |
| `--chunk-by regex`                    | Not needed to prove the concept      |
| Mouse wheel scroll                    | Arrow keys sufficient for MVP        |
| Card themes / colors                  | Polish, not core                     |
| Parallel run mode                     | Sequential is enough first           |
| Export to HTML / image                | Feature creep                        |
| VS Code extension                     | CLI-first, editor-later              |
| Search within cards                   | Power-user feature                   |

---

## Roadmap

### v0.1 — MVP
- [ ] `htui run "cmd1" "cmd2" ...` (sequential, status + duration per card)
- [ ] Pipe mode: `command | htui` (page-fill default)
- [ ] `--chunk-by time --interval Ns`
- [ ] Horizontal rendering with raw ANSI escape codes
- [ ] Arrow key scrolling + card expand/collapse
- [ ] Auto-follow mode (`f` toggle)
- [ ] Dynamic terminal resize handling

### v0.2 — Chunking & Polish
- [ ] `--chunk-by blank`
- [ ] `--chunk-by regex --pattern "..."`
- [ ] Mouse wheel horizontal scroll
- [ ] Card summary footers
- [ ] Color/theme support
- [ ] Card borders and styling

### v0.3 — Run Mode Enhancements
- [ ] `--continue-on-error` flag
- [ ] Parallel run mode (`htui run --parallel "cmd1" "cmd2"`)
- [ ] Per-card status badges and severity coloring

### v1.0 — Stable Release
- [ ] Full test coverage
- [ ] Cross-platform verified (macOS, Linux, Windows)
- [ ] Published to npm
- [ ] Selection and expand UX polished

### Future
- [ ] VS Code extension (`htui-vscode`)
- [ ] Search within cards
- [ ] Export timeline as HTML/image
- [ ] AI agent trace mode (auto-detect chunking from agent output patterns)
