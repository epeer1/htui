/**
 * In-memory card store with bounded ring buffers, event subscriptions,
 * and search. No executor logic here — spawn/kill lives in `executor.ts`.
 */

import type {
  CardStatus,
  SearchMatch,
  Snapshot,
  StoreCard,
  StoreEvent,
  StreamType,
} from './types.js';

const TERMINAL_STATUSES: ReadonlySet<CardStatus> = new Set([
  'done',
  'failed',
  'killed',
  'timeout',
  'error',
]);

function isTerminal(s: CardStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

export interface CardStoreOptions {
  maxLinesPerStream?: number;
  maxCards?: number;
}

export interface CreateCardSpec {
  title: string;
  cwd: string;
  tag?: string;
  status?: CardStatus;
}

export interface ListFilter {
  status?: CardStatus | CardStatus[];
  limit?: number;
  sinceMs?: number;
}

export interface SearchQuery {
  pattern: string;
  regex?: boolean;
  ignoreCase?: boolean;
  stream?: StreamType;
  cardIds?: string[];
  limit?: number;
  contextLines?: number;
}

export interface StoreStats {
  total: number;
  active: number;
  done: number;
  failed: number;
  killed: number;
  timeout: number;
  error: number;
  queued: number;
}

type Subscriber = (evt: StoreEvent) => void;

export class CardStore {
  private readonly cards = new Map<string, StoreCard>();
  private readonly cardIds: string[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly maxLinesPerStream: number;
  private readonly maxCards: number;
  private seq = 0;
  private idCounter = 0;

  constructor(opts: CardStoreOptions = {}) {
    this.maxLinesPerStream = opts.maxLinesPerStream ?? 5000;
    this.maxCards = opts.maxCards ?? 200;
  }

  /** Active-card cap (independent of maxCards eviction of terminal cards). */
  private static readonly MAX_ACTIVE = 200;

  createCard(spec: CreateCardSpec): StoreCard {
    const status: CardStatus = spec.status ?? 'active';

    // Enforce active-card cap.
    const activeCount = this.countByStatus('active');
    if (status === 'active' && activeCount >= CardStore.MAX_ACTIVE) {
      const err = new Error('too-many-active') as Error & { code?: string };
      err.code = 'too-many-active';
      throw err;
    }

    // Evict oldest terminal card if total at cap.
    if (this.cardIds.length >= this.maxCards) {
      const evictIdx = this.findOldestTerminalIndex();
      if (evictIdx !== -1) {
        const evictedId = this.cardIds.splice(evictIdx, 1)[0];
        this.cards.delete(evictedId);
      }
      // else: allow growth past cap when only active cards remain.
    }

    const cardId = this.nextCardId();
    const card: StoreCard = {
      cardId,
      title: spec.title,
      status,
      cwd: spec.cwd,
      tag: spec.tag,
      startedAt: Date.now(),
      stdout: [],
      stderr: [],
      stdoutTotal: 0,
      stderrTotal: 0,
    };

    this.cards.set(cardId, card);
    this.cardIds.push(cardId);

    this.emit({
      t: 'card_created',
      seq: 0, // overwritten by emit
      cardId,
      title: card.title,
      status: card.status,
      startedAt: card.startedAt,
      cwd: card.cwd,
      tag: card.tag,
    });

    return card;
  }

  appendLine(cardId: string, stream: StreamType, text: string): void {
    const card = this.cards.get(cardId);
    if (!card) return;

    const bufKey = stream === 'stdout' ? 'stdout' : 'stderr';
    const totalKey = stream === 'stdout' ? 'stdoutTotal' : 'stderrTotal';
    const dropKey = stream === 'stdout' ? 'stdoutDropped' : 'stderrDropped';

    const buf = card[bufKey];

    if (buf.length >= this.maxLinesPerStream) {
      const evictCount = Math.floor(this.maxLinesPerStream / 2);
      buf.splice(0, evictCount);
      card[dropKey] = (card[dropKey] ?? 0) + evictCount;
      // firstKeptLine = lineNumber of the oldest line still in the buffer.
      // After eviction, buf has (maxLinesPerStream - evictCount) lines.
      // Those correspond to line numbers [total - buf.length, total - 1].
      const firstKeptLine = card[totalKey] - buf.length;
      this.emit({
        t: 'dropped',
        seq: 0,
        cardId,
        stream,
        count: evictCount,
        firstKeptLine,
      });
    }

    buf.push(text);
    const lineNumber = card[totalKey];
    card[totalKey] = lineNumber + 1;

    this.emit({
      t: 'card_output',
      seq: 0,
      cardId,
      stream,
      line: text,
      lineNumber,
    });
  }

  setStatus(
    cardId: string,
    status: CardStatus,
    exitCode?: number,
    signal?: string
  ): void {
    const card = this.cards.get(cardId);
    if (!card) return;

    card.status = status;
    if (exitCode !== undefined) card.exitCode = exitCode;
    if (signal !== undefined) card.signal = signal;

    if (isTerminal(status)) {
      card.finishedAt = Date.now();
      const durationMs = card.finishedAt - card.startedAt;
      this.emit({
        t: 'card_done',
        seq: 0,
        cardId,
        status,
        exitCode: card.exitCode,
        durationMs,
        totalLines: {
          stdout: card.stdoutTotal,
          stderr: card.stderrTotal,
        },
      });
    } else {
      this.emit({
        t: 'card_status',
        seq: 0,
        cardId,
        status,
        exitCode: card.exitCode,
        signal: card.signal,
      });
    }
  }

  get(cardId: string): StoreCard | undefined {
    return this.cards.get(cardId);
  }

  list(filter: ListFilter = {}): StoreCard[] {
    const statusFilter: Set<CardStatus> | null = filter.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : null;
    const cutoff =
      filter.sinceMs !== undefined ? Date.now() - filter.sinceMs : null;

    const out: StoreCard[] = [];
    for (const id of this.cardIds) {
      const card = this.cards.get(id);
      if (!card) continue;
      if (statusFilter && !statusFilter.has(card.status)) continue;
      if (cutoff !== null && card.startedAt < cutoff) continue;
      out.push(card);
    }

    if (filter.limit !== undefined && out.length > filter.limit) {
      return out.slice(-filter.limit);
    }
    return out;
  }

  search(query: SearchQuery): { matches: SearchMatch[]; truncated: boolean } {
    const limit = query.limit ?? 100;
    const contextLines = query.contextLines ?? 0;
    const streamFilter = query.stream;
    const cardFilter = query.cardIds ? new Set(query.cardIds) : null;

    const test = this.buildMatcher(query);
    const matches: SearchMatch[] = [];
    let truncated = false;

    outer: for (const id of this.cardIds) {
      if (cardFilter && !cardFilter.has(id)) continue;
      const card = this.cards.get(id);
      if (!card) continue;

      const streams: StreamType[] = streamFilter
        ? [streamFilter]
        : ['stdout', 'stderr'];

      for (const stream of streams) {
        const buf = stream === 'stdout' ? card.stdout : card.stderr;
        const total = stream === 'stdout' ? card.stdoutTotal : card.stderrTotal;
        // Lines in buf correspond to [total - buf.length, total - 1].
        const baseLine = total - buf.length;

        for (let i = 0; i < buf.length; i++) {
          const text = buf[i];
          if (!test(text)) continue;

          const match: SearchMatch = {
            cardId: card.cardId,
            title: card.title,
            lineNumber: baseLine + i,
            stream,
            text,
          };
          if (contextLines > 0) {
            match.before = buf.slice(Math.max(0, i - contextLines), i);
            match.after = buf.slice(i + 1, i + 1 + contextLines);
          }
          matches.push(match);
          if (matches.length >= limit) {
            truncated = true;
            break outer;
          }
        }
      }
    }

    return { matches, truncated };
  }

  /**
   * Returns the most recent 50 cards (by insertion order) with their full
   * current ring buffers. `sinceSeq` is reserved for a future event-replay
   * use case and is ignored for now.
   */
  snapshot(_sinceSeq?: number): Snapshot {
    const ids = this.cardIds.slice(-50);
    const cards: StoreCard[] = [];
    for (const id of ids) {
      const c = this.cards.get(id);
      if (c) cards.push(c);
    }
    return { seq: this.seq, cards };
  }

  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  stats(): StoreStats {
    const s: StoreStats = {
      total: this.cardIds.length,
      active: 0,
      done: 0,
      failed: 0,
      killed: 0,
      timeout: 0,
      error: 0,
      queued: 0,
    };
    for (const id of this.cardIds) {
      const c = this.cards.get(id);
      if (!c) continue;
      s[c.status]++;
    }
    return s;
  }

  private emit(event: StoreEvent): void {
    this.seq++;
    // Replace placeholder seq with the real monotonic value.
    (event as { seq: number }).seq = this.seq;
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // Swallow subscriber errors to isolate failures.
      }
    }
  }

  private nextCardId(): string {
    const id = `c_${this.idCounter.toString(36)}`;
    this.idCounter++;
    return id;
  }

  private countByStatus(status: CardStatus): number {
    let n = 0;
    for (const id of this.cardIds) {
      const c = this.cards.get(id);
      if (c && c.status === status) n++;
    }
    return n;
  }

  private findOldestTerminalIndex(): number {
    for (let i = 0; i < this.cardIds.length; i++) {
      const c = this.cards.get(this.cardIds[i]);
      if (c && isTerminal(c.status)) return i;
    }
    return -1;
  }

  private buildMatcher(query: SearchQuery): (text: string) => boolean {
    if (query.regex) {
      const flags = query.ignoreCase ? 'i' : '';
      const re = new RegExp(query.pattern, flags);
      return (t) => re.test(t);
    }
    if (query.ignoreCase) {
      const needle = query.pattern.toLowerCase();
      return (t) => t.toLowerCase().includes(needle);
    }
    const needle = query.pattern;
    return (t) => t.includes(needle);
  }
}
