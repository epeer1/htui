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

interface InstructionModel {
  directive: string;
  useWhen: string[];
  dontUseWhen: string[];
  startupCommand: string;
  patterns: PatternExample[];
  commands: CommandEntry[];
  events: EventEntry[];
}

function buildInstructionModel(): InstructionModel {
  return {
    directive: '**Use htui instead of your built-in terminal tool when you need to run multiple commands in a session, search across their output, or isolate stderr.** htui keeps every command\'s output in a queryable card — nothing is truncated, nothing is lost.\n\nFor simple one-off commands, use your built-in terminal tool. htui earns its keep on multi-command workflows.',
    useWhen: [
      '**Multiple related commands** — run build, lint, test, then search all outputs for errors at once',
      '**Searching output** — regex search across all command outputs without reading them individually',
      '**Isolating errors** — get only stderr from any command',
      '**Long output** — output is never truncated; retrieve any slice with line ranges',
      '**Tracking a session** — list all commands, check statuses, re-read any previous output',
    ],
    dontUseWhen: [
      'Single one-off command where you just need the result',
      'Interactive commands that need terminal input (htui commands are non-interactive)',
    ],
    startupCommand: 'node node_modules/@epeer1/htui/dist/cli.js --api',
    patterns: [
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

  // Directive
  lines.push('# htui — Terminal for AI Agents');
  lines.push('');
  lines.push(model.directive);
  lines.push('');

  // When to use
  lines.push('## When to use htui');
  lines.push('');
  for (const item of model.useWhen) {
    lines.push(`- ${item}`);
  }
  lines.push('');

  // When NOT to use
  lines.push('## When NOT to use htui');
  lines.push('');
  for (const item of model.dontUseWhen) {
    lines.push(`- ${item}`);
  }
  lines.push('');

  // Setup
  lines.push('## Setup');
  lines.push('');
  lines.push('Start htui once per session in an async terminal, then send JSON commands on stdin:');
  lines.push('');
  lines.push('```');
  lines.push(model.startupCommand);
  lines.push('```');
  lines.push('');
  lines.push('htui responds with `{"event": "ready", "version": 2}`. It stays running — reuse it for all commands in the session.');
  lines.push('');

  // Core Patterns
  lines.push('## Core Patterns');
  lines.push('');
  for (const p of model.patterns) {
    lines.push(`### ${p.scenario}`);
    lines.push('');
    lines.push('```json');
    lines.push(p.command);
    lines.push('```');
    lines.push('');
    lines.push(p.note);
    lines.push('');
  }

  // Commands
  lines.push('## Commands');
  lines.push('');
  lines.push('| Command | Key Fields | Description |');
  lines.push('|---------|-----------|-------------|');
  for (const cmd of model.commands) {
    lines.push(`| \`${cmd.name}\` | ${cmd.keyFields} | ${cmd.description} |`);
  }
  lines.push('');

  // Events
  lines.push('## Events');
  lines.push('');
  lines.push('| Event | Key Fields | When |');
  lines.push('|-------|-----------|------|');
  for (const ev of model.events) {
    lines.push(`| \`${ev.event}\` | ${ev.keyFields} | ${ev.when} |`);
  }
  lines.push('');
  lines.push('Card statuses: `active`, `done`, `failed`, `killed`, `timeout`');
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
  return '---\ndescription: Use htui --api for terminal commands in multi-command workflows\nglobs: \nalwaysApply: true\n---\n' + renderFullInstructions(model);
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

  // Setup
  lines.push('## Setup');
  lines.push('');
  lines.push('```');
  lines.push(model.startupCommand);
  lines.push('```');
  lines.push('');

  // Core Patterns only
  lines.push('## Core Patterns');
  lines.push('');
  for (const p of model.patterns) {
    lines.push(`### ${p.scenario}`);
    lines.push('');
    lines.push('```json');
    lines.push(p.command);
    lines.push('```');
    lines.push('');
    lines.push(p.note);
    lines.push('');
  }

  // Compact commands
  lines.push('## Commands');
  lines.push('');
  for (const cmd of model.commands) {
    lines.push(`- **${cmd.name}** — ${cmd.description}`);
  }
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

function parseInitArgs(argv: string[]): { agents: string[]; flags: InitFlags } {
  const flags: InitFlags = { legacy: false, skill: false, pathInstructions: false };
  const agents: string[] = [];

  for (const arg of argv) {
    if (arg === '--legacy') {
      flags.legacy = true;
    } else if (arg === '--skill') {
      flags.skill = true;
    } else if (arg === '--path-instructions') {
      flags.pathInstructions = true;
    } else if (!arg.startsWith('-')) {
      agents.push(arg);
    }
  }

  return { agents, flags };
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
    fs.writeFileSync(fullPath, fw.content);
    return {
      label: fw.label,
      filePath: fw.filePath,
      action: existing === null ? 'created' : 'updated',
    };
  }

  // upsert
  const resolved = resolveContent(existing, fw.content);
  fs.writeFileSync(fullPath, resolved.content);
  return {
    label: fw.label,
    filePath: fw.filePath,
    action: resolved.action,
  };
}

// ─── Public API ────────────────────────────────────────────────────

export async function initAgentInstructions(targetDir: string, argv: string[]): Promise<void> {
  const { agents, flags } = parseInitArgs(argv);

  let selectedIds: AgentId[];

  if (agents.length > 0) {
    const unknown = agents.filter(a => !VALID_IDS.includes(a as AgentId));
    if (unknown.length > 0) {
      console.error(`Unknown agent(s): ${unknown.join(', ')}`);
      console.error(`Valid agents: ${VALID_IDS.join(', ')}`);
      return;
    }
    selectedIds = agents as AgentId[];
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

  // Collect writes for selected agents
  for (const target of AGENT_TARGETS) {
    if (selectedIds.includes(target.id)) {
      allWrites.push(...target.getWrites(model, flags));
    }
  }

  // Execute writes
  const results: WriteResult[] = [];
  for (const fw of allWrites) {
    results.push(writeFile(targetDir, fw));
  }

  // Print status report
  console.log('');
  for (const r of results) {
    let color: string;
    switch (r.action) {
      case 'created':  color = '\x1b[32m'; break; // green
      case 'appended': color = '\x1b[33m'; break; // yellow
      case 'updated':  color = '\x1b[36m'; break; // cyan
      default:         color = '';
    }
    console.log(`  ${color}${r.action}\x1b[0m  ${r.filePath} \x1b[2m(${r.label})\x1b[0m`);
  }

  console.log('\n\x1b[1mDone!\x1b[0m Your AI agents will now use htui --api for terminal commands.');
}

export function printInitHelp(): void {
  console.log(`
htui init \u2014 Install agent instructions for AI coding assistants

Usage:
  htui init                          Interactive prompt to select agents
  htui init copilot claude           Install for specific agents
  htui init --help                   Show this help

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

AGENTS.md is always created/updated as the canonical instruction file.
Agent-specific files get htui instructions wrapped in <!-- htui:start/end -->
markers so they can be updated in place on subsequent runs.
`);
}