/**
 * ANSI/chunk helpers for the card store.
 *
 * Pure functions; no state. Handlers that stream child-process output should
 * feed chunks through `splitBuffered` to carry a partial-line remainder
 * between chunks, and through `processChunk` to collapse carriage-return
 * progress bars and strip escape sequences from each complete line.
 */

// CSI and OSC sequences. Matches architect §8.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g;

/** Strip all CSI/OSC escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Split a new chunk into complete lines, carrying any trailing partial line
 * as a remainder for the next call.
 *
 * Line separators (`\n`) are consumed. `\r\n` is handled naturally since the
 * `\r` is kept in the line text, which `processChunk` then collapses.
 */
export function splitBuffered(
  prev: string,
  next: string
): { lines: string[]; remainder: string } {
  const combined = prev + next;
  const parts = combined.split('\n');
  const remainder = parts.pop() ?? '';
  return { lines: parts, remainder };
}

/**
 * Process a single chunk of stream text and return ready-to-emit lines.
 *
 * For each complete line (split by `\n`), keeps only the text after the last
 * `\r` (progress-bar collapse), then strips ANSI escape sequences.
 *
 * The final trailing partial (no `\n`) is discarded — callers that need to
 * buffer partials across chunks should use `splitBuffered` to carry the
 * remainder and only pass complete content here.
 */
export function processChunk(buf: string): string[] {
  const parts = buf.split('\n');
  // Drop the trailing partial; caller is responsible for buffering.
  parts.pop();
  return parts.map(collapseAndStrip);
}

function collapseAndStrip(line: string): string {
  // Strip a single trailing CR (CRLF-style line ending) before collapsing
  // progress-bar carriage returns. Otherwise `foo\r` would collapse to ''.
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  const crIdx = trimmed.lastIndexOf('\r');
  const collapsed = crIdx === -1 ? trimmed : trimmed.slice(crIdx + 1);
  return stripAnsi(collapsed);
}

/** Exposed for convenience: collapse+strip a single already-split line. */
export function normalizeLine(line: string): string {
  return collapseAndStrip(line);
}
