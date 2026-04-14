import { Terminal, Style, TermSize } from './terminal.js';
import { Card, cardDuration, cardStatusIcon } from './card.js';

/**
 * Renders cards horizontally using ANSI escape codes with box-drawn borders.
 * Each card is a vertical column. Cards flow left-to-right.
 */
export class Renderer {
  constructor(private terminal: Terminal) {}

  /**
   * Render the horizontal card layout with box-drawn borders.
   */
  renderCards(
    cards: Card[],
    scrollOffset: number,
    selectedIndex: number,
    autoFollow: boolean,
  ): void {
    const { cols, rows } = this.terminal.size;
    this.terminal.beginFrame();
    this.terminal.clear();

    if (cards.length === 0) {
      this.renderEmptyState(cols, rows);
      this.terminal.endFrame();
      return;
    }

    // Layout budget: top border (1) + content + footer border (1) + bottom border (1) + separator (1) + hint bar (1) = 5 rows overhead
    const chromeRows = 5;
    const contentRows = rows - chromeRows;
    if (contentRows < 1) {
      this.terminal.endFrame();
      return;
    }

    const layout = this.calcCardLayout(cols, cards.length, scrollOffset);
    if (!layout) {
      this.terminal.endFrame();
      return;
    }
    const { cardWidth, finalVisibleCount, visibleCards } = this.getVisibleCards(layout, cards, scrollOffset);
    const contentWidth = cardWidth - 1; // 1 space left padding

    // Row 0: Top border with embedded titles
    this.terminal.moveTo(0, 0);
    for (let ci = 0; ci < visibleCards.length; ci++) {
      const card = visibleCards[ci];
      const cardIndex = scrollOffset + ci;
      const isSelected = cardIndex === selectedIndex;
      const borderStyle = this.getBorderStyle(card, isSelected);

      const corner = ci === 0 ? '┌' : '┬';
      this.terminal.writeStyled(corner + '─', borderStyle);

      const icon = cardStatusIcon(card);
      const titleText = ` ${icon} ${card.title} `;
      const maxTitleLen = cardWidth - 2;
      const displayTitle = titleText.length > maxTitleLen
        ? titleText.slice(0, maxTitleLen - 1) + '…'
        : titleText;
      const fillLen = cardWidth - displayTitle.length - 1;

      const titleStyle = this.getTitleStyle(card, isSelected);
      this.terminal.writeStyled(displayTitle, titleStyle);
      this.terminal.writeStyled('─'.repeat(Math.max(0, fillLen)), borderStyle);
    }
    {
      const lastCard = visibleCards[visibleCards.length - 1];
      const lastIsSelected = scrollOffset + visibleCards.length - 1 === selectedIndex;
      this.terminal.writeStyled('┐', this.getBorderStyle(lastCard, lastIsSelected));
    }

    // Rows 1..contentRows: Content
    for (let row = 0; row < contentRows; row++) {
      this.terminal.moveTo(0, row + 1);

      for (let ci = 0; ci < visibleCards.length; ci++) {
        const card = visibleCards[ci];
        const cardIndex = scrollOffset + ci;
        const isSelected = cardIndex === selectedIndex;
        const borderStyle = this.getBorderStyle(card, isSelected);

        this.terminal.writeStyled('│', borderStyle);

        const line = card.lines[row] ?? '';
        const displayLine = ' ' + truncateOrPad(line, contentWidth);

        if (isSelected) {
          this.terminal.write(displayLine);
        } else {
          this.terminal.writeStyled(displayLine, Style.dim);
        }
      }
      {
        const lastCard = visibleCards[visibleCards.length - 1];
        const lastIsSelected = scrollOffset + visibleCards.length - 1 === selectedIndex;
        this.terminal.writeStyled('│', this.getBorderStyle(lastCard, lastIsSelected));
      }
    }

    // Footer border row with embedded status + duration
    const footerRow = contentRows + 1;
    this.terminal.moveTo(0, footerRow);
    for (let ci = 0; ci < visibleCards.length; ci++) {
      const card = visibleCards[ci];
      const cardIndex = scrollOffset + ci;
      const isSelected = cardIndex === selectedIndex;
      const borderStyle = this.getBorderStyle(card, isSelected);

      const corner = ci === 0 ? '├' : '┼';
      this.terminal.writeStyled(corner + '─', borderStyle);

      const icon = cardStatusIcon(card);
      const dur = cardDuration(card);
      const statusText = ` ${icon} ${card.status} `;
      const durText = dur ? `${dur} ` : '';
      const midFill = cardWidth - statusText.length - durText.length - 1;

      const statusStyle = this.getStatusStyle(card);
      this.terminal.writeStyled(statusText, statusStyle);
      this.terminal.writeStyled('─'.repeat(Math.max(1, midFill)), borderStyle);
      if (dur) {
        this.terminal.writeStyled(durText, Style.dim);
      }
    }
    {
      const lastCard = visibleCards[visibleCards.length - 1];
      const lastIsSelected = scrollOffset + visibleCards.length - 1 === selectedIndex;
      this.terminal.writeStyled('┤', this.getBorderStyle(lastCard, lastIsSelected));
    }

    // Bottom border row
    const bottomRow = footerRow + 1;
    this.terminal.moveTo(0, bottomRow);
    for (let ci = 0; ci < visibleCards.length; ci++) {
      const card = visibleCards[ci];
      const cardIndex = scrollOffset + ci;
      const isSelected = cardIndex === selectedIndex;
      const borderStyle = this.getBorderStyle(card, isSelected);

      const corner = ci === 0 ? '└' : '┴';
      this.terminal.writeStyled(corner, borderStyle);
      this.terminal.writeStyled('─'.repeat(cardWidth), borderStyle);
    }
    {
      const lastCard = visibleCards[visibleCards.length - 1];
      const lastIsSelected = scrollOffset + visibleCards.length - 1 === selectedIndex;
      this.terminal.writeStyled('┘', this.getBorderStyle(lastCard, lastIsSelected));
    }

    // Separator with position indicator
    this.renderSeparatorWithPosition(cards, scrollOffset, selectedIndex, finalVisibleCount, cols, rows - 2);

    // Hint bar
    this.renderHintBar(cards, scrollOffset, selectedIndex, autoFollow, cols, rows - 1);
    this.terminal.endFrame();
  }

