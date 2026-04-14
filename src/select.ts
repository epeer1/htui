export interface SelectOption {
  label: string;
  value: string;
  checked: boolean;
}

export interface MultiSelectResult {
  selected: string[];
  aborted: boolean;
}

export function multiSelect(title: string, options: SelectOption[]): Promise<MultiSelectResult> {
  // Non-TTY fallback: return all options as selected
  if (!process.stdin.isTTY) {
    return Promise.resolve({
      selected: options.map(o => o.value),
      aborted: false,
    });
  }

  return new Promise((resolve) => {
    let cursor = 0;
    let lineCount = 0;

    const render = (first: boolean): void => {
      let out = '';

      // On re-render, move cursor up to overwrite previous output
      if (!first && lineCount > 0) {
        out += `\x1b[${lineCount}A`;
      }

      // Title line
      out += `\r\x1b[K\x1b[1m${title}\x1b[0m\n`;

      // Option lines
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const focused = i === cursor;
        const check = opt.checked ? '✓' : ' ';
        const pointer = focused ? '❯' : ' ';
        const dim = focused ? '' : '\x1b[2m';
        const reset = focused ? '' : '\x1b[0m';
        out += `\r\x1b[K${dim}${pointer} [${check}] ${opt.label}${reset}\n`;
      }

      // Footer
      out += `\r\x1b[K\x1b[2m↑/↓ navigate  ·  Space toggle  ·  a toggle all  ·  Enter confirm  ·  Esc cancel\x1b[0m`;

      lineCount = 1 + options.length + 1; // title + options + footer

      process.stdout.write(out);
    };

    const clearMenu = (): void => {
      // Move up to the top of the menu, then clear all lines
      if (lineCount > 1) {
        process.stdout.write(`\x1b[${lineCount - 1}A`);
      }
      for (let i = 0; i < lineCount; i++) {
        process.stdout.write(`\r\x1b[K${i < lineCount - 1 ? '\n' : ''}`);
      }
      // Move back up to the start
      if (lineCount > 1) {
        process.stdout.write(`\x1b[${lineCount - 1}A`);
      }
      process.stdout.write('\r');
    };

    const finish = (aborted: boolean): void => {
      clearMenu();
      process.stdin.setRawMode!(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve({
        selected: aborted ? [] : options.filter(o => o.checked).map(o => o.value),
        aborted,
      });
    };

    const onData = (data: Buffer): void => {
      const key = data.toString();

      // Esc
      if (key === '\x1b' || key === '\x03') {
        finish(true);
        return;
      }

      // Enter
      if (key === '\r' || key === '\n') {
        finish(false);
        return;
      }

      // Space - toggle current
      if (key === ' ') {
        options[cursor].checked = !options[cursor].checked;
        render(false);
        return;
      }

      // 'a' - toggle all
      if (key === 'a' || key === 'A') {
        const allChecked = options.every(o => o.checked);
        for (const opt of options) {
          opt.checked = !allChecked;
        }
        render(false);
        return;
      }

      // Arrow up or 'k'
      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + options.length) % options.length;
        render(false);
        return;
      }

      // Arrow down or 'j'
      if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % options.length;
        render(false);
        return;
      }
    };

    try {
      process.stdin.setRawMode!(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
      render(true);
    } catch {
      // If raw mode fails, return all selected
      try { process.stdin.setRawMode!(false); } catch { /* ignore */ }
      try { process.stdin.pause(); } catch { /* ignore */ }
      resolve({
        selected: options.map(o => o.value),
        aborted: false,
      });
    }
  });
}
