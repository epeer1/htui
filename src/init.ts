import * as fs from 'node:fs';
import * as path from 'node:path';
import { multiSelect } from './select.js';

// ─── Markers ───────────────────────────────────────────────────────

const MARKER_START = '<!-- htui:start -->';
const MARKER_END = '<!-- htui:end -->';

// ─── Layer 1: Instruction Model ────────────────────────────────────

interface PatternExample {
  scenario: string;
  command: string;
  note: string;
}

interface CommandEntry {
  name: string;
  keyFields: string;
  description: string;
}

interface EventEntry {
  event: string;
  keyFields: string;
  when: string;
}

interface McpToolEntry {
  name: string;
  description: string;
}

interface InstructionModel {
  directive: string;
  mcpTools: McpToolEntry[];
  useWhen: string[];
  dontUseWhen: string[];
  startupCommand: string;
  patterns: PatternExample[];
  commands: CommandEntry[];
  events: EventEntry[];
}

function buildInstructionModel(): InstructionModel {
  return {
    directive: '**Prefer htui\'s MCP tools (`htui_exec`, `htui_run`, etc.)** — one MCP call returns structured JSON. Use your built-in terminal (`run_in_terminal`) only for commands that need interactive input. Fall back to `htui exec "command"` if MCP is unavailable.',
    mcpTools: [
      { name: 'htui_exec', description: 'Run a shell command and wait for it to finish. Returns full stdout/stderr, exit code, and duration. Prefer this over run_in_terminal for any non-interactive command whose output you need to inspect.' },
      { name: 'htui_run', description: 'Start a shell command in the background and return immediately with a cardId. Use when running things in parallel.' },
      { name: 'htui_tail', description: 'Block until a card produces new lines or finishes. Use to wait on a long-running card without polling.' },
      { name: 'htui_get', description: 'Fetch output from a card by cardId; supports line ranges and stream filtering. Use to re-read a truncated result or drill in after htui_run.' },
      { name: 'htui_search', description: 'Regex or substring search across cards. Use to find errors across a multi-command session without re-reading each command.' },
      { name: 'htui_list', description: 'List known cards with status, title, exit code, and duration.' },
      { name: 'htui_kill', description: 'Terminate an active card\'s process.' },
      { name: 'htui_summary', description: 'Counts of cards by status, plus the 5 most recent.' },
    ],
    useWhen: [
      '**Multiple related commands** — run build, lint, test, then search all outputs for errors at once',
      '**Searching output** — regex search across all command outputs without reading them individually',
      '**Isolating errors** — get only stderr from any command',
      '**Long output** — output is never truncated; retrieve any slice with line ranges',
      '**Tracking a session** — list all commands, check statuses, re-read any previous output',
    ],
    dontUseWhen: [
      'Simple command where you don\'t need structured output — use your built-in terminal tool directly',
      'Interactive commands that need terminal input (htui commands are non-interactive)',
    ],
    startupCommand: 'node node_modules/@epeer1/htui/dist/cli.js --api',
    patterns: [
      {
        scenario: 'Single command (one tool call)',
        command: 'htui exec "npm test"',
        note: 'Run via `run_in_terminal` with `mode=sync`. Returns JSON: `{"ok": true, "exitCode": 0, "stdout": [...], "stderr": [...], "duration": "2.1s"}`',
      },
      {
        scenario: 'Run a command and get output',
        command: '{"cmd": "run", "command": "npm test", "wait": true, "timeout": 30000}',
        note: 'Returns `card_done` with `exitCode`, `duration`, and all output in `lines[]` when finished.',
      },
      {
        scenario: 'Search across all commands',
        command: '{"cmd": "search", "pattern": "error|FAIL", "regex": true}',
        note: 'Returns `search_results` with every matching line, the card it came from, and which stream (stdout/stderr).',
      },
      {
        scenario: 'Get only errors from a specific command',
        command: '{"cmd": "get", "card": 0, "stream": "stderr"}',
        note: 'Returns only stderr lines from card 0. Use `"stream": "stdout"` for stdout only, or omit for both.',
      },
    ],
    commands: [
      { name: 'run', keyFields: '`command` (required), `wait`, `timeout`, `cwd`, `env`, `tag`', description: 'Run a shell command' },
      { name: 'get', keyFields: '`card` (required), `lines: [start, end]`, `stream`', description: 'Get output from a card' },
      { name: 'search', keyFields: '`pattern` (required), `regex`, `ignoreCase`, `stream`, `cards`, `limit`', description: 'Search across all card output' },
      { name: 'list', keyFields: '`status`', description: 'List all cards' },
      { name: 'kill', keyFields: '`card` (required), `signal`', description: 'Kill a running command' },
      { name: 'summary', keyFields: '\u2014', description: 'Get counts by status' },
      { name: 'clear', keyFields: '`killActive`', description: 'Kill active + clear all cards' },
      { name: 'exit', keyFields: '\u2014', description: 'Shut down htui' },
    ],
    events: [
      { event: 'ready', keyFields: '`version`', when: 'htui started' },
      { event: 'card_created', keyFields: '`card`, `title`', when: 'Command launched' },
      { event: 'card_done', keyFields: '`card`, `status`, `exitCode`, `lines[]`', when: 'Command finished (with `wait: true`)' },
      { event: 'card_content', keyFields: '`card`, `lines`, `status`', when: 'Response to `get`' },
      { event: 'search_results', keyFields: '`matches[]`, `totalMatches`', when: 'Response to `search`' },
      { event: 'cards', keyFields: '`cards[]`', when: 'Response to `list`' },
      { event: 'error', keyFields: '`message`', when: 'Invalid command or args' },
    ],
  };
}