  /**
   * Render a single card expanded full-screen.
   */
  renderExpanded(card: Card): void {
    const { cols, rows } = this.terminal.size;
    this.terminal.beginFrame();
    this.terminal.clear();

    // Title bar with status-colored background
    this.terminal.moveTo(0, 0);
    const icon = cardStatusIcon(card);
    const dur = cardDuration(card);
    const titleLeft = ` ${icon} ${card.title}`;
    const titleRight = `${card.status}  ${dur ? dur + ' ' : ''}`;
    const titleGap = cols - titleLeft.length - titleRight.length;
    const titleBg = this.getExpandedTitleBg(card);

    this.terminal.writeStyled(titleLeft, titleBg + Style.bold);
    this.terminal.writeStyled(' '.repeat(Math.max(1, titleGap)), titleBg);
    this.terminal.writeStyled(titleRight, titleBg);

    // Separator
    this.terminal.moveTo(0, 1);
    this.terminal.writeStyled('─'.repeat(cols), Style.dim);

    // Content with line numbers
    const contentRows = rows - 4; // title + separator + bottom separator + hint bar
    const startLine = card.scrollOffset;
    const gutterWidth = 7; // "1234 │ "
    const lineContentWidth = cols - gutterWidth;

    for (let row = 0; row < contentRows; row++) {
      this.terminal.moveTo(0, row + 2);
      const lineIndex = startLine + row;
      if (lineIndex < card.lines.length) {
        const lineNum = String(lineIndex + 1).padStart(4, ' ');
        this.terminal.writeStyled(lineNum + ' │ ', Style.dim);
        const line = card.lines[lineIndex] ?? '';
        this.terminal.write(truncateOrPad(line, lineContentWidth));
      } else {
        this.terminal.writeStyled('     │', Style.dim);
        this.terminal.write(' '.repeat(Math.max(0, lineContentWidth + 1)));
      }
    }

    // Bottom separator
    this.terminal.moveTo(0, rows - 2);
    this.terminal.writeStyled('─'.repeat(cols), Style.dim);

    // Bottom hint bar
    const totalLines = card.lines.length;
    const endLine = Math.min(startLine + contentRows, totalLines);
    const scrollInfo = totalLines > 0
      ? `lines ${startLine + 1}-${endLine} of ${totalLines}`
      : 'empty';
    const hasMore = endLine < totalLines;

    this.terminal.moveTo(0, rows - 1);
    this.terminal.writeStyled(' '.repeat(cols), Style.bgGray);
    this.terminal.moveTo(0, rows - 1);
    this.terminal.writeStyled(' ', Style.bgGray);
    this.terminal.writeStyled('Esc', Style.bgGray + Style.bold + Style.white);
    this.terminal.writeStyled(' back  ', Style.bgGray + Style.white);
    this.terminal.writeStyled('↑↓', Style.bgGray + Style.bold + Style.white);
    this.terminal.writeStyled(' scroll  ', Style.bgGray + Style.white);
    this.terminal.writeStyled('G', Style.bgGray + Style.bold + Style.white);
    this.terminal.writeStyled(' end  ', Style.bgGray + Style.white);
    this.terminal.writeStyled('g', Style.bgGray + Style.bold + Style.white);
    this.terminal.writeStyled(' top', Style.bgGray + Style.white);

    // Right side: scroll info
    const rightText = `${scrollInfo}${hasMore ? ' ▼' : ''}  `;
    const hintUsed = 1 + 3 + 7 + 2 + 9 + 1 + 6 + 1 + 4;
    const hintGap = Math.max(1, cols - hintUsed - rightText.length);
    this.terminal.writeStyled(' '.repeat(hintGap), Style.bgGray);
    this.terminal.writeStyled(rightText, Style.bgGray + Style.white);
    this.terminal.endFrame();
  }

