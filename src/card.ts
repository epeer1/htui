export interface TaggedLine {
  text: string;
  stream: 'stdout' | 'stderr';
}

export interface Card {
  /** Card title (command name, page number, timestamp) */
  title: string;
  /** Lines of output content */
  lines: string[];
  /** Lines tagged with stream origin */
  taggedLines: TaggedLine[];
  /** Card status */
  status: 'queued' | 'active' | 'done' | 'failed' | 'killed' | 'timeout' | 'blocked';
  /** Start time (ms since epoch) */
  startedAt?: number;
  /** End time (ms since epoch) */
  finishedAt?: number;
  /** Exit code for run mode */
  exitCode?: number;
  /** Working directory */
  cwd?: string;
  /** Signal that terminated the process */
  signal?: string;
  /** Vertical scroll offset within this card (for expand view) */
  scrollOffset: number;
}

export function createCard(title: string, status: Card['status'] = 'queued'): Card {
  return {
    title,
    lines: [],
    taggedLines: [],
    status,
    scrollOffset: 0,
  };
}

export function cardDuration(card: Card): string {
  if (!card.startedAt) return '';
  const end = card.finishedAt ?? Date.now();
  const ms = end - card.startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function cardStatusIcon(card: Card): string {
  switch (card.status) {
    case 'queued': return '◦';
    case 'active': return getSpinnerFrame();
    case 'done': return '✔';
    case 'failed': return '✘';
    case 'killed': return '⊘';
    case 'timeout': return '⏱';
    case 'blocked': return '⊘';
  }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;

export function getSpinnerFrame(): string {
  return SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
}

export function advanceSpinner(): void {
  spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
}
