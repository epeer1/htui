import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { ReadStream } from 'node:tty';

export interface TermSize {
  cols: number;
  rows: number;
}

export type KeyHandler = (key: string, raw: Buffer) => void;
export type ResizeHandler = (size: TermSize) => void;

/**
 * Low-level terminal controller.
 * Manages raw mode, alternate screen, input, and resize.
 * When stdin is piped, opens a separate TTY for keyboard input.
 */
export class Terminal {
  private keyHandlers: KeyHandler[] = [];
  private resizeHandlers: ResizeHandler[] = [];
  private ttyInput: ReadStream | null = null;
  private frameBuffer: string = '';
  private buffering = false;

  get size(): TermSize {
    return {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    };
  }

  /** Whether interactive keyboard input is available */
  get interactive(): boolean {
    return this._interactive;
  }
  private _interactive = true;

  /** Enter TUI mode: alternate screen, hide cursor, raw input */
  enter(): void {
    process.stdout.write('\x1b[?1049h'); // alternate screen
    process.stdout.write('\x1b[?25l');   // hide cursor

    // Get a TTY input stream — either stdin (if TTY) or open one
    const input = this.getTtyInput();
    if (input) {
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');

      input.on('data', (data: Buffer | string) => {
        const str = typeof data === 'string' ? data : data.toString();
        // Parse input into individual keystrokes
        const keystrokes = this.parseKeystrokes(str);
        for (const key of keystrokes) {
          const raw = Buffer.from(key);
          for (const handler of this.keyHandlers) {
            handler(key, raw);
          }
        }
      });
      this._interactive = true;
    } else {
      // Non-interactive mode (Windows pipe) — only handle Ctrl+C via SIGINT
      this._interactive = false;
      process.on('SIGINT', () => {
        for (const handler of this.keyHandlers) {
          handler(Keys.CTRL_C, Buffer.from(Keys.CTRL_C));
        }
      });
    }

    process.stdout.on('resize', () => {
      const size = this.size;
      for (const handler of this.resizeHandlers) {
        handler(size);
      }
    });
  }

  /** Exit TUI mode: restore screen, show cursor, cooked mode */
  exit(): void {
    process.stdout.write('\x1b[?25h');   // show cursor
    process.stdout.write('\x1b[?1049l'); // restore screen

    const input = this.ttyInput ?? (process.stdin.isTTY ? process.stdin : null);
    if (input && 'setRawMode' in input) {
      (input as ReadStream).setRawMode(false);
    }
    if (this.ttyInput) {
      this.ttyInput.destroy();
      this.ttyInput = null;
    } else {
      process.stdin.pause();
    }
  }

  /**
   * Parse a raw input string into individual keystrokes.
   * Handles escape sequences, control chars, and regular chars.
   */
  private parseKeystrokes(input: string): string[] {
    const keys: string[] = [];
    let i = 0;

    while (i < input.length) {
      // Escape sequence: \x1b[...
      if (input[i] === '\x1b' && input[i + 1] === '[') {
        // CSI sequence: \x1b[ followed by params and a letter
        let seq = '\x1b[';
        i += 2;
        while (i < input.length && input[i] >= '0' && input[i] <= '~') {
          seq += input[i];
          // End on a letter or ~
          if ((input[i] >= 'A' && input[i] <= 'Z') ||
              (input[i] >= 'a' && input[i] <= 'z') ||
              input[i] === '~') {
            i++;
            break;
          }
          i++;
        }
        keys.push(seq);
      }
      // Standalone escape
      else if (input[i] === '\x1b') {
        keys.push('\x1b');
        i++;
      }
      // Control characters and regular chars
      else {
        keys.push(input[i]);
        i++;
      }
    }

    return keys;
  }

  /**
   * Get a TTY stream for keyboard input.
   * If stdin is a TTY, use it directly.
   * If stdin is piped, open /dev/tty (Unix) for keyboard input.
   * On Windows with piped stdin, returns null (no interactive keyboard).
   */
  private getTtyInput(): ReadStream | null {
    if (process.stdin.isTTY) {
      return process.stdin as ReadStream;
    }

    // On Unix, open /dev/tty for keyboard input when stdin is piped
    if (process.platform !== 'win32') {
      try {
        const fd = fs.openSync('/dev/tty', fs.constants.O_RDONLY);
        this.ttyInput = new ReadStream(fd);
        return this.ttyInput;
      } catch {
        return null;
      }
    }

    // On Windows, we can't easily open the console input when stdin is piped.
    // Pipe mode will be non-interactive (auto-follow, Ctrl+C to exit).
    return null;
  }

  onKey(handler: KeyHandler): void {
    this.keyHandlers.push(handler);
  }

  onResize(handler: ResizeHandler): void {
    this.resizeHandlers.push(handler);
  }

  /** Start buffering — all writes go to the frame buffer instead of stdout */
  beginFrame(): void {
    this.frameBuffer = '';
    this.buffering = true;
  }

  /** Flush the frame buffer to stdout in a single write */
  endFrame(): void {
    this.buffering = false;
    if (this.frameBuffer) {
      process.stdout.write(this.frameBuffer);
      this.frameBuffer = '';
    }
  }

  private output(data: string): void {
    if (this.buffering) {
      this.frameBuffer += data;
    } else {
      process.stdout.write(data);
    }
  }

  /** Move cursor to (x, y) — 0-indexed */
  moveTo(x: number, y: number): void {
    this.output(`\x1b[${y + 1};${x + 1}H`);
  }

  /** Clear entire screen */
  clear(): void {
    this.output('\x1b[2J');
  }

  /** Write text at current cursor position */
  write(text: string): void {
    this.output(text);
  }

  /** Write text with attributes then reset */
  writeStyled(text: string, style: string): void {
    this.output(`${style}${text}\x1b[0m`);
  }
}

// ANSI style helpers
export const Style = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgGray: '\x1b[100m',
  white: '\x1b[37m',
  underline: '\x1b[4m',
  italic: '\x1b[3m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m',
  magenta: '\x1b[35m',
  brightWhite: '\x1b[97m',
} as const;

// Key constants
export const Keys = {
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  ENTER: '\r',
  ESCAPE: '\x1b',
  TAB: '\t',
  BACKSPACE: '\x7f',
  BACKSPACE_ALT: '\x08',
  DELETE: '\x1b[3~',
  Q: 'q',
  F: 'f',
  CTRL_C: '\x03',
} as const;
