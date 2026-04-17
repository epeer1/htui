import { Terminal, Keys } from './terminal.js';
import { Renderer } from './renderer.js';
import { Card, createCard, advanceSpinner } from './card.js';
import { runCommands } from './runner.js';
import { Chunker, ChunkOptions } from './chunker.js';
import { spawn, ChildProcess } from 'node:child_process';

export interface AppOptions {
  mode: 'run' | 'pipe' | 'wrap' | 'shell';
  commands?: string[];
  /** The command to wrap (for wrap mode) */
  wrapCommand?: string;
  chunkOptions?: ChunkOptions;
}

type InputMode = 'input' | 'browse';

/**
 * Main application: wires terminal, renderer, cards, and input together.
 */
export class App {
  private terminal: Terminal;
  private renderer: Renderer;
  private cards: Card[] = [];
  private scrollOffset = 0;
  private selectedIndex = 0;
  private autoFollow = true;
  private expandedCard: Card | null = null;
  private options: AppOptions;
  private renderQueued = false;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;

  // Shell mode state
  private shellMode: InputMode = 'input';
  private inputBuffer = '';
  private inputCursor = 0;
  private activeChild: ChildProcess | null = null;
  private commandHistory: string[] = [];
  private historyIndex = -1;

  constructor(options: AppOptions) {
    this.options = options;
    this.terminal = new Terminal();
    this.renderer = new Renderer(this.terminal);
  }

  async start(): Promise<void> {
    this.terminal.enter();
    this.setupInput();
    this.setupResize();

    // Start spinner animation for active cards
    this.spinnerInterval = setInterval(() => {
      const hasActive = this.cards.some(c => c.status === 'active');
      if (hasActive) {
        advanceSpinner();
        this.scheduleRender();
      }
    }, 80);

    try {
      if (this.options.mode === 'run') {
        await this.startRunMode();
      } else if (this.options.mode === 'wrap') {
        await this.startWrapMode();
      } else if (this.options.mode === 'shell') {
        await this.startShellMode();
      } else {
        await this.startPipeMode();
      }
    } catch (err) {
      this.terminal.exit();
      throw err;
    }
  }

  private setupInput(): void {
    this.terminal.onKey((key) => {
      // Ctrl+C always works
      if (key === Keys.CTRL_C) {
        if (this.options.mode === 'shell' && this.activeChild) {
          this.activeChild.kill();
          return;
        }
        this.quit();
        return;
      }

      if (this.expandedCard) {
        this.handleExpandedInput(key);
      } else if (this.options.mode === 'shell') {
        this.handleShellInput(key);
      } else {
        // q only quits in non-shell modes
        if (key === Keys.Q) {
          this.quit();
          return;
        }
        this.handleNormalInput(key);
      }
    });
  }

  private handleNormalInput(key: string): void {
    switch (key) {
      case Keys.LEFT:
        if (this.selectedIndex > 0) {
          this.selectedIndex--;
          this.autoFollow = false;
          this.adjustScroll();
          this.scheduleRender();
        }
        break;
      case Keys.RIGHT:
        if (this.selectedIndex < this.cards.length - 1) {
          this.selectedIndex++;
          this.adjustScroll();
          this.scheduleRender();
        }
        break;
      case Keys.ENTER:
        if (this.cards[this.selectedIndex]) {
          this.expandedCard = this.cards[this.selectedIndex];
          this.expandedCard.scrollOffset = 0;
          this.scheduleRender();
        }
        break;
      case Keys.F:
        this.autoFollow = !this.autoFollow;
        if (this.autoFollow) {
          this.selectedIndex = this.cards.length - 1;
          this.adjustScroll();
        }
        this.scheduleRender();
        break;
    }
  }

  private handleExpandedInput(key: string): void {
    const card = this.expandedCard!;
    const { rows } = this.terminal.size;
    const contentRows = rows - 4; // title + separator + bottom separator + hint bar

    switch (key) {
      case Keys.ESCAPE:
        this.expandedCard = null;
        this.scheduleRender();
        break;
      case Keys.UP:
        if (card.scrollOffset > 0) {
          card.scrollOffset--;
          this.scheduleRender();
        }
        break;
      case Keys.DOWN:
        if (card.scrollOffset < card.lines.length - contentRows) {
          card.scrollOffset++;
          this.scheduleRender();
        }
        break;
      case 'G':
        card.scrollOffset = Math.max(0, card.lines.length - contentRows);
        this.scheduleRender();
        break;
      case 'g':
        card.scrollOffset = 0;
        this.scheduleRender();
        break;
    }
  }

