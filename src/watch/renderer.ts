/**
 * Purpose-built renderer for `htui watch` mode.
 *
 * Produces a full-frame paint of horizontally flowing cards with rounded
 * corners, a chrome header with connection pill, a position strip, and a
 * hint bar. Animation state is read from `WatchState.anim` — the controller
 * is responsible for scheduling re-renders when animations need to advance.
 */

import { Terminal, Style } from '../terminal.js';
import type { CardStatus, StreamType } from '../cards/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DisplayCard {
  cardId: string;
  title: string;
  status: CardStatus;
  exitCode?: number;
  startedAt: number;
  finishedAt?: number;
  signal?: string;
  cwd: string;
  tag?: string;
  lines: Array<{ text: string; stream: StreamType }>;
  stdoutTotal: number;
  stderrTotal: number;
  stdoutDropped?: number;
  stderrDropped?: number;
  /** Vertical scroll offset within expanded view. */
  scrollOffset: number;
  /** ms timestamp when this card was appended to state (for new-card anim). */
  createdAtLocal: number;
}

export type ConnState =
  | 'connecting'
  | 'waiting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface WatchAnimState {
  newCards: Map<string, number>;
  pulses: Map<string, { start: number; status: CardStatus }>;
  fade: { dir: 0 | 1 | -1; start: number } | null;
}

export interface WatchFilter {
  open: boolean;
  buf: string;
  committed: string | null;
}

export interface WatchState {
  conn: ConnState;
  connectedWorkspace: string | null;
  cards: DisplayCard[];
  selectedCardIdx: number;
  expandedCardIdx: number | null;
  autoFollow: boolean;
  filter: WatchFilter;
  scrollOffset: number;
  nextRetryInMs: number | null;
  permissionDenied: boolean;
  slowConsumerToastUntil: number | null;
  sessionChangedToastUntil: number | null;
  reconnectToastUntil: number | null;
  spinnerFrame: number;
  anim: WatchAnimState;
  now: number;
}

export interface WatchRendererOpts {
  terminal: Terminal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const GL = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Visible length (stripping ANSI escapes). */
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length;
}

function padRight(s: string, width: number): string {
  const vl = visLen(s);
  if (vl >= width) return s;
  return s + ' '.repeat(width - vl);
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return s.slice(0, width - 1) + '…';
}

/** Middle-ellipsis truncation. */
function midEllipsis(s: string, width: number): string {
  if (s.length <= width) return s;
  if (width <= 3) return s.slice(0, width);
  const keep = width - 1;
  const left = Math.ceil(keep / 2);
  const right = keep - left;
  return s.slice(0, left) + '…' + s.slice(s.length - right);
}

function cardStatusIcon(status: CardStatus, spinnerIdx: number): string {
  switch (status) {
    case 'queued':  return '◦';
    case 'active':  return SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
    case 'done':    return '✔';
    case 'failed':  return '✘';
    case 'killed':  return '⊘';
    case 'timeout': return '⏱';
    case 'error':   return '✘';
  }
}

function statusLabel(status: CardStatus): string {
  return status;
}

function statusColor(status: CardStatus): (s: string) => string {
  switch (status) {
    case 'done':    return Style.statusDone;
    case 'failed':  return Style.statusFailed;
    case 'error':   return Style.statusFailed;
    case 'active':  return Style.statusActive;
    case 'queued':  return Style.statusQueued;
    case 'killed':  return Style.statusKilled;
    case 'timeout': return Style.statusFailed;
  }
}

