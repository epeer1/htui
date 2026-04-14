import * as fs from 'node:fs';
import * as path from 'node:path';
import { multiSelect } from './select.js';

const MARKER_START = '<!-- htui:start -->';
const MARKER_END = '<!-- htui:end -->';

type AgentId = 'copilot' | 'claude' | 'cursor' | 'windsurf';

interface AgentTarget {
  id: AgentId;
  label: string;
  filePath: string;
}

const AGENT_TARGETS: AgentTarget[] = [
  { id: 'copilot', label: 'GitHub Copilot', filePath: '.github/copilot-instructions.md' },
  { id: 'claude', label: 'Claude Code', filePath: 'CLAUDE.md' },
  { id: 'cursor', label: 'Cursor', filePath: '.cursorrules' },
  { id: 'windsurf', label: 'Windsurf', filePath: '.windsurfrules' },
];

const VALID_IDS = AGENT_TARGETS.map(t => t.id);

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
    // Replace between markers (inclusive)
    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + MARKER_END.length);
    return { content: before + wrapped + after, action: 'updated' };
  }

  // No valid marker pair — append
  return { content: existing + '\n\n' + wrapped, action: 'appended' };
}

function loadHtuiContent(): string {
  const candidates = [
    path.join(__dirname, '..', 'AGENTS.md'),
    path.join(process.cwd(), 'node_modules', 'htui', 'AGENTS.md'),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch { /* try next */ }
  }
  console.error('Could not find htui AGENTS.md template');
  process.exit(1);
}

export async function initAgentInstructions(targetDir: string, agents?: string[]): Promise<void> {
  let selectedIds: AgentId[];

  if (agents && agents.length > 0) {
    // Validate CLI-provided agent IDs
    const unknown = agents.filter(a => !VALID_IDS.includes(a as AgentId));
    if (unknown.length > 0) {
      console.error(`Unknown agent(s): ${unknown.join(', ')}`);
      console.error(`Valid agents: ${VALID_IDS.join(', ')}`);
      return;
    }
    selectedIds = agents as AgentId[];
  } else {
    // Interactive multi-select
    const result = await multiSelect(
      'Select agents to install for: (Space to toggle, Enter to confirm)',
      AGENT_TARGETS.map(t => ({ label: t.label, value: t.id, checked: true })),
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

  const htuiContent = loadHtuiContent();

  // Always write AGENTS.md
  interface WriteEntry {
    label: string;
    filePath: string;
  }

  const writeList: WriteEntry[] = [
    { label: 'AGENTS.md', filePath: 'AGENTS.md' },
    ...AGENT_TARGETS.filter(t => selectedIds.includes(t.id)).map(t => ({
      label: t.label,
      filePath: t.filePath,
    })),
  ];

  const results: Array<{ label: string; filePath: string; action: string }> = [];

  for (const entry of writeList) {
    const fullPath = path.join(targetDir, entry.filePath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let existing: string | null = null;
    try {
      existing = fs.readFileSync(fullPath, 'utf-8');
    } catch { /* file doesn't exist */ }

    // For AGENTS.md, write the content directly (no markers)
    if (entry.filePath === 'AGENTS.md') {
      fs.writeFileSync(fullPath, htuiContent);
      results.push({
        label: entry.label,
        filePath: entry.filePath,
        action: existing === null ? 'created' : 'updated',
      });
      continue;
    }

    const resolved = resolveContent(existing, htuiContent);
    fs.writeFileSync(fullPath, resolved.content);
    results.push({
      label: entry.label,
      filePath: entry.filePath,
      action: resolved.action,
    });
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
htui init — Install agent instructions for AI coding assistants

Usage:
  htui init                  Interactive prompt to select agents
  htui init copilot claude   Install for specific agents
  htui init --help           Show this help

Agents:
  copilot    GitHub Copilot  → .github/copilot-instructions.md
  claude     Claude Code     → CLAUDE.md
  cursor     Cursor          → .cursorrules
  windsurf   Windsurf        → .windsurfrules

AGENTS.md is always created/updated as the canonical instruction file.
Agent-specific files get htui instructions wrapped in <!-- htui:start/end -->
markers so they can be updated in place on subsequent runs.
`);
}