  /**
   * Render the shell mode layout: cards + input prompt at bottom.
   */
  renderShellCards(
    cards: Card[],
    scrollOffset: number,
    selectedIndex: number,
    autoFollow: boolean,
    inputBuffer: string,
    inputCursor: number,
    inputMode: 'input' | 'browse',
    isRunning: boolean,
  ): void {
    const { cols, rows } = this.terminal.size;
    this.terminal.beginFrame();
    this.terminal.clear();

    if (cards.length === 0) {
      this.renderShellEmptyState(cols, rows, inputBuffer, inputCursor, inputMode, isRunning);
      this.terminal.endFrame();
      return;
    }

    // Layout budget: top border (1) + content + footer border (1) + bottom border (1) + separator (1) + prompt (1) + hint bar (1) = 6 rows overhead
    const chromeRows = 6;
    const contentRows = rows - chromeRows;

    if (contentRows < 1) {
      this.renderShellPrompt(cols, rows, inputBuffer, inputCursor, inputMode, isRunning);
      this.terminal.endFrame();
      return;
    }

    const layout = this.calcCardLayout(cols, cards.length, scrollOffset);
    if (!layout) {
      this.renderShellPrompt(cols, rows, inputBuffer, inputCursor, inputMode, isRunning);
      this.terminal.endFrame();
      return;
    }
    const { cardWidth, finalVisibleCount, visibleCards } = this.getVisibleCards(layout, cards, scrollOffset);
    const contentWidth = cardWidth - 1;

    // Row 0: Top border with embedded titles
    this.terminal.moveTo(0, 0);
    for (let ci = 0; ci < visibleCards.length; ci++) {
      const card = visibleCards[ci];
      const cardIndex = scrollOffset + ci;
      const isSelected = cardIndex === selectedIndex && inputMode === 'browse';
      const borderStyle = this.getBorderStyle(card, isSelected);

      const corner = ci === 0 ? '┌' : '┬';
      this.terminal.writeStyled(corner + '─', borderStyle);

      const icon = cardStatusIcon(card);
      const titleText = ` ${icon} ${card.title} `;
      const maxTitleLen = cardWidth - 2;
      const displayTitle = titleText.length > maxTitleLen
        ? titleText.slice(0, maxTitleLen - 1) + '…'
        : titleText;
      const fillLen = cardWidth - displayTitle.length - 1;

      const titleStyle = this.getTitleStyle(card, isSelected);
      this.terminal.writeStyled(displayTitle, titleStyle);
      this.terminal.writeStyled('─'.repeat(Math.max(0, fillLen)), borderStyle);
    }
    {
      const lastCard = visibleCards[visibleCards.length - 1];
      const lastIsSelected = scrollOffset + visibleCards.length - 1 === selectedIndex && inputMode === 'browse';
      this.terminal.writeStyled('┐', this.getBorderStyle(lastCard, lastIsSelected));
    }

    // Content rows
    for (let row = 0; row < contentRows; row++) {
      this.terminal.moveTo(0, row + 1);

      for (let ci = 0; ci < visibleCards.length; ci++) {
        const card = visibleCards[ci];
        const cardIndex = scrollOffset + ci;
        const isSelected = cardIndex === selectedIndex && inputMode === 'browse';
        const borderStyle = this.getBorderStyle(card, isSelected);

        this.terminal.writeStyled('│', borderStyle);

        const line = card.lines[row] ?? '';
        const displayLine = ' ' + truncateOrPad(line, contentWidth);

        if (isSelected) {
          this.terminal.write(displayLine);
        } else {
          this.terminal.writeStyled(displayLine, inputMode === 'browse' ? Style.dim : '');
        }
      }
      {
        const lastCard = visibleCards[visibleCards.length - 1];
        const lastIsSelected = scrollOffset + visibleCards.length - 1 === selectedIndex && inputMode === 'browse';
        this.terminal.writeStyled('│', this.getBorderStyle(lastCard, lastIsSelected));
      }
    }

    // Footer border row
    const footerRow = contentRows + 1;
    this.terminal.moveTo(0, footerRow);
    for (let ci = 0; ci < visibleCards.length; ci++) {
      const card = visibleCards[ci];
      const cardIndex = scrollOffset + ci;
      const isSelected = cardIndex === selectedIndex && inputMode === 'browse';
      const borderStyle = this.getBorderStyle(card, isSelected);

      const corner = ci === 0 ? '├' : '┼';
      this.terminal.writeStyled(corner + '─', borderStyle);

      const icon = cardStatusIcon(card);
      const dur = cardDuration(card);
      const statusText = ` ${icon} ${card.status} `;
      const durText = dur ? `${dur} ` : '';
      const midFill = cardWidth - statusText.length - durText.length - 1;

      const statusStyle = this.getStatusStyle(card);
      this.terminal.writeStyled(statusText, statusStyle);
      this.terminal.writeStyled('─'.repeat(Math.max(1, midFill)), borderStyle);
      if (dur) {
        this.terminal.writeStyled(durText, Style.dim);
      }
    }
    {
      const lastCard = visibleCards[visibleCards.length - 1];
      const lastIsSelected = scrollOffset + visibleCards.length - 1 === selectedIndex && inputMode === 'browse';
      this.terminal.writeStyled('┤', this.getBorderStyle(lastCard, lastIsSelected));
    }

    // Bottom border row
    const bottomRow = footerRow + 1;
    this.terminal.moveTo(0, bottomRow);
    for (let ci = 0; ci < visibleCards.length; ci++) {
      const card = visibleCards[ci];
      const cardIndex = scrollOffset + ci;
      const isSelected = cardIndex === selectedIndex && inputMode === 'browse';
      const borderStyle = this.getBorderStyle(card, isSelected);

      const corner = ci === 0 ? '└' : '┴';
      this.terminal.writeStyled(corner, borderStyle);
      this.terminal.writeStyled('─'.repeat(cardWidth), borderStyle);
    }
    {
      const lastCard = visibleCards[visibleCards.length - 1];
      const lastIsSelected = scrollOffset + visibleCards.length - 1 === selectedIndex && inputMode === 'browse';
      this.terminal.writeStyled('┘', this.getBorderStyle(lastCard, lastIsSelected));
    }

    // Separator with position
    this.renderSeparatorWithPosition(cards, scrollOffset, selectedIndex, finalVisibleCount, cols, rows - 3);

    // Prompt
    this.renderShellPromptLine(cols, rows - 2, inputBuffer, inputCursor, inputMode, isRunning);

    // Hint bar
    this.renderShellHintBar(cols, rows - 1, cards, scrollOffset, selectedIndex, inputMode);
    this.terminal.endFrame();
  }

