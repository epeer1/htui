/**
 * Shared types for the card store subsystem.
 *
 * These types are used by the CardStore, the IPC/MCP layers, and any future
 * consumers of the store. They intentionally do NOT overlap with legacy
 * `src/card.ts`, which remains in place for run/pipe/wrap modes.
 */

export type CardStatus =
  | 'queued'
  | 'active'
  | 'done'
  | 'failed'
  | 'killed'
  | 'timeout'
  | 'error';

export type StreamType = 'stdout' | 'stderr';

export interface TaggedLine {
  text: string;
  stream: StreamType;
}

/** Card shape tracked by the store. */
export interface StoreCard {
  cardId: string;
  title: string;
  status: CardStatus;
  exitCode?: number;
  signal?: string;
  cwd: string;
  tag?: string;
  startedAt: number;
  finishedAt?: number;
  /** Current ring-buffer contents (may be shorter than all-time total). */
  stdout: string[];
  stderr: string[];
  /** All-time line counts (never decreases). */
  stdoutTotal: number;
  stderrTotal: number;
  /** Count of lines evicted from the ring buffer. */
  stdoutDropped?: number;
  stderrDropped?: number;
}

/** Server→client store events (mirrors architect §3 IPC message shapes). */
export type StoreEvent =
  | {
      t: 'card_created';
      seq: number;
      cardId: string;
      title: string;
      status: CardStatus;
      startedAt: number;
      cwd: string;
      tag?: string;
    }
  | {
      t: 'card_output';
      seq: number;
      cardId: string;
      stream: StreamType;
      line: string;
      lineNumber: number;
    }
  | {
      t: 'card_status';
      seq: number;
      cardId: string;
      status: CardStatus;
      exitCode?: number;
      signal?: string;
    }
  | {
      t: 'card_done';
      seq: number;
      cardId: string;
      status: CardStatus;
      exitCode?: number;
      durationMs: number;
      totalLines: { stdout: number; stderr: number };
    }
  | {
      t: 'dropped';
      seq: number;
      cardId: string;
      stream: StreamType;
      count: number;
      firstKeptLine: number;
    };

export interface Snapshot {
  seq: number;
  cards: StoreCard[];
}

export interface SearchMatch {
  cardId: string;
  title: string;
  lineNumber: number;
  stream: StreamType;
  text: string;
  before?: string[];
  after?: string[];
}