  private handleShellInput(key: string): void {
    if (this.shellMode === 'browse') {
      switch (key) {
        case Keys.TAB:
          this.shellMode = 'input';
          this.scheduleRender();
          break;
        case Keys.ESCAPE:
          this.shellMode = 'input';
          this.scheduleRender();
          break;
        case Keys.LEFT:
          if (this.selectedIndex > 0) {
            this.selectedIndex--;
            this.autoFollow = false;
            this.adjustScroll();
            this.scheduleRender();
          }
          break;
        case Keys.RIGHT:
          if (this.selectedIndex < this.cards.length - 1) {
            this.selectedIndex++;
            this.adjustScroll();
            this.scheduleRender();
          }
          break;
        case Keys.ENTER:
          if (this.cards[this.selectedIndex]) {
            this.expandedCard = this.cards[this.selectedIndex];
            this.expandedCard.scrollOffset = 0;
            this.scheduleRender();
          }
          break;
        case Keys.Q:
          this.quit();
          break;
      }
      return;
    }

    // Input mode
    switch (key) {
      case Keys.TAB:
        if (this.cards.length > 0) {
          this.shellMode = 'browse';
          this.scheduleRender();
        }
        break;
      case Keys.ENTER:
        this.submitShellCommand();
        break;
      case Keys.BACKSPACE:
      case Keys.BACKSPACE_ALT:
        if (this.inputCursor > 0) {
          this.inputBuffer =
            this.inputBuffer.slice(0, this.inputCursor - 1) +
            this.inputBuffer.slice(this.inputCursor);
          this.inputCursor--;
          this.scheduleRender();
        }
        break;
      case Keys.DELETE:
        if (this.inputCursor < this.inputBuffer.length) {
          this.inputBuffer =
            this.inputBuffer.slice(0, this.inputCursor) +
            this.inputBuffer.slice(this.inputCursor + 1);
          this.scheduleRender();
        }
        break;
      case Keys.LEFT:
        if (this.inputCursor > 0) {
          this.inputCursor--;
          this.scheduleRender();
        }
        break;
      case Keys.RIGHT:
        if (this.inputCursor < this.inputBuffer.length) {
          this.inputCursor++;
          this.scheduleRender();
        }
        break;
      case Keys.UP:
        // History navigation
        if (this.commandHistory.length > 0) {
          if (this.historyIndex < this.commandHistory.length - 1) {
            this.historyIndex++;
          }
          this.inputBuffer = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
          this.inputCursor = this.inputBuffer.length;
          this.scheduleRender();
        }
        break;
      case Keys.DOWN:
        if (this.historyIndex > 0) {
          this.historyIndex--;
          this.inputBuffer = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
          this.inputCursor = this.inputBuffer.length;
        } else {
          this.historyIndex = -1;
          this.inputBuffer = '';
          this.inputCursor = 0;
        }
        this.scheduleRender();
        break;
      default:
        // Regular character input (printable chars)
        if (key.length === 1 && key >= ' ') {
          this.inputBuffer =
            this.inputBuffer.slice(0, this.inputCursor) +
            key +
            this.inputBuffer.slice(this.inputCursor);
          this.inputCursor++;
          this.scheduleRender();
        }
        break;
    }
  }

  private submitShellCommand(): void {
    const command = this.inputBuffer.trim();
    if (!command) return;

    // Add to history
    this.commandHistory.push(command);
    this.historyIndex = -1;

    // Clear input
    this.inputBuffer = '';
    this.inputCursor = 0;

    // Handle built-in exit
    if (command === 'exit' || command === 'quit') {
      this.quit();
      return;
    }

    // Create a card for this command
    const card = createCard(command, 'active');
    card.startedAt = Date.now();
    this.cards.push(card);
    this.selectedIndex = this.cards.length - 1;
    this.autoFollow = true;
    this.adjustScroll();
    this.scheduleRender();

    // Spawn the command
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    this.activeChild = child;

    let lineBuffer = '';

    const processData = (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        card.lines.push(line.replace(/\r$/, ''));
        this.scheduleRender();
      }
    };

    child.stdout?.on('data', processData);
    child.stderr?.on('data', processData);