  // ─── Shared helpers ───

  private calcCardLayout(
    cols: number,
    cardCount: number,
    scrollOffset: number,
  ): { cardWidth: number; finalVisibleCount: number } | null {
    const minCardWidth = 20;
    const maxCardWidth = 60;
    const borderWidth = 1;
    const outerBorders = 2;

    const availableWidth = cols - outerBorders;
    const maxFittable = Math.max(1, Math.floor((availableWidth + borderWidth) / (minCardWidth + borderWidth)));
    const actualVisible = Math.min(maxFittable, cardCount - scrollOffset);
    const visibleCount = Math.max(1, actualVisible);
    const cardWidth = Math.min(
      maxCardWidth,
      Math.floor((availableWidth - (visibleCount - 1) * borderWidth) / visibleCount),
    );
    const maxVisibleCards = Math.max(1, Math.floor((availableWidth + borderWidth) / (cardWidth + borderWidth)));
    const finalVisibleCount = Math.min(maxVisibleCards, cardCount - scrollOffset);

    if (cardWidth < 5) return null;
    return { cardWidth, finalVisibleCount };
  }

  private getVisibleCards(
    layout: { cardWidth: number; finalVisibleCount: number },
    cards: Card[],
    scrollOffset: number,
  ): { cardWidth: number; finalVisibleCount: number; visibleCards: Card[] } {
    return {
      ...layout,
      visibleCards: cards.slice(scrollOffset, scrollOffset + layout.finalVisibleCount),
    };
  }

