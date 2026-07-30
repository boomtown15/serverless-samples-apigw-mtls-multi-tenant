import { describe, it, expect } from 'vitest';
import { buildBreakingChanges } from '../../src/generators/breaking-changes.js';
import type { DiagnosticEntry } from '../../src/types.js';

function entry(partial: Partial<DiagnosticEntry> & { rule: string; feature: string; level: DiagnosticEntry['level']; action: DiagnosticEntry['action'] }): DiagnosticEntry {
  return {
    path: '#/',
    message: 'msg',
    ...partial,
  } as DiagnosticEntry;
}

describe('buildBreakingChanges', () => {
  it('returns [] when no breaking entries', () => {
    const result = buildBreakingChanges([
      entry({ rule: 'x', level: 'info', feature: 'f', action: 'removed' }),
      entry({ rule: 'x', level: 'warning', feature: 'f', action: 'renamed' }),
    ]);
    expect(result).toEqual([]);
  });

  it('maps embedded-path-param and invalid-path-chars as path-dropped', () => {
    const entries = [
      entry({ rule: 'sanitize-names', level: 'breaking', feature: 'embedded-path-param', action: 'removed', path: '#/paths//a/{x}:{y}', message: 'Removed path /a/{x}:{y}', file: 'opensuse-org' } as any),
      entry({ rule: 'sanitize-names', level: 'breaking', feature: 'invalid-path-chars', action: 'removed', path: '#/paths//b@c', message: 'Removed path /b@c', file: 'opensuse-org' } as any),
    ];
    const result = buildBreakingChanges(entries);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      category: 'path-dropped',
      reason: 'embedded-path-param',
      specFile: 'opensuse-org',
      clientImpact: expect.stringContaining('404'),
    });
    expect(result[1]).toMatchObject({
      category: 'path-dropped',
      reason: 'invalid-path-chars',
      specFile: 'opensuse-org',
    });
  });

  it('does not include warning-level sibling renames', () => {
    const entries = [
      entry({ rule: 'sanitize-names', level: 'warning', feature: 'sibling-path-param-conflict', action: 'renamed', file: 'motaword-com', message: "Renamed path parameter '{uid}' → '{userId}'." } as any),
      entry({ rule: 'sanitize-names', level: 'warning', feature: 'sibling-path-param-conflict', action: 'renamed', file: 'motaword-com', message: "Renamed path parameter '{uid}' → '{userId}'." } as any),
    ];
    expect(buildBreakingChanges(entries)).toEqual([]);
  });

  it('maps rpc-fragment-path-collision as path-dropped with RPC-specific copy', () => {
    const entries = [
      entry({ rule: 'rpc-fragment-path', level: 'breaking', feature: 'rpc-fragment-path-collision', action: 'removed', path: '#/paths//#X-Amz-Target=Svc.Foo', file: 'aws-svc', message: 'Dropped RPC path' } as any),
    ];
    const result = buildBreakingChanges(entries);
    expect(result[0]).toMatchObject({
      category: 'path-dropped',
      reason: 'rpc-fragment-path-collision',
      specFile: 'aws-svc',
    });
    expect(result[0].clientImpact).toContain('RPC');
    expect(result[0].remediation).toContain('Rename');
  });

  it('maps sibling-rename-collision as path-dropped', () => {
    const entries = [
      entry({ rule: 'sanitize-names', level: 'breaking', feature: 'sibling-rename-collision', action: 'removed', path: '#/paths//x/{b}/y', file: 'spec-x', message: 'Collision' } as any),
    ];
    const result = buildBreakingChanges(entries);
    expect(result[0]).toMatchObject({
      category: 'path-dropped',
      reason: 'sibling-rename-collision',
      specFile: 'spec-x',
      path: '/x/{b}/y',
    });
  });

  it('maps resource-limit breaking with quota metadata and parses resourceCount from message', () => {
    const entries = [
      entry({ rule: 'validator', level: 'breaking', feature: 'resource-limit', action: 'flagged', file: 'github-com',
        message: 'Spec has 1247 API Gateway resources (computed after transforms) — exceeds configured limit of 300. Deployment will fail.' } as any),
    ];
    const result = buildBreakingChanges(entries, { configuredLimit: 300 });
    expect(result[0]).toMatchObject({
      category: 'resource-limit-exceeded',
      reason: 'resource-limit',
      specFile: 'github-com',
      resourceCount: 1247,
      configuredLimit: 300,
      defaultQuota: 300,
      limitType: 'soft',
      quotaCode: 'L-01C8A9E0',
    });
    expect(result[0].serviceQuotasUrl).toContain('L-01C8A9E0');
    expect(result[0].remediation).toContain('--resources-per-api-limit');
  });

  it('falls back to other-breaking for unclassified breaking entries', () => {
    const entries = [
      entry({ rule: 'unknown-rule', level: 'breaking', feature: 'some-new-feature', action: 'removed', path: '#/paths//a', file: 'x', message: 'Whatever' } as any),
    ];
    const result = buildBreakingChanges(entries);
    expect(result[0]).toMatchObject({
      category: 'other-breaking',
      reason: 'some-new-feature',
      specFile: 'x',
    });
  });

  it('uses "unknown" for specFile when file field is absent', () => {
    const entries = [
      entry({ rule: 'sanitize-names', level: 'breaking', feature: 'embedded-path-param', action: 'removed', path: '#/paths//a', message: 'm' }),
    ];
    const result = buildBreakingChanges(entries);
    expect(result[0].specFile).toBe('unknown');
  });

  it('still emits resource-limit-exceeded with resourceCount undefined when original and message are unparseable', () => {
    const entries = [
      entry({ rule: 'validator', level: 'breaking', feature: 'resource-limit', action: 'flagged',
        file: 'x', message: 'Resource limit exceeded.' } as any),
    ];
    const result = buildBreakingChanges(entries, { configuredLimit: 300 });
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('resource-limit-exceeded');
    expect(result[0].resourceCount).toBeUndefined();
    expect(result[0].configuredLimit).toBe(300);
  });

  it('reads resourceCount and configuredLimit from original when present, ignoring message', () => {
    const entries = [
      entry({ rule: 'validator', level: 'breaking', feature: 'resource-limit', action: 'flagged',
        file: 'x', message: 'intentionally unparseable message',
        original: { resourceCount: 999, configuredLimit: 600 } } as any),
    ];
    const result = buildBreakingChanges(entries);
    expect(result[0].resourceCount).toBe(999);
    expect(result[0].configuredLimit).toBe(600);
  });
});
