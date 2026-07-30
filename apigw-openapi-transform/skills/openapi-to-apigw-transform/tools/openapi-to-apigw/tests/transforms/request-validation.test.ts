import { describe, it, expect } from 'vitest';
import { requestValidation } from '../../src/transforms/request-validation.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('requestValidation', () => {
  it('adds request validators at API level', () => {
    const spec = { openapi: '3.0.0', paths: {} };
    const diag = createDiagnostics();
    const result = requestValidation(spec, diag);
    expect(result['x-amazon-apigateway-request-validators'].all.validateRequestBody).toBe(true);
    expect(result['x-amazon-apigateway-request-validators'].all.validateRequestParameters).toBe(true);
    expect(result['x-amazon-apigateway-request-validator']).toBe('all');
  });

  it('does not overwrite existing validators', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      'x-amazon-apigateway-request-validators': { custom: { validateRequestBody: false } },
    };
    const diag = createDiagnostics();
    const result = requestValidation(spec, diag);
    expect(result['x-amazon-apigateway-request-validators'].custom).toBeDefined();
    expect(result['x-amazon-apigateway-request-validators'].all).toBeUndefined();
  });
});