  private getBorderStyle(card: Card, isSelected: boolean): string {
    if (isSelected) return Style.cyan + Style.bold;
    if (card.status === 'active') return Style.yellow;
    return Style.dim;
  }

  private getTitleStyle(card: Card, isSelected: boolean): string {
    if (isSelected) return Style.bold + Style.cyan;
    if (card.status === 'active') return Style.bold + Style.yellow;
    return Style.bold + Style.white;
  }

  private getStatusStyle(card: Card): string {
    switch (card.status) {
      case 'done': return Style.green;
      case 'failed': return Style.red + Style.bold;
      case 'active': return Style.yellow + Style.bold;
      case 'blocked': return Style.magenta + Style.dim;
      case 'queued': return Style.dim;
      case 'killed': return Style.red + Style.dim;
      case 'timeout': return Style.red + Style.dim;
    }
  }

  private getExpandedTitleBg(card: Card): string {
    switch (card.status) {
      case 'done': return Style.bgGreen + Style.brightWhite + Style.bold;
      case 'failed': return Style.bgRed + Style.brightWhite + Style.bold;
      case 'active': return Style.bgYellow + Style.brightWhite + Style.bold;
      case 'queued':
      case 'blocked':
      case 'killed':
      case 'timeout': return Style.bgGray + Style.white + Style.bold;
    }
  }

  private renderSeparatorWithPosition(
    cards: Card[],
    scrollOffset: number,
    selectedIndex: number,
    visibleCount: number,
    cols: number,
    row: number,
  ): void {
    this.terminal.moveTo(0, row);

    const hasLeft = scrollOffset > 0;
    const hasRight = scrollOffset + visibleCount < cards.length;
    const posText = `${selectedIndex + 1}/${cards.length}`;

    let centerLen = posText.length;
    if (hasLeft) centerLen += 2;
    if (hasRight) centerLen += 2;

    const totalDashes = cols - centerLen - 2;
    const leftDashes = Math.floor(totalDashes / 2);
    const rightDashes = totalDashes - leftDashes;

    this.terminal.writeStyled('─'.repeat(Math.max(0, leftDashes)) + ' ', Style.dim);
    if (hasLeft) this.terminal.writeStyled('◂ ', Style.cyan + Style.bold);
    this.terminal.writeStyled(posText, Style.white);
    if (hasRight) this.terminal.writeStyled(' ▸', Style.cyan + Style.bold);
    this.terminal.writeStyled(' ' + '─'.repeat(Math.max(0, rightDashes)), Style.dim);
  }