// ─── Layer 2: Renderers ────────────────────────────────────────────

function renderFullInstructions(model: InstructionModel): string {
  const lines: string[] = [];

  // Intro + directive
  lines.push('# htui — Terminal for AI Agents');
  lines.push('');
  lines.push(model.directive);
  lines.push('');

  // MCP tools (preferred) — FIRST
  lines.push('## MCP tools (preferred)');
  lines.push('');
  lines.push('htui exposes these as MCP tools. Your MCP client should discover them automatically when htui\'s MCP server is configured in `.vscode/mcp.json` (via `htui init`).');
  lines.push('');
  for (const t of model.mcpTools) {
    lines.push(`- **${t.name}** — ${t.description}`);
  }
  lines.push('');

  // Fallback: htui exec
  lines.push('## Fallback: htui exec (when MCP is unavailable)');
  lines.push('');
  lines.push('For a single command, run `htui exec "command"` via your built-in terminal tool (e.g. `run_in_terminal` with `mode=sync`):');
  lines.push('');
  lines.push('```');
  lines.push('htui exec "npm test"');
  lines.push('```');
  lines.push('');
  lines.push('Returns a single JSON object: `{"ok": true, "exitCode": 0, "stdout": [...], "stderr": [...], "duration": "2.1s"}`. Output is never truncated. Use `--timeout <ms>` and `--cwd <path>` as needed.');
  lines.push('');

  // Legacy: htui --api
  lines.push('## Legacy: htui --api (advanced / direct)');
  lines.push('');
  lines.push(`For multi-command sessions without MCP, htui also offers a JSONL API mode: start \`${model.startupCommand}\` once, then send JSON commands (\`run\`, \`get\`, \`search\`, \`list\`, \`kill\`, \`summary\`, \`clear\`, \`exit\`) on stdin and read events on stdout. See the htui README for the full protocol.`);
  lines.push('');

  return lines.join('\n');
}

function renderCopilotInstructions(model: InstructionModel): string {
  return renderFullInstructions(model);
}

function renderCopilotPathInstructions(model: InstructionModel): string {
  return '---\napplyTo: \'**\'\n---\n' + renderFullInstructions(model);
}

function renderClaudeMd(model: InstructionModel): string {
  return renderFullInstructions(model);
}

function renderCursorRule(model: InstructionModel): string {
  return '---\ndescription: Prefer htui\'s MCP tools for terminal commands; fall back to `htui exec`\nglobs: \nalwaysApply: true\n---\n' + renderFullInstructions(model);
}

function renderCursorRulesLegacy(model: InstructionModel): string {
  return renderFullInstructions(model);
}

function renderWindsurfRules(model: InstructionModel): string {
  return renderFullInstructions(model);
}

function renderGeminiMd(model: InstructionModel): string {
  return renderFullInstructions(model);
}

