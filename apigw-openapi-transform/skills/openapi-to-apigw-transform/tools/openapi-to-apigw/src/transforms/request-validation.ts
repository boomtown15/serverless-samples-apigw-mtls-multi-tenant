import type { OpenAPISpec, Diagnostics } from '../types.js';

const RULE = 'request-validation';

/**
 * Add x-amazon-apigateway-request-validators at API level.
 * Enables both body and parameter validation.
 */
export function requestValidation(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);

  // Skip if already present
  if (result['x-amazon-apigateway-request-validators']) {
    return result;
  }

  result['x-amazon-apigateway-request-validators'] = {
    all: {
      validateRequestBody: true,
      validateRequestParameters: true,
    },
  };
  result['x-amazon-apigateway-request-validator'] = 'all';

  diag.info(RULE, '#', 'request-validation', 'converted',
    'Added x-amazon-apigateway-request-validators with body and parameter validation');

  return result;
}