    child.on('close', (code) => {
      if (lineBuffer) {
        card.lines.push(lineBuffer.replace(/\r$/, ''));
      }
      card.exitCode = code ?? 1;
      card.finishedAt = Date.now();
      card.status = code === 0 ? 'done' : 'failed';
      this.activeChild = null;
      this.scheduleRender();
    });
  }

  private setupResize(): void {
    this.terminal.onResize(() => {
      this.adjustScroll();
      this.scheduleRender();
    });
  }

  private adjustScroll(): void {
    const { cols } = this.terminal.size;
    const minCardWidth = 20;
    const maxCardWidth = 60;
    const borderWidth = 1;
    const outerBorders = 2; // left and right outer │

    // Match renderer logic: cards expand up to maxCardWidth
    const availableWidth = cols - outerBorders;
    const maxFittable = Math.max(1, Math.floor((availableWidth + borderWidth) / (minCardWidth + borderWidth)));
    const actualVisible = Math.min(maxFittable, this.cards.length - this.scrollOffset);
    const visibleCount = Math.max(1, actualVisible);
    const cardWidth = Math.min(
      maxCardWidth,
      Math.floor((availableWidth - (visibleCount - 1) * borderWidth) / visibleCount),
    );
    const maxVisible = Math.max(1, Math.floor((availableWidth + borderWidth) / (cardWidth + borderWidth)));

    // Ensure selected card is visible
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.selectedIndex - maxVisible + 1;
    }

    this.scrollOffset = Math.max(0, this.scrollOffset);
  }

  /** Coalesce rapid render calls into one per frame */
  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    if (this.expandedCard) {
      this.renderer.renderExpanded(this.expandedCard);
    } else if (this.options.mode === 'shell') {
      this.renderer.renderShellCards(
        this.cards,
        this.scrollOffset,
        this.selectedIndex,
        this.autoFollow,
        this.inputBuffer,
        this.inputCursor,
        this.shellMode,
        this.activeChild !== null,
      );
    } else {
      this.renderer.renderCards(this.cards, this.scrollOffset, this.selectedIndex, this.autoFollow);
    }
  }

  private async startRunMode(): Promise<void> {
    const commands = this.options.commands ?? [];

    // Create all cards upfront
    for (const cmd of commands) {
      this.cards.push(createCard(cmd, 'queued'));
    }

    this.selectedIndex = 0;
    this.scheduleRender();

    // Run commands sequentially
    await runCommands(commands, this.cards, () => {
      if (this.autoFollow) {
        // Follow the active card
        const activeIdx = this.cards.findIndex(c => c.status === 'active');
        if (activeIdx >= 0) {
          this.selectedIndex = activeIdx;
        } else {
          // All done, select last
          this.selectedIndex = this.cards.length - 1;
        }
        this.adjustScroll();
      }
      this.scheduleRender();
    });

    // All done — wait for user to quit
    this.scheduleRender();
    await this.waitForQuit();
  }

  private async startPipeMode(): Promise<void> {
    const chunkOpts = this.options.chunkOptions ?? { mode: 'page-fill' };
    const { rows } = this.terminal.size;

    const chunker = new Chunker(
      this.cards,
      chunkOpts,
      rows,
      () => {
        // New card created
        if (this.autoFollow) {
          this.selectedIndex = this.cards.length - 1;
          this.adjustScroll();
        }
      },
      () => {
        // Content updated
        if (this.autoFollow) {
          this.selectedIndex = this.cards.length - 1;
          this.adjustScroll();
        }
        this.scheduleRender();
      },
    );

    // Update chunker on resize
    this.terminal.onResize((size) => {
      chunker.setTerminalRows(size.rows);
    });

    // Read stdin
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (data: string | Buffer) => {
      chunker.feed(data.toString());
    });

    process.stdin.on('end', () => {
      chunker.flush();
      chunker.destroy();
      // Mark last card as done
      if (this.cards.length > 0) {
        const last = this.cards[this.cards.length - 1];
        if (last.status === 'active') {
          last.status = 'done';
          last.finishedAt = Date.now();
        }
      }
      this.scheduleRender();

      // In non-interactive mode (Windows pipe), auto-exit after a brief display
      // so the terminal returns to normal
      if (!this.terminal.interactive) {
        setTimeout(() => this.quit(), 1000);
      }
    });

    await this.waitForQuit();
  }

  /**
   * Wrap mode: htui spawns the command itself, captures output into page-fill cards.
   * Since htui owns the process, stdin remains a TTY for keyboard input.
   * This is the cross-platform alternative to pipe mode.
   */
  private async startWrapMode(): Promise<void> {
    const command = this.options.wrapCommand!;
    const chunkOpts = this.options.chunkOptions ?? { mode: 'page-fill' };
    const { rows } = this.terminal.size;

    const chunker = new Chunker(
      this.cards,
      chunkOpts,
      rows,
      () => {
        if (this.autoFollow) {
          this.selectedIndex = this.cards.length - 1;
          this.adjustScroll();
        }
      },
      () => {
        if (this.autoFollow) {
          this.selectedIndex = this.cards.length - 1;
          this.adjustScroll();
        }
        this.scheduleRender();
      },
    );

    this.terminal.onResize((size) => {
      chunker.setTerminalRows(size.rows);
    });

    // Spawn the command as a child process
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => chunker.feed(data));
    child.stderr?.on('data', (data: string) => chunker.feed(data));

    child.on('close', () => {
      chunker.flush();
      chunker.destroy();
      if (this.cards.length > 0) {
        const last = this.cards[this.cards.length - 1];
        if (last.status === 'active') {
          last.status = 'done';
          last.finishedAt = Date.now();
        }
      }
      this.scheduleRender();
    });

    await this.waitForQuit();
  }

  private async startShellMode(): Promise<void> {
    this.shellMode = 'input';
    this.scheduleRender();
    await this.waitForQuit();
  }

  private waitForQuit(): Promise<void> {
    return new Promise((resolve) => {
      // The quit will be triggered by the key handler calling process.exit
      // This promise keeps the event loop alive
      const interval = setInterval(() => {}, 60000);
      process.on('exit', () => {
        clearInterval(interval);
        resolve();
      });
    });
  }

  private quit(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
    }
    this.terminal.exit();
    process.exit(0);
  }
}
