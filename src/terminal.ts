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

// ---------------------------------------------------------------------------
// Color support detection + palette
// ---------------------------------------------------------------------------

export const supportsTruecolor: boolean = (function () {
  const v = process.env.COLORTERM;
  return v === 'truecolor' || v === '24bit' || process.env.FORCE_COLOR === '3';
})();

export const PALETTE = {
  accent:        [0x5F, 0xB3, 0xB3],
  statusDone:    [0x8F, 0xBF, 0x8F],
  statusFailed:  [0xD0, 0x8F, 0x8F],
  statusActive:  [0xD9, 0xB3, 0x82],
  statusQueued:  [0x7A, 0x8C, 0xA0],
  statusKilled:  [0x8A, 0x8A, 0x8A],
  bg:            [0x1A, 0x1C, 0x20],
  surface:       [0x3A, 0x3F, 0x47],
  textMuted:     [0x88, 0x91, 0xA0],
  text:          [0xD4, 0xD8, 0xDF],
} as const;

type PaletteRole = keyof typeof PALETTE;
type PillBgRole =
  | 'statusDone'
  | 'statusFailed'
  | 'statusActive'
  | 'statusQueued'
  | 'statusKilled'
  | 'bg';

/** 16-color fallback foreground codes keyed by palette role. */
const FG_FALLBACK: Record<PaletteRole, string> = {
  accent:       '\x1b[36m',           // cyan
  statusDone:   '\x1b[32m',           // green
  statusFailed: '\x1b[31m',           // red
  statusActive: '\x1b[33m',           // yellow
  statusQueued: '\x1b[34m',           // blue
  statusKilled: '\x1b[90m',           // gray
  bg:           '\x1b[30m',           // black fg
  surface:      '\x1b[90m',           // gray fg
  textMuted:    '\x1b[2m\x1b[37m',    // dim white
  text:         '\x1b[37m',           // white
};

/** 16-color fallback background codes keyed by palette role. */
const BG_FALLBACK: Record<PaletteRole, string> = {
  accent:       '\x1b[46m',           // bg cyan
  statusDone:   '\x1b[42m',           // bg green
  statusFailed: '\x1b[41m',           // bg red
  statusActive: '\x1b[43m',           // bg yellow
  statusQueued: '\x1b[44m',           // bg blue
  statusKilled: '\x1b[100m',          // bg gray
  bg:           '\x1b[40m',           // bg black
  surface:      '\x1b[100m',          // bg gray
  textMuted:    '\x1b[47m',           // bg white
  text:         '\x1b[107m',          // bg bright white
};

const RESET = '\x1b[0m';

/** 24-bit truecolor foreground; falls back to nearest 16-color cyan/etc. */
export function rgb(r: number, g: number, b: number): string {
  if (supportsTruecolor) return `\x1b[38;2;${r};${g};${b}m`;
  return nearest16Fg(r, g, b);
}

/** 24-bit truecolor background; falls back to nearest 16-color bg. */
export function bgRgb(r: number, g: number, b: number): string {
  if (supportsTruecolor) return `\x1b[48;2;${r};${g};${b}m`;
  return nearest16Bg(r, g, b);
}

function nearest16Fg(r: number, g: number, b: number): string {
  // Very rough 8-color fallback; accuracy isn't critical — semantic helpers
  // route through FG_FALLBACK for palette roles.
  const codes = [30, 31, 32, 33, 34, 35, 36, 37];
  const anchors: [number, number, number][] = [
    [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
    [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  ];
  let best = 7;
  let bestD = Infinity;
  for (let i = 0; i < 8; i++) {
    const [ar, ag, ab] = anchors[i];
    const d = (r - ar) ** 2 + (g - ag) ** 2 + (b - ab) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return `\x1b[${codes[best]}m`;
}

function nearest16Bg(r: number, g: number, b: number): string {
  const fg = nearest16Fg(r, g, b);
  // Shift 30-37 → 40-47.
  return fg.replace(/\x1b\[(\d+)m/, (_m, n) => `\x1b[${Number(n) + 10}m`);
}

function fgFor(role: PaletteRole): string {
  if (supportsTruecolor) {
    const [r, g, b] = PALETTE[role];
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  return FG_FALLBACK[role];
}

function bgFor(role: PaletteRole): string {
  if (supportsTruecolor) {
    const [r, g, b] = PALETTE[role];
    return `\x1b[48;2;${r};${g};${b}m`;
  }
  return BG_FALLBACK[role];
}

function wrap(role: PaletteRole, extra = ''): (s: string) => string {
  return (s: string) => `${extra}${fgFor(role)}${s}${RESET}`;
}

/** For pill bg roles, pick a contrasting fg palette role. */
const PILL_FG: Record<PillBgRole, PaletteRole> = {
  statusDone:   'bg',
  statusFailed: 'bg',
  statusActive: 'bg',
  statusQueued: 'text',
  statusKilled: 'text',
  bg:           'text',
};

// ANSI style helpers
export const Style = {
  reset: RESET,
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

  // --- Semantic palette helpers (wrap input + reset) ---
  accent:       wrap('accent'),
  accentBold:   wrap('accent', '\x1b[1m'),
  accentDim:    wrap('accent', '\x1b[2m'),

  statusDone:   wrap('statusDone'),
  statusFailed: wrap('statusFailed'),
  statusActive: wrap('statusActive'),
  statusQueued: wrap('statusQueued'),
  statusKilled: wrap('statusKilled'),

  surface:      wrap('surface'),
  textMuted:    wrap('textMuted'),
  text:         wrap('text'),

  pill(s: string, bgRole: PillBgRole): string {
    const fgRole = PILL_FG[bgRole];
    return `${bgFor(bgRole)}${fgFor(fgRole)}${s}${RESET}`;
  },
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
