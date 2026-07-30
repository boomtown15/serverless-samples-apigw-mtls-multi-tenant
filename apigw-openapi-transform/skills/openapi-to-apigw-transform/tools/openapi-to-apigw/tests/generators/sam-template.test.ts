import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { generateSamTemplate, generateAuthorizerTemplate } from '../../src/generators/sam-template.js';
import type { SourceAnalysis } from '../../src/types.js';

function makeAnalysis(overrides: Partial<SourceAnalysis> = {}): SourceAnalysis {
  return {
    fileName: 'sample.yaml',
    version: '3.0.0',
    pathCount: 1,
    operationCount: 1,
    schemaCount: 0,
    securitySchemes: [],
    ...overrides,
  } as SourceAnalysis;
}

/**
 * Observability defaults on the generated API stage.
 *
 * X-Ray tracing is enabled unconditionally: it needs no account-level
 * prerequisite, so it is safe to switch on by default.
 *
 * Access logging is deliberately NOT emitted — API Gateway REST APIs can only
 * deliver access logs once a CloudWatch Logs role ARN is set at the *account*
 * level (`Account.cloudWatchRoleArn`, one-time per region). Emitting an
 * AccessLogSetting in a per-API template would make the stack fail to deploy in
 * any account that has not been prepared, so the template documents the
 * requirement instead of breaking the deploy.
 */
describe('generateSamTemplate: observability defaults', () => {
  it('enables X-Ray tracing on the API stage', () => {
    const sam = YAML.parse(generateSamTemplate(makeAnalysis(), { region: 'us-east-1' }));
    expect(sam.Resources.RestApi.Properties.TracingEnabled).toBe(true);
  });

  it('enables X-Ray tracing on the authorizer Lambda when one is generated', () => {
    const analysis = makeAnalysis({
      securitySchemes: [{ name: 'BearerAuth', type: 'http', scheme: 'bearer' }],
    } as Partial<SourceAnalysis>);
    const sam = YAML.parse(generateSamTemplate(analysis, { region: 'us-east-1' }));
    expect(sam.Resources.AuthorizerFunction.Properties.Tracing).toBe('Active');
  });

  it('enables X-Ray tracing on the phase-1 authorizer-only template', () => {
    const analysis = makeAnalysis({
      securitySchemes: [{ name: 'BearerAuth', type: 'http', scheme: 'bearer' }],
    } as Partial<SourceAnalysis>);
    const auth = YAML.parse(generateAuthorizerTemplate(analysis, { region: 'us-east-1' })!);
    expect(auth.Resources.AuthorizerFunction.Properties.Tracing).toBe('Active');
  });

  it('does not set AccessLogSetting, which would require an account-level CloudWatch role', () => {
    // Assert on the parsed resource, not the raw YAML — the Description deliberately
    // mentions AccessLogSetting to document the prerequisite.
    const sam = YAML.parse(generateSamTemplate(makeAnalysis(), { region: 'us-east-1' }));
    expect(sam.Resources.RestApi.Properties.AccessLogSetting).toBeUndefined();
  });

  it('documents the access-logging prerequisite in the template description', () => {
    const raw = generateSamTemplate(makeAnalysis(), { region: 'us-east-1' });
    expect(raw).toMatch(/access log/i);
  });
});