function renderAntigravitySkill(model: InstructionModel): string {
  const lines: string[] = [];

  lines.push('# htui — Terminal for AI Agents');
  lines.push('');
  lines.push(model.directive);
  lines.push('');

  lines.push('## MCP tools (preferred)');
  lines.push('');
  for (const t of model.mcpTools) {
    lines.push(`- **${t.name}** — ${t.description}`);
  }
  lines.push('');

  lines.push('## Fallback: htui exec');
  lines.push('');
  lines.push('```');
  lines.push('htui exec "npm test"');
  lines.push('```');
  lines.push('');
  lines.push('Returns `{ ok, exitCode, stdout, stderr, duration }`.');
  lines.push('');

  return lines.join('\n');
}

// ─── Layer 3: Target Matrix ────────────────────────────────────────

type AgentId = 'copilot' | 'claude' | 'cursor' | 'windsurf' | 'antigravity';

interface InitFlags {
  legacy: boolean;
  skill: boolean;
  pathInstructions: boolean;
}

interface FileWrite {
  filePath: string;
  content: string;
  strategy: 'overwrite' | 'upsert';
  label: string;
}

interface AgentTarget {
  id: AgentId;
  label: string;
  getWrites: (model: InstructionModel, flags: InitFlags) => FileWrite[];
}

const AGENT_TARGETS: AgentTarget[] = [
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    getWrites(model, flags) {
      const writes: FileWrite[] = [
        {
          filePath: '.github/copilot-instructions.md',
          content: renderCopilotInstructions(model),
          strategy: 'upsert',
          label: 'GitHub Copilot',
        },
      ];
      if (flags.pathInstructions) {
        writes.push({
          filePath: '.github/instructions/htui.instructions.md',
          content: renderCopilotPathInstructions(model),
          strategy: 'upsert',
          label: 'Copilot path instructions',
        });
      }
      return writes;
    },
  },
  {
    id: 'claude',
    label: 'Claude Code',
    getWrites(model) {
      return [{
        filePath: 'CLAUDE.md',
        content: renderClaudeMd(model),
        strategy: 'upsert',
        label: 'Claude Code',
      }];
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    getWrites(model, flags) {
      if (flags.legacy) {
        return [{
          filePath: '.cursorrules',
          content: renderCursorRulesLegacy(model),
          strategy: 'upsert',
          label: 'Cursor (legacy)',
        }];
      }
      return [{
        filePath: '.cursor/rules/htui.mdc',
        content: renderCursorRule(model),
        strategy: 'overwrite',
        label: 'Cursor',
      }];
    },
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    getWrites(model) {
      return [{
        filePath: '.windsurfrules',
        content: renderWindsurfRules(model),
        strategy: 'upsert',
        label: 'Windsurf',
      }];
    },
  },
  {
    id: 'antigravity',
    label: 'Antigravity (Gemini)',
    getWrites(model, flags) {
      const writes: FileWrite[] = [
        {
          filePath: 'GEMINI.md',
          content: renderGeminiMd(model),
          strategy: 'upsert',
          label: 'Antigravity (Gemini)',
        },
      ];
      if (flags.skill) {
        writes.push({
          filePath: 'skills/htui/SKILL.md',
          content: renderAntigravitySkill(model),
          strategy: 'overwrite',
          label: 'Antigravity skill',
        });
      }
      return writes;
    },
  },
];

const VALID_IDS: AgentId[] = AGENT_TARGETS.map(t => t.id);

// ─── Upsert logic ──────────────────────────────────────────────────

interface ResolveResult {
  content: string;
  action: 'created' | 'updated' | 'appended';
}

function resolveContent(existing: string | null, htuiContent: string): ResolveResult {
  const wrapped = MARKER_START + '\n' + htuiContent + '\n' + MARKER_END;

  if (existing === null) {
    return { content: wrapped, action: 'created' };
  }

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + MARKER_END.length);
    return { content: before + wrapped + after, action: 'updated' };
  }

  return { content: existing + '\n\n' + wrapped, action: 'appended' };
}

// ─── Flag + arg parsing ────────────────────────────────────────────

function parseInitArgs(argv: string[]): { agents: string[]; flags: InitFlags; noPrompt: boolean } {
  const flags: InitFlags = { legacy: false, skill: false, pathInstructions: false };
  const agents: string[] = [];
  let noPrompt = false;

  for (const arg of argv) {
    if (arg === '--legacy') {
      flags.legacy = true;
    } else if (arg === '--skill') {
      flags.skill = true;
    } else if (arg === '--path-instructions') {
      flags.pathInstructions = true;
    } else if (arg === '--no-prompt' || arg === '--yes' || arg === '-y') {
      noPrompt = true;
    } else if (!arg.startsWith('-')) {
      agents.push(arg);
    }
  }

  return { agents, flags, noPrompt };
}