  private renderHintBar(
    cards: Card[],
    scrollOffset: number,
    selectedIndex: number,
    autoFollow: boolean,
    cols: number,
    row: number,
  ): void {
    this.terminal.moveTo(0, row);
    this.terminal.writeStyled(' '.repeat(cols), Style.bgGray);
    this.terminal.moveTo(0, row);

    this.terminal.writeStyled(' ', Style.bgGray);
    this.terminal.writeStyled('←→', Style.bgGray + Style.bold + Style.white);
    this.terminal.writeStyled(' scroll  ', Style.bgGray + Style.white);
    this.terminal.writeStyled('enter', Style.bgGray + Style.bold + Style.white);
    this.terminal.writeStyled(' expand  ', Style.bgGray + Style.white);
    this.terminal.writeStyled('f', Style.bgGray + Style.bold + Style.white);
    this.terminal.writeStyled(' follow  ', Style.bgGray + Style.white);
    this.terminal.writeStyled('q', Style.bgGray + Style.bold + Style.white);
    this.terminal.writeStyled(' quit', Style.bgGray + Style.white);

    const autoText = autoFollow ? '  AUTO▸' : '';
    const rightText = `card ${selectedIndex + 1}/${cards.length}${autoText}  `;
    const hintUsed = 1 + 2 + 9 + 5 + 9 + 1 + 9 + 1 + 5;
    const gap = Math.max(1, cols - hintUsed - rightText.length);
    this.terminal.writeStyled(' '.repeat(gap), Style.bgGray);
    this.terminal.writeStyled(`card ${selectedIndex + 1}/${cards.length}`, Style.bgGray + Style.white);
    if (autoFollow) {
      this.terminal.writeStyled('  AUTO▸', Style.bgGray + Style.green + Style.bold);
    }
    this.terminal.writeStyled('  ', Style.bgGray);
  }

  private renderEmptyState(cols: number, rows: number): void {
    const boxLines = [
      '╭─────────────────────────╮',
      '│                         │',
      '│     h t u i             │',
      '│                         │',
      '│     waiting for input   │',
      '│                         │',
      '╰─────────────────────────╯',
    ];
    const boxWidth = 27;

    const startRow = Math.max(0, Math.floor(rows / 2) - 3);
    const startCol = Math.max(0, Math.floor((cols - boxWidth) / 2));

    for (let i = 0; i < boxLines.length; i++) {
      this.terminal.moveTo(startCol, startRow + i);
      if (i === 2) {
        this.terminal.writeStyled('│     ', Style.dim);
        this.terminal.writeStyled('h t u i', Style.bold + Style.cyan);
        this.terminal.writeStyled('             │', Style.dim);
      } else if (i === 4) {
        this.terminal.writeStyled('│     ', Style.dim);
        this.terminal.writeStyled('waiting for input', Style.dim);
        this.terminal.writeStyled('   │', Style.dim);
      } else {
        this.terminal.writeStyled(boxLines[i], Style.dim);
      }
    }
  }

  private renderShellEmptyState(
    cols: number,
    rows: number,
    inputBuffer: string,
    inputCursor: number,
    inputMode: 'input' | 'browse',
    isRunning: boolean,
  ): void {
    const boxLines = [
      '╭─────────────────────────╮',
      '│                         │',
      '│     h t u i             │',
      '│                         │',
      '│     type a command      │',
      '│                         │',
      '╰─────────────────────────╯',
    ];
    const boxWidth = 27;

    const cardAreaRows = rows - 3; // reserve prompt area
    const startRow = Math.max(0, Math.floor(cardAreaRows / 2) - 3);
    const startCol = Math.max(0, Math.floor((cols - boxWidth) / 2));

    for (let i = 0; i < boxLines.length; i++) {
      if (startRow + i >= cardAreaRows) break;
      this.terminal.moveTo(startCol, startRow + i);
      if (i === 2) {
        this.terminal.writeStyled('│     ', Style.dim);
        this.terminal.writeStyled('h t u i', Style.bold + Style.cyan);
        this.terminal.writeStyled('             │', Style.dim);
      } else if (i === 4) {
        this.terminal.writeStyled('│     ', Style.dim);
        this.terminal.writeStyled('type a command', Style.dim);
        this.terminal.writeStyled('      │', Style.dim);
      } else {
        this.terminal.writeStyled(boxLines[i], Style.dim);
      }
    }

    this.renderShellPrompt(cols, rows, inputBuffer, inputCursor, inputMode, isRunning);
  }

