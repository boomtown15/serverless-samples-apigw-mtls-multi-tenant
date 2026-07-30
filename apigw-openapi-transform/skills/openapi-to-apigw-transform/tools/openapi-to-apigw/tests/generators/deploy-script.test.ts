import { describe, it, expect } from 'vitest';
import { generateDeployScript } from '../../src/generators/deploy-script.js';
import type { SpecDeployInfo } from '../../src/generators/deploy-script.js';
import type { TransformOptions } from '../../src/types.js';

const baseOptions: TransformOptions = {
  region: 'us-west-2',
  stage: 'test',
  outputDir: '.',
};

describe('generateDeployScript: S3_PREFIX', () => {
  it('defines S3_PREFIX from basename of SCRIPT_DIR', () => {
    const specs: SpecDeployInfo[] = [
      { apiTemplate: 'petstore.sam.yaml', cleanedSpec: 'petstore-cleaned.yaml', authorizerTemplate: null },
    ];
    const script = generateDeployScript(specs, baseOptions);
    expect(script).toContain('S3_PREFIX="$(basename "$SCRIPT_DIR")"');
  });

  it('uses $S3_PREFIX in S3 key for single-phase deploy', () => {
    const specs: SpecDeployInfo[] = [
      { apiTemplate: 'api.sam.yaml', cleanedSpec: 'api-cleaned.yaml', authorizerTemplate: null },
    ];
    const script = generateDeployScript(specs, baseOptions);
    expect(script).toContain('S3_SPEC_KEY="$S3_PREFIX/api-cleaned.yaml"');
  });

  it('uses $S3_PREFIX in S3 key for two-phase auth deploy', () => {
    const specs: SpecDeployInfo[] = [
      { apiTemplate: 'api.sam.yaml', cleanedSpec: 'api-cleaned.yaml', authorizerTemplate: 'api-auth.sam.yaml' },
    ];
    const script = generateDeployScript(specs, baseOptions);
    expect(script).toContain('S3_SPEC_KEY="$S3_PREFIX/api-cleaned.yaml"');
  });
});

describe('generateDeployScript: STACK_PREFIX', () => {
  it('emits STACK_PREFIX as empty string by default', () => {
    const specs: SpecDeployInfo[] = [
      { apiTemplate: 'api.sam.yaml', cleanedSpec: 'api-cleaned.yaml', authorizerTemplate: null },
    ];
    const script = generateDeployScript(specs, baseOptions);
    expect(script).toContain('STACK_PREFIX="${STACK_PREFIX:-}"');
  });

  it('emits STACK_PREFIX with CLI-supplied default', () => {
    const specs: SpecDeployInfo[] = [
      { apiTemplate: 'api.sam.yaml', cleanedSpec: 'api-cleaned.yaml', authorizerTemplate: null },
    ];
    const script = generateDeployScript(specs, { ...baseOptions, stackPrefix: 'gapscanv3' });
    expect(script).toContain('STACK_PREFIX="${STACK_PREFIX:-gapscanv3-}"');
  });

  it('references ${STACK_PREFIX} in every --stack-name for single-phase deploy', () => {
    const specs: SpecDeployInfo[] = [
      { apiTemplate: 'petstore.sam.yaml', cleanedSpec: 'petstore-cleaned.yaml', authorizerTemplate: null },
    ];
    const script = generateDeployScript(specs, { ...baseOptions, stackPrefix: 'gapscanv3' });
    expect(script).toContain('--stack-name "${STACK_PREFIX}petstore"');
  });

  it('references ${STACK_PREFIX} in both phases for two-phase deploy', () => {
    const specs: SpecDeployInfo[] = [
      { apiTemplate: 'api.sam.yaml', cleanedSpec: 'api-cleaned.yaml', authorizerTemplate: 'api-auth.sam.yaml' },
    ];
    const script = generateDeployScript(specs, { ...baseOptions, stackPrefix: 'gapscanv3' });
    const matches = script.match(/--stack-name "\$\{STACK_PREFIX\}api"/g) ?? [];
    // Phase 1 deploy, describe-stacks lookup, Phase 2 deploy, final describe-stacks output = 4 occurrences
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('references ${STACK_PREFIX} in the final describe-stacks summary', () => {
    const specs: SpecDeployInfo[] = [
      { apiTemplate: 'api.sam.yaml', cleanedSpec: 'api-cleaned.yaml', authorizerTemplate: null },
    ];
    const script = generateDeployScript(specs, { ...baseOptions, stackPrefix: 'gapscanv3' });
    expect(script).toMatch(/# Show stack outputs[\s\S]*--stack-name "\$\{STACK_PREFIX\}api"/);
  });
});
