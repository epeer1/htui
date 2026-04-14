import { Card, createCard } from './card.js';

export type ChunkMode = 'page-fill' | 'time' | 'blank';

export interface ChunkOptions {
  mode: ChunkMode;
  /** For time mode: interval in ms */
  interval?: number;
}

export type NewCardCallback = (card: Card) => void;
export type UpdateCallback = () => void;

/**
 * Chunker: takes incoming lines and distributes them into cards
 * based on the chunking strategy.
 */
export class Chunker {
  private cards: Card[];
  private options: ChunkOptions;
  private terminalRows: number;
  private onNewCard: NewCardCallback;
  private onUpdate: UpdateCallback;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lineBuffer = '';

  constructor(
    cards: Card[],
    options: ChunkOptions,
    terminalRows: number,
    onNewCard: NewCardCallback,
    onUpdate: UpdateCallback,
  ) {
    this.cards = cards;
    this.options = options;
    this.terminalRows = terminalRows;
    this.onNewCard = onNewCard;
    this.onUpdate = onUpdate;

    // Create initial card
    this.pushNewCard();

    // For time mode, create new cards on interval
    if (options.mode === 'time' && options.interval) {
      this.timer = setInterval(() => {
        this.pushNewCard();
        this.onUpdate();
      }, options.interval);
    }
  }

  /** Update terminal rows (on resize) */
  setTerminalRows(rows: number): void {
    this.terminalRows = rows;
  }

  /** Feed raw data from stdin */
  feed(data: string): void {
    this.lineBuffer += data;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      this.addLine(line.replace(/\r$/, ''));
    }
  }

  /** Flush any remaining buffered content */
  flush(): void {
    if (this.lineBuffer) {
      this.addLine(this.lineBuffer.replace(/\r$/, ''));
      this.lineBuffer = '';
    }
  }

  /** Clean up timers */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private addLine(line: string): void {
    const current = this.currentCard();

    switch (this.options.mode) {
      case 'page-fill': {
        // Reserve rows for header + footer
        const maxLines = this.terminalRows - 4;
        if (current.lines.length >= maxLines) {
          this.pushNewCard();
        }
        this.currentCard().lines.push(line);
        break;
      }
      case 'blank': {
        if (line.trim() === '' && current.lines.length > 0) {
          this.pushNewCard();
        } else if (line.trim() !== '') {
          current.lines.push(line);
        }
        break;
      }
      case 'time': {
        // In time mode, just add to current card (timer handles page turns)
        current.lines.push(line);
        break;
      }
    }

    this.onUpdate();
  }

  private currentCard(): Card {
    return this.cards[this.cards.length - 1];
  }

  private pushNewCard(): void {
    // Mark previous card as done
    if (this.cards.length > 0) {
      const prev = this.cards[this.cards.length - 1];
      if (prev.status === 'active') {
        prev.status = 'done';
        prev.finishedAt = Date.now();
      }
    }

    const pageNum = this.cards.length + 1;
    const title = this.options.mode === 'time'
      ? new Date().toLocaleTimeString()
      : `page ${pageNum}`;
    const card = createCard(title, 'active');
    card.startedAt = Date.now();
    this.cards.push(card);
    this.onNewCard(card);
  }
}