function durationStr(card: DisplayCard, now: number): string {
  if (!card.startedAt) return '';
  const end = card.finishedAt ?? now;
  const ms = Math.max(0, end - card.startedAt);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class WatchRenderer {
  private readonly terminal: Terminal;

  constructor(opts: WatchRendererOpts) {
    this.terminal = opts.terminal;
  }

  dispose(): void {
    /* no-op; timers live in the controller */
  }

  render(state: WatchState): void {
    const { cols, rows } = this.terminal.size;
    this.terminal.beginFrame();
    // Clear + home.
    this.terminal.write('\x1b[2J\x1b[H');

    if (cols < 40 || rows < 6) {
      this.renderTooSmall(cols, rows);
      this.terminal.endFrame();
      return;
    }

    const dimAll = this.computeDim(state);

    if (state.expandedCardIdx !== null && state.cards[state.expandedCardIdx]) {
      this.renderExpanded(state, state.cards[state.expandedCardIdx], cols, rows, dimAll);
      this.terminal.endFrame();
      return;
    }

    this.renderHeader(state, cols, dimAll);

    const hasSeparator = rows >= 14;
    if (hasSeparator) {
      this.terminal.moveTo(0, 1);
      this.terminal.write(Style.surface(GL.h.repeat(cols)));
    }

    const hasPositionStrip = rows >= 10;
    const hasHintBar = true;

    const topStart = hasSeparator ? 2 : 1;
    const bottomReserve = (hasHintBar ? 1 : 0) + (hasPositionStrip ? 1 : 0);
    const cardAreaRows = rows - topStart - bottomReserve;

    const visible = this.getVisibleCards(state, cols);

    if (visible.cards.length === 0) {
      this.renderOverlay(state, cols, rows, dimAll);
    } else if (cardAreaRows >= 4) {
      this.renderCardRow(state, visible, cols, topStart, cardAreaRows, dimAll);
    }

    // Filter prompt replaces the position strip.
    if (state.filter.open) {
      if (hasPositionStrip) {
        this.renderFilterPrompt(state, cols, rows - 2);
      } else {
        this.renderFilterPrompt(state, cols, rows - 1);
      }
    } else if (hasPositionStrip) {
      this.renderPositionStrip(state, visible, cols, rows - 2, dimAll);
    }

    if (hasHintBar) {
      this.renderBottomBar(state, cols, rows - 1, dimAll);
    }

    this.terminal.endFrame();
  }

  // ─── Dim / fade ────────────────────────────────────────────────────────

  private computeDim(state: WatchState): boolean {
    if (state.conn === 'disconnected' || state.conn === 'reconnecting') return true;
    if (state.anim.fade && state.anim.fade.dir === -1) return true;
    return false;
  }

  // ─── Header ────────────────────────────────────────────────────────────

  private renderHeader(state: WatchState, cols: number, dim: boolean): void {
    this.terminal.moveTo(0, 0);

    const left = ` ${Style.accent('htui')} ${Style.textMuted('─')} ${Style.text('watch')}`;
    const leftPlain = ' htui ─ watch';

    const ws = state.connectedWorkspace ?? '';
    const wsMax = Math.max(10, Math.min(40, Math.floor(cols / 3)));
    const wsTrunc = midEllipsis(ws, wsMax);
    const wsStyled = ws ? `   ${Style.textMuted(wsTrunc)}` : '';
    const wsPlainLen = ws ? 3 + wsTrunc.length : 0;

    const pillText = this.connectionPillText(state);
    const pillStr = this.connectionPill(state);
    const pillPlainLen = pillText.length;

    const nFiltered = this.filteredCount(state);
    const nTotal = state.cards.length;
    const countStr =
      state.filter.committed !== null
        ? Style.statusActive(`  ${nFiltered}/${nTotal} cards`)
        : Style.textMuted(`  ${nTotal} cards`);
    const countPlainLen =
      state.filter.committed !== null
        ? 2 + String(nFiltered).length + 1 + String(nTotal).length + 6
        : 2 + String(nTotal).length + 6;

    const follow = state.autoFollow ? `  ${Style.accent('▶ follow')}` : `  ${Style.textMuted('⏸ paused')}`;
    const followPlainLen = 2 + (state.autoFollow ? '▶ follow'.length : '⏸ paused'.length);

    const rightTag = `   ${Style.accentDim('agent')}   `;
    const rightPlainLen = 3 + 'agent'.length + 3;

    // Flex gap between left block and pill+count+follow+right.
    const leftBlock = left + wsStyled;
    const leftBlockPlainLen = leftPlain.length + wsPlainLen;
    const rightBlock = pillStr + countStr + follow + rightTag;
    const rightBlockPlainLen = pillPlainLen + countPlainLen + followPlainLen + rightPlainLen;

    const gap = Math.max(2, cols - leftBlockPlainLen - rightBlockPlainLen);
    const headerLine = leftBlock + ' '.repeat(gap) + rightBlock;

    this.terminal.write(dim ? Style.textMuted(this.stripColor(headerLine)) : headerLine);
  }

  /** Strip ANSI so we can recolor uniformly (used for dim mode). */
  private stripColor(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private connectionPillText(state: WatchState): string {
    switch (state.conn) {
      case 'connecting':   return '╭ ◌ connecting… ╮';
      case 'waiting':      return '╭ ◌ waiting… ╮';
      case 'connected':    return '╭ ● connected ╮';
      case 'reconnecting': return '╭ ◐ reconnecting… ╮';
      case 'disconnected': return '╭ ✕ disconnected ╮';
    }
  }

  private connectionPill(state: WatchState): string {
    const inner = this.connectionPillText(state).slice(1, -1); // strip outer braces
    switch (state.conn) {
      case 'connected':
        return Style.pill(inner, 'statusDone');
      case 'connecting':
      case 'waiting':
        return Style.pill(inner, 'statusQueued');
      case 'reconnecting':
        return Style.pill(inner, 'statusActive');
      case 'disconnected':
        return Style.pill(inner, 'statusFailed');
    }
  }

  private filteredCount(state: WatchState): number {
    if (state.filter.committed === null) return state.cards.length;
    const q = state.filter.committed.toLowerCase();
    return state.cards.filter((c) => c.title.toLowerCase().includes(q)).length;
  }

  // ─── Cards row ─────────────────────────────────────────────────────────

  private getVisibleCards(
    state: WatchState,
    cols: number,
  ): { cards: DisplayCard[]; indices: number[]; cardWidth: number; gutter: number; startIdx: number } {
    // Apply filter.
    const pool: Array<{ card: DisplayCard; idx: number }> = [];
    const q = state.filter.committed?.toLowerCase() ?? null;
    for (let i = 0; i < state.cards.length; i++) {
      const c = state.cards[i];
      if (q === null || c.title.toLowerCase().includes(q)) pool.push({ card: c, idx: i });
    }
    if (pool.length === 0) {
      return { cards: [], indices: [], cardWidth: 0, gutter: 1, startIdx: 0 };
    }

    const minW = 20;
    let maxN = Math.max(1, Math.floor((cols + 1) / (minW + 1)));
    let n = Math.min(maxN, pool.length);
    let gutter = 1;
    let cardWidth = n > 0 ? Math.floor((cols - (n - 1) * gutter) / n) : cols;
    if (cardWidth < minW) {
      gutter = 0;
      n = Math.max(1, Math.floor(cols / minW));
      n = Math.min(n, pool.length);
      cardWidth = n > 0 ? Math.floor(cols / n) : cols;
    }
    if (n === 1) cardWidth = cols;

    // Window selection: try to keep selected card visible.
    const selPoolIdx = pool.findIndex((p) => p.idx === state.selectedCardIdx);
    let start = Math.max(0, pool.length - n); // default: show the latest
    if (selPoolIdx >= 0) {
      if (selPoolIdx < start) start = selPoolIdx;
      else if (selPoolIdx >= start + n) start = selPoolIdx - n + 1;
    }
    if (state.autoFollow) start = Math.max(0, pool.length - n);

    const slice = pool.slice(start, start + n);
    return {
      cards: slice.map((p) => p.card),
      indices: slice.map((p) => p.idx),
      cardWidth,
      gutter,
      startIdx: start,
    };
  }

  private renderCardRow(
    state: WatchState,
    visible: { cards: DisplayCard[]; indices: number[]; cardWidth: number; gutter: number },
    cols: number,
    topRow: number,
    rowCount: number,
    dimAll: boolean,
  ): void {
    const bodyRows = Math.max(1, rowCount - 3); // top, footer, bottom
    const { cards, indices, cardWidth, gutter } = visible;

    // Precompute per-card rendering context.
    const ctxs = cards.map((c, i) =>
      this.buildCardContext(state, c, indices[i], cardWidth, bodyRows, dimAll),
    );

    // Top border.
    this.terminal.moveTo(0, topRow);
    for (let i = 0; i < ctxs.length; i++) {
      if (i > 0) this.terminal.write(' '.repeat(gutter));
      this.terminal.write(ctxs[i].topBorder);
    }
    // Body rows.
    for (let r = 0; r < bodyRows; r++) {
      this.terminal.moveTo(0, topRow + 1 + r);
      for (let i = 0; i < ctxs.length; i++) {
        if (i > 0) this.terminal.write(' '.repeat(gutter));
        this.terminal.write(ctxs[i].bodyRows[r]);
      }
    }
    // Footer row.
    this.terminal.moveTo(0, topRow + 1 + bodyRows);
    for (let i = 0; i < ctxs.length; i++) {
      if (i > 0) this.terminal.write(' '.repeat(gutter));
      this.terminal.write(ctxs[i].footer);
    }
    // Bottom border.
    this.terminal.moveTo(0, topRow + 2 + bodyRows);
    for (let i = 0; i < ctxs.length; i++) {
      if (i > 0) this.terminal.write(' '.repeat(gutter));
      this.terminal.write(ctxs[i].bottomBorder);
    }
  }

  private buildCardContext(
    state: WatchState,
    card: DisplayCard,
    cardIdx: number,
    cardWidth: number,
    bodyRows: number,
    dimAll: boolean,
  ): { topBorder: string; bodyRows: string[]; footer: string; bottomBorder: string } {
    const isSelected = cardIdx === state.selectedCardIdx;
    const isNew = state.anim.newCards.has(card.cardId)
      && state.now < (state.anim.newCards.get(card.cardId) ?? 0);
    const pulse = state.anim.pulses.get(card.cardId);
    const pulseActive =
      !!pulse && state.now - pulse.start < 600
      && Math.floor((state.now - pulse.start) / 150) % 2 === 0;

    const borderColor = (s: string): string => {
      if (dimAll) return Style.surface(s);
      if (isNew) return Style.surface(s);
      if (isSelected) return Style.accent(s);
      if (pulseActive) return statusColor(pulse!.status)(`\x1b[1m${s}\x1b[22m`);
      return Style.surface(s);
    };

    const innerWidth = Math.max(1, cardWidth - 2);

    // Top border.
    const top = GL.tl + GL.h.repeat(cardWidth - 2) + GL.tr;
    const topBorder = borderColor(top);

    // Header row (first body line) — embed ` icon title ` styling on body? Spec says card header is in body.
    // We'll put header as first body row.
    const icon = cardStatusIcon(card.status, state.spinnerFrame);
    const titleLine = ` ${icon} ${card.title}`;
    const titleTrunc = truncate(titleLine, innerWidth);
    const titleStyled = isSelected && !dimAll
      ? Style.accentBold(padRight(titleTrunc, innerWidth))
      : (isNew || dimAll
        ? Style.textMuted(padRight(titleTrunc, innerWidth))
        : Style.text(padRight(titleTrunc, innerWidth)));

    const bodyRowStrs: string[] = [];
    const v = borderColor(GL.v);
    bodyRowStrs.push(v + titleStyled + v);

    // Dropped notice at top if any.
    const visLines: Array<{ text: string; stream: StreamType; muted?: boolean }> = [];
    const droppedN = (card.stdoutDropped ?? 0) + (card.stderrDropped ?? 0);
    if (droppedN > 0) {
      visLines.push({
        text: `[dropped ${droppedN} earlier lines]`,
        stream: 'stdout',
        muted: true,
      });
    }
    for (const l of card.lines) visLines.push(l);

    // Show most recent (bodyRows - 2) content lines — reserve 1 for header, 1 gap.
    const contentRows = bodyRows - 1;
    const start = Math.max(0, visLines.length - contentRows);
    for (let r = 0; r < contentRows; r++) {
      const srcIdx = start + r;
      let inner: string;
      if (srcIdx < visLines.length) {
        const ln = visLines[srcIdx];
        const text = ' ' + truncate(ln.text, innerWidth - 1);
        const padded = padRight(text, innerWidth);
        if (dimAll || isNew) {
          inner = Style.textMuted(padded);
        } else if (ln.muted) {
          inner = Style.textMuted(padded);
        } else if (ln.stream === 'stderr') {
          inner = Style.statusFailed(padded);
        } else {
          inner = Style.text(padded);
        }
      } else {
        inner = ' '.repeat(innerWidth);
      }
      bodyRowStrs.push(v + inner + v);
    }

    // Footer border row: ` ● status          duration `
    const sIcon = '●';
    const sText = statusLabel(card.status);
    const dur = durationStr(card, state.now);
    const leftF = ` ${sIcon} ${sText}`;
    const rightF = dur ? `${dur} ` : ' ';
    const midLen = Math.max(1, innerWidth - leftF.length - rightF.length);
    const sc = dimAll || isNew ? Style.textMuted : statusColor(card.status);
    const footLeft = sc(truncate(leftF, innerWidth - rightF.length));
    const footRight = dimAll ? Style.textMuted(rightF) : Style.textMuted(rightF);
    const footerInner = footLeft + ' '.repeat(midLen) + footRight;
    // pad any remainder
    const footerInnerPadded = padRight(footerInner, innerWidth);
    const footer = v + footerInnerPadded + v;

    const bottom = GL.bl + GL.h.repeat(cardWidth - 2) + GL.br;
    const bottomBorder = borderColor(bottom);

    return { topBorder, bodyRows: bodyRowStrs, footer, bottomBorder };
  }

  // ─── Expanded view ─────────────────────────────────────────────────────

  private renderExpanded(
    state: WatchState,
    card: DisplayCard,
    cols: number,
    rows: number,
    dimAll: boolean,
  ): void {
    this.renderHeader(state, cols, dimAll);

    if (rows < 14) {
      // Still show hairline
    }
    this.terminal.moveTo(0, 1);
    this.terminal.write(Style.surface(GL.h.repeat(cols)));

    // Rounded border, top is accent.
    const topRow = 2;
    const bottomRow = rows - 2;
    const innerRows = Math.max(1, bottomRow - topRow - 2);
    const innerWidth = Math.max(1, cols - 2);

    const accentBorder = dimAll ? Style.surface : Style.accent;
    const dimBorder = Style.surface;

    // Top border with title.
    const icon = cardStatusIcon(card.status, state.spinnerFrame);
    const title = ` ${icon} ${card.title} `;
    const titleTrunc = truncate(title, Math.max(3, innerWidth - 2));
    const leftFill = Math.max(0, innerWidth - titleTrunc.length);
    const topLine =
      GL.tl + GL.h + titleTrunc + GL.h.repeat(Math.max(0, leftFill - 1)) + GL.tr;
    this.terminal.moveTo(0, topRow);
    this.terminal.write(accentBorder(topLine));

    // Body lines.
    const lines = card.lines;
    const totalL = lines.length;
    const scroll = Math.min(Math.max(0, card.scrollOffset), Math.max(0, totalL - innerRows));
    const canScrollUp = scroll > 0;
    const canScrollDown = scroll + innerRows < totalL;

    for (let r = 0; r < innerRows; r++) {
      this.terminal.moveTo(0, topRow + 1 + r);
      const srcIdx = scroll + r;
      const v = dimBorder(GL.v);
      let inner: string;
      if (srcIdx < totalL) {
        const ln = lines[srcIdx];
        let marker = '';
        if (r === 0 && canScrollUp) marker = Style.accent('▲');
        const prefix = marker ? marker + ' ' : '  ';
        const text = prefix + truncate(ln.text, innerWidth - prefix.length);
        const padded = padRight(text, innerWidth);
        inner =
          dimAll
            ? Style.textMuted(padded)
            : ln.stream === 'stderr'
              ? Style.statusFailed(padded)
              : Style.text(padded);
      } else {
        let trailing = '';
        if (r === innerRows - 1 && canScrollDown) trailing = Style.accent('▼');
        inner = padRight('  ' + trailing, innerWidth);
      }
      this.terminal.write(v + inner + v);
    }

    // Bottom border with status/duration.
    const statusLine = ` ${cardStatusIcon(card.status, state.spinnerFrame)} ${card.status}  ${durationStr(card, state.now)} `;
    const sTrunc = truncate(statusLine, Math.max(3, innerWidth - 2));
    const bottomFill = Math.max(0, innerWidth - sTrunc.length);
    const botLine =
      GL.bl + GL.h + sTrunc + GL.h.repeat(Math.max(0, bottomFill - 1)) + GL.br;
    this.terminal.moveTo(0, bottomRow);
    this.terminal.write(dimBorder(botLine));

    // Hint bar.
    this.renderBottomBar(state, cols, rows - 1, dimAll);
  }

  // ─── Position strip ────────────────────────────────────────────────────

  private renderPositionStrip(
    state: WatchState,
    visible: { cards: DisplayCard[]; indices: number[] },
    cols: number,
    row: number,
    dim: boolean,
  ): void {
    this.terminal.moveTo(0, row);
    const total = this.filteredPool(state).length;
    const selPos = visible.indices.indexOf(state.selectedCardIdx);
    const selDisplay = selPos >= 0 ? (this.filteredPool(state).findIndex((p) => p.idx === state.selectedCardIdx) + 1) : 0;

    const left = ` ${Style.textMuted('◀')} ${Style.text(String(selDisplay))}${Style.textMuted('/')}${Style.text(String(total))} ${Style.textMuted('▶')}`;
    const leftLen = 1 + 1 + 1 + String(selDisplay).length + 1 + String(total).length + 1 + 1;

    // Card dots — one per card in filtered pool, selection = ◉.
    const pool = this.filteredPool(state);
    const maxDots = Math.min(pool.length, Math.max(1, cols - leftLen - 4));
    const poolStart = Math.max(0, pool.length - maxDots);
    let dots = '';
    for (let i = poolStart; i < pool.length; i++) {
      const isSel = pool[i].idx === state.selectedCardIdx;
      const glyph = isSel ? Style.accent('◉') : Style.textMuted('●');
      dots += (i > poolStart ? ' ' : '') + glyph;
    }
    const dotsLen = (pool.length - poolStart) * 2 - 1;

    const gap = Math.max(1, cols - leftLen - dotsLen - 2);
    const line = left + ' '.repeat(gap) + dots + '  ';
    this.terminal.write(dim ? Style.textMuted(this.stripColor(line)) : line);
  }

  private filteredPool(state: WatchState): Array<{ card: DisplayCard; idx: number }> {
    const q = state.filter.committed?.toLowerCase() ?? null;
    const out: Array<{ card: DisplayCard; idx: number }> = [];
    for (let i = 0; i < state.cards.length; i++) {
      const c = state.cards[i];
      if (q === null || c.title.toLowerCase().includes(q)) out.push({ card: c, idx: i });
    }
    return out;
  }

  // ─── Filter prompt ─────────────────────────────────────────────────────

  private renderFilterPrompt(state: WatchState, cols: number, row: number): void {
    this.terminal.moveTo(0, row);
    const label = ` /filter: ${state.filter.buf}▌ `;
    const padded = padRight(label, cols);
    this.terminal.write(Style.bgGray + Style.white + padded + Style.reset);
  }

  // ─── Hint bar / toasts ─────────────────────────────────────────────────

  private renderBottomBar(state: WatchState, cols: number, row: number, dim: boolean): void {
    const now = state.now;
    if (state.slowConsumerToastUntil && now < state.slowConsumerToastUntil) {
      this.renderSlowToast(cols, row);
      return;
    }
    if (state.sessionChangedToastUntil && now < state.sessionChangedToastUntil) {
      this.renderSessionChangedToast(cols, row);
      return;
    }
    this.renderHintBar(state, cols, row, dim);
    if (state.reconnectToastUntil && now < state.reconnectToastUntil) {
      // Overlay a small footer toast right-aligned.
      const t = ` already connected `;
      this.terminal.moveTo(Math.max(0, cols - t.length - 1), row);
      this.terminal.write(Style.textMuted(t));
    }
  }

  private renderSlowToast(cols: number, row: number): void {
    this.terminal.moveTo(0, row);
    const pre = ` ${Style.statusFailed('⚠')} ${Style.text('dropped — watcher fell behind (16MB buffer).')}  `;
    const act = `${Style.bold}${Style.statusActive('r reconnect')}${Style.reset}   ${Style.textMuted('q quit')}`;
    const line = pre + act;
    this.terminal.write(padRight(line, cols));
  }

  private renderSessionChangedToast(cols: number, row: number): void {
    this.terminal.moveTo(0, row);
    const line = ` ${Style.statusActive('⚙ session changed — showing a different VS Code window')} `;
    this.terminal.write(padRight(line, cols));
  }

  private renderHintBar(state: WatchState, cols: number, row: number, dim: boolean): void {
    this.terminal.moveTo(0, row);
    const narrow = cols < 80;
    const sep = narrow ? ' ' : '    ';
    const dot = Style.textMuted('·');

    const k = (key: string) => Style.accentBold(key);
    const l = (lbl: string) => Style.textMuted(lbl);

    const segs: string[] = [];
    segs.push(`${k('←→')} ${l('nav')} ${dot} ${k('Enter')} ${l('expand')} ${dot} ${k('f')} ${l('follow')}`);
    segs.push(`${k('/')} ${l('filter')} ${dot} ${k('r')} ${l('reconnect')}`);
    segs.push(`${k('q')} ${l('quit')}`);

    let body = segs.join(sep);
    if (!narrow) {
      const tag = `${Style.accentDim('agent')}   `;
      const bodyPlainLen = visLen(body);
      const tagPlainLen = visLen(tag);
      const gap = Math.max(1, cols - bodyPlainLen - tagPlainLen - 2);
      body = ` ${body}${' '.repeat(gap)}${tag}`;
    } else {
      body = ' ' + body;
    }
    this.terminal.write(dim ? Style.textMuted(this.stripColor(body)) : padRight(body, cols));
  }

  // ─── Overlays (no cards) ───────────────────────────────────────────────

  private renderOverlay(state: WatchState, cols: number, rows: number, dim: boolean): void {
    const midY = Math.floor(rows / 2) - 1;

    let lines: string[];
    if (state.permissionDenied) {
      lines = [
        Style.statusFailed('⚠ cannot connect'),
        Style.text('Permission denied on agent IPC socket.'),
        Style.textMuted('Check that the agent was started by your user,'),
        Style.textMuted('not elevated or a different account.'),
      ];
    } else if (state.conn === 'connecting') {
      lines = [
        `${Style.accent('◌')} ${Style.text('starting htui watch')}`,
        Style.textMuted('connecting to agent session…'),
      ];
    } else if (state.conn === 'waiting') {
      const retry = state.nextRetryInMs === null
        ? ''
        : `retry ${(Math.max(0, state.nextRetryInMs) / 1000).toFixed(1)}s`;
      lines = [
        `${Style.accent('◌')} ${Style.text('waiting for agent')}`,
        Style.textMuted('No MCP session is running yet.'),
        `${Style.textMuted('Start the agent in VS Code, or run')} ${Style.accentBold('htui init')} ${Style.textMuted('if this is a fresh workspace.')}`,
        Style.textMuted(retry),
      ];
    } else if (state.conn === 'reconnecting') {
      lines = [
        `${Style.statusActive('◐')} ${Style.text('reconnecting…')}`,
        Style.textMuted('Lost connection to the agent — retrying.'),
      ];
    } else if (state.conn === 'disconnected') {
      lines = [
        `${Style.statusFailed('✕')} ${Style.text('disconnected')}`,
        Style.textMuted('The agent session ended.'),
        Style.textMuted('Press r to reconnect, q to quit.'),
      ];
    } else {
      lines = [
        `${Style.statusDone('●')} ${Style.text('connected')}`,
        Style.textMuted('Waiting for the agent to work.'),
        Style.textMuted('Cards will appear here as tools run.'),
      ];
    }

    for (let i = 0; i < lines.length; i++) {
      const plain = visLen(lines[i]);
      const x = Math.max(0, Math.floor((cols - plain) / 2));
      this.terminal.moveTo(x, midY + i);
      this.terminal.write(dim ? Style.textMuted(this.stripColor(lines[i])) : lines[i]);
    }
  }

  // ─── Too-small fallback ────────────────────────────────────────────────

  private renderTooSmall(cols: number, rows: number): void {
    const msg = 'htui watch — terminal too small (needs 40×10)';
    const y = Math.floor(rows / 2);
    const x = Math.max(0, Math.floor((cols - msg.length) / 2));
    this.terminal.moveTo(x, y);
    this.terminal.write(Style.textMuted(msg));
  }
}