// ─── Write a single file ───────────────────────────────────────────

interface WriteResult {
  label: string;
  filePath: string;
  action: string;
}

function writeFile(targetDir: string, fw: FileWrite): WriteResult {
  const fullPath = path.join(targetDir, fw.filePath);
  const dir = path.dirname(fullPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(fullPath, 'utf-8');
  } catch { /* file doesn't exist */ }

  if (fw.strategy === 'overwrite') {
    if (existing !== null && existing === fw.content) {
      return { label: fw.label, filePath: fw.filePath, action: 'unchanged' };
    }
    fs.writeFileSync(fullPath, fw.content);
    return {
      label: fw.label,
      filePath: fw.filePath,
      action: existing === null ? 'created' : 'updated',
    };
  }

  // upsert
  const resolved = resolveContent(existing, fw.content);
  if (existing !== null && existing === resolved.content) {
    return { label: fw.label, filePath: fw.filePath, action: 'unchanged' };
  }
  fs.writeFileSync(fullPath, resolved.content);
  return {
    label: fw.label,
    filePath: fw.filePath,
    action: resolved.action,
  };
}

// ─── MCP config / package.json / install mode ──────────────────────

export type InstallMode = 'global' | 'local' | 'npx';

export function detectInstallMode(scriptPath: string, workspaceRoot: string): InstallMode {
  const execpath = process.env.npm_execpath;
  if (execpath && execpath.toLowerCase().includes('npx')) {
    return 'npx';
  }
  const localRoot = path.resolve(workspaceRoot, 'node_modules', '@epeer1', 'htui');
  const resolved = path.resolve(scriptPath);
  if (resolved.toLowerCase().startsWith(localRoot.toLowerCase() + path.sep) ||
      resolved.toLowerCase() === localRoot.toLowerCase()) {
    return 'local';
  }
  return 'global';
}

export interface ResolvedHtuiPaths {
  nodePath: string;
  scriptPath: string;
}

// Resolve absolute, symlink-followed paths to the node binary and the htui CLI script.
// Returns null if rawScript is missing (caller should fall back to bare 'htui').
// Defaults to live process values; params allow injection for tests.
export function resolveHtuiAbsolutePaths(
  rawNode: string = process.execPath,
  rawScript: string | undefined = process.argv[1],
  realpath: (p: string) => string = fs.realpathSync,
): ResolvedHtuiPaths | null {
  if (!rawScript) return null;
  const resolveOne = (p: string): string => {
    try {
      return realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  const nodePath = resolveOne(rawNode).replace(/\\/g, '/');
  const scriptPath = resolveOne(rawScript).replace(/\\/g, '/');
  return { nodePath, scriptPath };
}

function buildHtuiServerEntry(
  mode: InstallMode,
  paths: ResolvedHtuiPaths | null = null,
): { command: string; args: string[] } {
  switch (mode) {
    case 'global':
      if (paths) {
        return {
          command: paths.nodePath,
          args: [paths.scriptPath, 'mcp', '--workspace', '${workspaceFolder}'],
        };
      }
      // Fallback: argv[1] missing — keep legacy behavior. PATH must be set.
      return { command: 'htui', args: ['mcp', '--workspace', '${workspaceFolder}'] };
    case 'local':
      return {
        command: 'node',
        args: ['node_modules/@epeer1/htui/dist/cli.js', 'mcp', '--workspace', '${workspaceFolder}'],
      };
    case 'npx':
      return {
        command: 'npx',
        args: ['-y', '@epeer1/htui', 'mcp', '--workspace', '${workspaceFolder}'],
      };
  }
}

// Strip JSONC comments (// line and /* block */) while respecting string literals.
function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inString = false;
  let stringChar = '';
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"' || c === '\'') {
      inString = true;
      stringChar = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      // consume until newline
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Return indentation string ("  ", "    ", "\t", etc) detected from the first indented line.
function detectIndent(src: string, fallback: string = '  '): string {
  const lines = src.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([ \t]+)\S/);
    if (m) return m[1];
  }
  return fallback;
}

export interface WriteMcpJsonResult {
  written: boolean;
  path: string;
  reason?: string;
}

