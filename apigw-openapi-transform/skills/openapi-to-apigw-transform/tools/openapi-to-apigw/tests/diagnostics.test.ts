import { describe, it, expect } from 'vitest';
import { createDiagnostics, formatDiagnosticsSummary } from '../src/diagnostics.js';

describe('Diagnostics', () => {
  it('starts with empty entries', () => {
    const diag = createDiagnostics();
    expect(diag.entries).toEqual([]);
  });

  it('logs info entries', () => {
    const diag = createDiagnostics();
    diag.info('test-rule', '#/path', 'feature', 'removed', 'Test message', 'original');
    expect(diag.entries).toHaveLength(1);
    expect(diag.entries[0]).toEqual({
      level: 'info',
      rule: 'test-rule',
      path: '#/path',
      feature: 'feature',
      action: 'removed',
      message: 'Test message',
      original: 'original',
    });
  });

  it('logs warning entries', () => {
    const diag = createDiagnostics();
    diag.warn('rule', '#/x', 'feat', 'flagged', 'Warning');
    expect(diag.entries[0].level).toBe('warning');
  });

  it('logs error entries', () => {
    const diag = createDiagnostics();
    diag.error('rule', '#/x', 'feat', 'skipped', 'Error');
    expect(diag.entries[0].level).toBe('error');
  });

  it('logs via generic log()', () => {
    const diag = createDiagnostics();
    diag.log({ rule: 'r', path: '#/', feature: 'f', action: 'removed', message: 'm', level: 'warning' });
    expect(diag.entries[0].level).toBe('warning');
  });

  it('defaults to info level in log()', () => {
    const diag = createDiagnostics();
    diag.log({ rule: 'r', path: '#/', feature: 'f', action: 'removed', message: 'm' });
    expect(diag.entries[0].level).toBe('info');
  });

  it('logs breaking entries', () => {
    const diag = createDiagnostics();
    diag.breaking('rule', '#/x', 'feat', 'removed', 'Breaking change');
    expect(diag.entries).toHaveLength(1);
    expect(diag.entries[0].level).toBe('breaking');
    expect(diag.entries[0].rule).toBe('rule');
    expect(diag.entries[0].feature).toBe('feat');
  });

  it('preserves original field on breaking', () => {
    const diag = createDiagnostics();
    diag.breaking('r', '#/p', 'f', 'removed', 'msg', { extra: 1 });
    expect(diag.entries[0].original).toEqual({ extra: 1 });
  });
});

describe('formatDiagnosticsSummary', () => {
  it('returns message for empty entries', () => {
    expect(formatDiagnosticsSummary([])).toBe('No diagnostics recorded.');
  });

  it('formats summary with counts', () => {
    const diag = createDiagnostics();
    diag.info('rule-a', '#/a', 'f1', 'removed', 'Msg 1');
    diag.warn('rule-b', '#/b', 'f2', 'flagged', 'Msg 2');
    diag.info('rule-a', '#/c', 'f3', 'converted', 'Msg 3');

    const summary = formatDiagnosticsSummary(diag.entries);
    expect(summary).toContain('3 entries');
    expect(summary).toContain('Warnings: 1');
    expect(summary).toContain('rule-a: 2');
    expect(summary).toContain('Msg 2');
  });

  it('counts breaking entries separately', () => {
    const diag = createDiagnostics();
    diag.info('r', '#/', 'f', 'removed', 'i');
    diag.warn('r', '#/', 'f', 'flagged', 'w');
    diag.breaking('r', '#/', 'f', 'removed', 'b');
    diag.error('r', '#/', 'f', 'skipped', 'e');

    const summary = formatDiagnosticsSummary(diag.entries);
    expect(summary).toContain('Errors: 1');
    expect(summary).toContain('Breaking: 1');
    expect(summary).toContain('Warnings: 1');
    expect(summary).toContain('Info: 1');
  });
});