  private renderShellPrompt(
    cols: number,
    rows: number,
    inputBuffer: string,
    inputCursor: number,
    inputMode: 'input' | 'browse',
    isRunning: boolean,
  ): void {
    // Separator
    this.terminal.moveTo(0, rows - 3);
    this.terminal.writeStyled('─'.repeat(cols), Style.dim);

    // Prompt line
    this.renderShellPromptLine(cols, rows - 2, inputBuffer, inputCursor, inputMode, isRunning);

    // Hint bar
    this.renderShellHintBar(cols, rows - 1, [], 0, 0, inputMode);
  }

  private renderShellPromptLine(
    cols: number,
    row: number,
    inputBuffer: string,
    inputCursor: number,
    inputMode: 'input' | 'browse',
    isRunning: boolean,
  ): void {
    this.terminal.moveTo(0, row);
    const prompt = isRunning ? '  running... ' : '❯ ';
    const promptLen = prompt.length;
    const inputWidth = cols - promptLen;

    if (isRunning) {
      this.terminal.writeStyled(truncateOrPad(prompt, cols), Style.yellow);
    } else {
      this.terminal.writeStyled(prompt, Style.green + Style.bold);
      const displayBuffer = inputBuffer.length > inputWidth
        ? inputBuffer.slice(inputBuffer.length - inputWidth)
        : inputBuffer;
      this.terminal.write(truncateOrPad(displayBuffer, inputWidth));

      if (inputMode === 'input') {
        const cursorX = promptLen + Math.min(inputCursor, inputWidth);
        this.terminal.moveTo(cursorX, row);
        this.terminal.write('\x1b[?25h');
      } else {
        this.terminal.write('\x1b[?25l');
      }
    }
  }

  private renderShellHintBar(
    cols: number,
    row: number,
    cards: Card[],
    scrollOffset: number,
    selectedIndex: number,
    inputMode: 'input' | 'browse',
  ): void {
    this.terminal.moveTo(0, row);
    this.terminal.writeStyled(' '.repeat(cols), Style.bgGray);
    this.terminal.moveTo(0, row);

    // Mode pill
    if (inputMode === 'input') {
      this.terminal.writeStyled(' INPUT ', Style.bgCyan + Style.bold + Style.brightWhite);
    } else {
      this.terminal.writeStyled(' BROWSE ', Style.bgYellow + Style.bold + Style.brightWhite);
    }
    this.terminal.writeStyled(' ', Style.bgGray);

    if (inputMode === 'input') {
      this.terminal.writeStyled('Tab', Style.bgGray + Style.bold + Style.white);
      this.terminal.writeStyled(' browse  ', Style.bgGray + Style.white);
      this.terminal.writeStyled('↑↓', Style.bgGray + Style.bold + Style.white);
      this.terminal.writeStyled(' history  ', Style.bgGray + Style.white);
      this.terminal.writeStyled('Ctrl+C', Style.bgGray + Style.bold + Style.white);
      this.terminal.writeStyled(' exit', Style.bgGray + Style.white);
    } else {
      this.terminal.writeStyled('Tab/Esc', Style.bgGray + Style.bold + Style.white);
      this.terminal.writeStyled(' input  ', Style.bgGray + Style.white);
      this.terminal.writeStyled('←→', Style.bgGray + Style.bold + Style.white);
      this.terminal.writeStyled(' scroll  ', Style.bgGray + Style.white);
      this.terminal.writeStyled('enter', Style.bgGray + Style.bold + Style.white);
      this.terminal.writeStyled(' expand  ', Style.bgGray + Style.white);
      this.terminal.writeStyled('q', Style.bgGray + Style.bold + Style.white);
      this.terminal.writeStyled(' quit', Style.bgGray + Style.white);
    }
  }
}

/** Truncate or pad a string to exactly `width` visible characters */
function truncateOrPad(str: string, width: number): string {
  const visible = stripAnsi(str);
  if (visible.length > width) {
    return str.slice(0, width - 1) + '…';
  }
  return str + ' '.repeat(width - visible.length);
}

/** Strip ANSI escape codes for length calculation */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