export function writeMcpJson(
  workspaceRoot: string,
  mode: InstallMode,
  paths: ResolvedHtuiPaths | null = resolveHtuiAbsolutePaths(),
): WriteMcpJsonResult {
  const targetDir = path.join(workspaceRoot, '.vscode');
  const target = path.join(targetDir, 'mcp.json');
  const htuiEntry = buildHtuiServerEntry(mode, paths);

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(target, 'utf-8');
  } catch { /* missing */ }

  if (existing === null) {
    fs.mkdirSync(targetDir, { recursive: true });
    const payload = { servers: { htui: htuiEntry } };
    fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n');
    return { written: true, path: target, reason: 'created' };
  }

  // Parse with comments stripped
  let parsed: Record<string, unknown>;
  try {
    const stripped = stripJsonComments(existing);
    parsed = JSON.parse(stripped);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root is not an object');
    }
  } catch (err) {
    console.error(`\x1b[31merror\x1b[0m  Could not parse existing .vscode/mcp.json: ${(err as Error).message}`);
    console.error('       Skipping MCP config update. Please fix the file or remove it and re-run `htui init`.');
    return { written: false, path: target, reason: 'parse-error' };
  }

  const indent = detectIndent(existing, '  ');
  const servers = (parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers))
    ? parsed.servers as Record<string, unknown>
    : {};
  servers.htui = htuiEntry;
  parsed.servers = servers;

  const trailingNewline = existing.endsWith('\n') ? '\n' : '';
  const newContent = JSON.stringify(parsed, null, indent) + trailingNewline;

  if (newContent === existing) {
    return { written: false, path: target, reason: 'unchanged' };
  }

  fs.writeFileSync(target, newContent);
  return { written: true, path: target, reason: 'updated' };
}

export interface AddWatchScriptResult {
  added: boolean;
  reason?: string;
}

export function addWatchScript(workspaceRoot: string): AddWatchScriptResult {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { added: false, reason: 'no-package-json' };
  }

  const existing = fs.readFileSync(pkgPath, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root is not an object');
    }
  } catch (err) {
    console.error(`\x1b[31merror\x1b[0m  Could not parse package.json: ${(err as Error).message}`);
    return { added: false, reason: 'parse-error' };
  }

  const scripts = (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts))
    ? parsed.scripts as Record<string, unknown>
    : {};

  if (typeof scripts['htui:watch'] === 'string') {
    return { added: false, reason: 'exists' };
  }

  scripts['htui:watch'] = 'htui watch';
  parsed.scripts = scripts;

  const indent = detectIndent(existing, '  ');
  const trailingNewline = existing.endsWith('\n') ? '\n' : '';
  const newContent = JSON.stringify(parsed, null, indent) + trailingNewline;

  if (newContent === existing) {
    return { added: false, reason: 'unchanged' };
  }

  fs.writeFileSync(pkgPath, newContent);
  return { added: true };
}

// ─── Public API ────────────────────────────────────────────────────

