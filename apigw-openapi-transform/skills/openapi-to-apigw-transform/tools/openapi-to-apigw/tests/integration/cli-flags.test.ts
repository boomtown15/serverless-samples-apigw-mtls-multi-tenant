import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function runCli(args: string[]) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

function writeSpec(dir: string, name: string, content: string) {
  const full = join(dir, name);
  writeFileSync(full, content);
  return full;
}

const SPEC_WITH_BREAKING = [
  'openapi: 3.0.0',
  'info: { title: t, version: "1" }',
  'paths:',
  '  "/x/has@bad/y":',
  '    get: { responses: { "200": { description: ok } } }',
  '  "/healthy":',
  '    get: { responses: { "200": { description: ok } } }',
].join('\n');

const MINIMAL_SPEC = [
  'openapi: 3.0.0',
  'info: { title: t, version: "1" }',
  'paths:',
  '  "/a":',
  '    get: { responses: { "200": { description: ok } } }',
].join('\n');

describe('CLI --fail-on and --resources-per-api-limit', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`dist/cli.js not found — run 'npm run build' first`);
  });

  it('exits 2 with --fail-on=breaking when spec has invalid-path-chars', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', SPEC_WITH_BREAKING);
    const outDir = join(workdir, 'out');

    const res = runCli(['transform', spec, '--output-dir', outDir, '--fail-on', 'breaking']);
    expect(res.status).toBe(2);
    expect(existsSync(join(outDir, 'breaking-changes.json'))).toBe(true);
    const bc = JSON.parse(readFileSync(join(outDir, 'breaking-changes.json'), 'utf8'));
    expect(bc.length).toBeGreaterThan(0);
    expect(bc[0].category).toBe('path-dropped');
  });

  it('exits 0 with --fail-on=never even when breaking present', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', SPEC_WITH_BREAKING);
    const outDir = join(workdir, 'out');
    const res = runCli(['transform', spec, '--output-dir', outDir, '--fail-on', 'never']);
    expect(res.status).toBe(0);
  });

  it('default --fail-on is breaking (no flag → exit 2 when breaking present)', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', SPEC_WITH_BREAKING);
    const outDir = join(workdir, 'out');
    const res = runCli(['transform', spec, '--output-dir', outDir]);
    expect(res.status).toBe(2);
  });

  it('writes empty breaking-changes.json array when no breaking diagnostics', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', MINIMAL_SPEC);
    const outDir = join(workdir, 'out');
    const res = runCli(['transform', spec, '--output-dir', outDir, '--fail-on', 'never']);
    expect(res.status).toBe(0);
    const bc = JSON.parse(readFileSync(join(outDir, 'breaking-changes.json'), 'utf8'));
    expect(bc).toEqual([]);
  });

  it('clamps --resources-per-api-limit below 300 to 300 and emits info diagnostic', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', MINIMAL_SPEC);
    const outDir = join(workdir, 'out');
    const res = runCli(['transform', spec, '--output-dir', outDir, '--resources-per-api-limit', '50', '--fail-on', 'never']);
    expect(res.status).toBe(0);
    const diag = JSON.parse(readFileSync(join(outDir, 'diagnostics.json'), 'utf8'));
    const clamp = diag.find((e: any) => e.feature === 'resources-per-api-limit-clamped');
    expect(clamp).toBeDefined();
    expect(clamp.level).toBe('info');
    expect(clamp.message).toContain('50');
    expect(clamp.message).toContain('300');
  });

  it('does NOT emit clamp diagnostic when limit >= 300', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', MINIMAL_SPEC);
    const outDir = join(workdir, 'out');
    const res = runCli(['transform', spec, '--output-dir', outDir, '--resources-per-api-limit', '500', '--fail-on', 'never']);
    expect(res.status).toBe(0);
    const diag = JSON.parse(readFileSync(join(outDir, 'diagnostics.json'), 'utf8'));
    const clamp = diag.find((e: any) => e.feature === 'resources-per-api-limit-clamped');
    expect(clamp).toBeUndefined();
  });

  it('rejects non-integer --resources-per-api-limit with exit 1 and no stack trace', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', MINIMAL_SPEC);
    const outDir = join(workdir, 'out');
    const res = runCli(['transform', spec, '--output-dir', outDir, '--resources-per-api-limit', 'abc']);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/non-negative integer|invalid/i);
    // InvalidArgumentError produces a one-line error, not a Node stack trace.
    expect(res.stderr + res.stdout).not.toMatch(/at Command\./);
  });

  it('rejects negative --resources-per-api-limit with exit 1', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', MINIMAL_SPEC);
    const outDir = join(workdir, 'out');
    const res = runCli(['transform', spec, '--output-dir', outDir, '--resources-per-api-limit', '-5']);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/non-negative integer|invalid/i);
  });

  it('rejects invalid --fail-on value with exit 1', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', MINIMAL_SPEC);
    const outDir = join(workdir, 'out');
    const res = runCli(['transform', spec, '--output-dir', outDir, '--fail-on', 'panic']);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/fail-on/i);
  });

  it('prints triage summary to stdout when breaking or warning entries exist', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', SPEC_WITH_BREAKING);
    const outDir = join(workdir, 'out');
    const res = runCli(['transform', spec, '--output-dir', outDir, '--fail-on', 'never']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/BREAKING CHANGES/);
    expect(res.stdout).toMatch(/invalid-path-chars/);
    expect(res.stdout).toMatch(/See breaking-changes\.json for remediation/);
  });

  it('includes --stack-prefix value as STACK_PREFIX in generated deploy.sh', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'o2a-test-'));
    const spec = writeSpec(workdir, 'input.yaml', MINIMAL_SPEC);
    const outDir = join(workdir, 'out');
    const res = runCli([
      'transform', spec,
      '--output-dir', outDir,
      '--stack-prefix', 'gapscanv3',
      '--fail-on', 'never',
    ]);
    expect(res.status).toBe(0);
    const deployScript = readFileSync(join(outDir, 'deploy.sh'), 'utf8');
    expect(deployScript).toContain('STACK_PREFIX="${STACK_PREFIX:-gapscanv3-}"');
  });
});
