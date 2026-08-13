import type { Diagnostics, DiagnosticEntry } from './types.js';

export function createDiagnostics(): Diagnostics {
  const entries: DiagnosticEntry[] = [];

  function log(entry: Omit<DiagnosticEntry, 'level'> & { level?: DiagnosticEntry['level'] }): void {
    entries.push({ level: 'info', ...entry } as DiagnosticEntry);
  }

  function info(rule: string, path: string, feature: string, action: DiagnosticEntry['action'], message: string, original?: unknown): void {
    entries.push({ level: 'info', rule, path, feature, action, message, original });
  }

  function warn(rule: string, path: string, feature: string, action: DiagnosticEntry['action'], message: string, original?: unknown): void {
    entries.push({ level: 'warning', rule, path, feature, action, message, original });
  }

  function breaking(rule: string, path: string, feature: string, action: DiagnosticEntry['action'], message: string, original?: unknown): void {
    entries.push({ level: 'breaking', rule, path, feature, action, message, original });
  }

  function error(rule: string, path: string, feature: string, action: DiagnosticEntry['action'], message: string, original?: unknown): void {
    entries.push({ level: 'error', rule, path, feature, action, message, original });
  }

  return { entries, log, info, warn, breaking, error };
}

export function formatDiagnosticsSummary(entries: DiagnosticEntry[]): string {
  if (entries.length === 0) return 'No diagnostics recorded.';

  const byLevel = { info: 0, warning: 0, breaking: 0, error: 0 };
  const byRule = new Map<string, number>();
  const byAction = new Map<string, number>();

  for (const e of entries) {
    byLevel[e.level]++;
    byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1);
    byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
  }

  const lines: string[] = [
    `Diagnostics Summary: ${entries.length} entries`,
    `  Errors: ${byLevel.error}  Breaking: ${byLevel.breaking}  Warnings: ${byLevel.warning}  Info: ${byLevel.info}`,
    '',
    'By Rule:',
  ];

  for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${rule}: ${count}`);
  }

  lines.push('', 'By Action:');
  for (const [action, count] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${action}: ${count}`);
  }

  const warningLines = formatWarningsAndErrors(entries);
  if (warningLines) {
    lines.push('', 'Warnings & Errors:', warningLines);
  }

  return lines.join('\n');
}

/** Format only warning/error diagnostics, one per line. Returns empty string if none. */
export function formatWarningsAndErrors(entries: DiagnosticEntry[]): string {
  const important = entries.filter(e => e.level !== 'info');
  if (important.length === 0) return '';
  return important.map(e =>
    `  [${e.level.toUpperCase()}] ${e.rule}: ${e.message} (${e.path})`
  ).join('\n');
}