export async function initAgentInstructions(targetDir: string, argv: string[]): Promise<void> {
  const { agents, flags, noPrompt } = parseInitArgs(argv);

  let selectedIds: AgentId[];

  if (agents.length > 0) {
    const unknown = agents.filter(a => !VALID_IDS.includes(a as AgentId));
    if (unknown.length > 0) {
      console.error(`Unknown agent(s): ${unknown.join(', ')}`);
      console.error(`Valid agents: ${VALID_IDS.join(', ')}`);
      return;
    }
    selectedIds = agents as AgentId[];
  } else if (noPrompt) {
    selectedIds = [...VALID_IDS];
  } else {
    const result = await multiSelect(
      'Select agents to install for: (Space to toggle, Enter to confirm)',
      AGENT_TARGETS.map(t => ({ label: t.label, value: t.id, checked: false })),
    );
    if (result.aborted) {
      console.log('Cancelled.');
      return;
    }
    selectedIds = result.selected as AgentId[];
  }

  if (selectedIds.length === 0) {
    console.log('No agents selected.');
    return;
  }

  const model = buildInstructionModel();

  const allWrites: FileWrite[] = [];
  for (const target of AGENT_TARGETS) {
    if (selectedIds.includes(target.id)) {
      allWrites.push(...target.getWrites(model, flags));
    }
  }

  const results: WriteResult[] = [];
  for (const fw of allWrites) {
    results.push(writeFile(targetDir, fw));
  }

  // MCP config + package.json script
  const installMode = detectInstallMode(process.argv[1] || '', targetDir);
  const mcpResult = writeMcpJson(targetDir, installMode);
  const watchScriptResult = addWatchScript(targetDir);

  // Per-file status report
  console.log('');
  for (const r of results) {
    let color: string;
    switch (r.action) {
      case 'created':   color = '\x1b[32m'; break; // green
      case 'appended':  color = '\x1b[33m'; break; // yellow
      case 'updated':   color = '\x1b[36m'; break; // cyan
      case 'unchanged': color = '\x1b[2m';  break; // dim
      default:          color = '';
    }
    console.log(`  ${color}${r.action}\x1b[0m  ${r.filePath} \x1b[2m(${r.label})\x1b[0m`);
  }
  {
    const action = mcpResult.written
      ? (mcpResult.reason === 'created' ? 'created' : 'updated')
      : (mcpResult.reason === 'parse-error' ? 'skipped' : 'unchanged');
    const color =
      action === 'created'  ? '\x1b[32m' :
      action === 'updated'  ? '\x1b[36m' :
      action === 'skipped'  ? '\x1b[31m' :
      '\x1b[2m';
    console.log(`  ${color}${action}\x1b[0m  .vscode/mcp.json \x1b[2m(MCP server, mode: ${installMode})\x1b[0m`);
  }
  {
    let action: string;
    if (watchScriptResult.added) {
      action = 'added';
    } else if (watchScriptResult.reason === 'exists') {
      action = 'unchanged';
    } else if (watchScriptResult.reason === 'no-package-json') {
      action = 'skipped';
    } else {
      action = watchScriptResult.reason || 'unchanged';
    }
    const color =
      action === 'added'     ? '\x1b[32m' :
      action === 'skipped'   ? '\x1b[2m'  :
      action === 'unchanged' ? '\x1b[2m'  :
      '\x1b[31m';
    console.log(`  ${color}${action}\x1b[0m  package.json \x1b[2m(htui:watch script)\x1b[0m`);
  }

  // Summary
  const agentLabels = AGENT_TARGETS
    .filter(t => selectedIds.includes(t.id))
    .map(t => t.label)
    .join(', ');
  console.log('');
  console.log('\x1b[1mhtui installed.\x1b[0m');
  if (mcpResult.written || mcpResult.reason === 'unchanged') {
    console.log(`  MCP server configured in .vscode/mcp.json`);
  }
  console.log(`  Agent instructions updated for: ${agentLabels}`);
  console.log('  Reload VS Code, then run `htui watch` in a terminal to follow agent activity.');

  // Optional interactive prompt
  if (!noPrompt && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await promptYesNo('Start `htui watch` now? [y/N] ');
    if (answer) {
      try {
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, [process.argv[1], 'watch'], {
          detached: true,
          stdio: 'ignore',
          cwd: targetDir,
        });
        child.unref();
      } catch (err) {
        console.error(`Failed to start htui watch: ${(err as Error).message}`);
      }
    }
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf-8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        process.stdin.off('data', onData);
        const answer = buf.slice(0, nl).trim().toLowerCase();
        resolve(answer === 'y' || answer === 'yes');
      }
    };
    process.stdin.on('data', onData);
  });
}

export function printInitHelp(): void {
  console.log(`
htui init \u2014 Install htui for AI coding assistants

Usage:
  htui init                          Interactive prompt to select agents
  htui init copilot claude           Install for specific agents
  htui init --yes                    Install for all agents, no prompts
  htui init --help                   Show this help

What it does:
  - Writes agent instruction files (MCP-first, with exec fallback)
  - Writes .vscode/mcp.json so your MCP client can discover htui's tools
  - Adds an \"htui:watch\" script to package.json (if present)
  - Optionally starts \`htui watch\` in the background (interactive only)

Agents:
  copilot        GitHub Copilot      \u2192 .github/copilot-instructions.md
  claude         Claude Code         \u2192 CLAUDE.md
  cursor         Cursor              \u2192 .cursor/rules/htui.mdc
  windsurf       Windsurf            \u2192 .windsurfrules
  antigravity    Antigravity/Gemini  \u2192 GEMINI.md

Flags:
  --legacy              Cursor: write .cursorrules instead of .cursor/rules/htui.mdc
  --skill               Antigravity: also write skills/htui/SKILL.md
  --path-instructions   Copilot: also write .github/instructions/htui.instructions.md
  --yes, -y, --no-prompt  Non-interactive: install for all agents, skip watch prompt

Files use <!-- htui:start/end --> markers so re-running updates in place
without touching your existing content. Re-running with no changes is a no-op.
`);
}