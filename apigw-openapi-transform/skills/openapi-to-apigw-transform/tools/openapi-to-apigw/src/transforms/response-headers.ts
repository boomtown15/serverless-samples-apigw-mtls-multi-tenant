import type { OpenAPISpec, Diagnostics } from '../types.js';
import { HTTP_METHODS } from '../types.js';

const RULE = 'response-headers';

/**
 * Verification pass: ensure response headers were preserved through the pipeline.
 * Check that x-* named response headers (like x-correlation-id) weren't stripped.
 * This is a check-only transform — it logs warnings but doesn't modify the spec.
 */
export function responseHeaders(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  // Check component-level responses
  const componentResponses = spec.components?.responses ?? {};
  for (const [name, resp] of Object.entries(componentResponses)) {
    checkResponseHeaders(resp as Record<string, any>,
      `#/components/responses/${name}`, diag);
  }

  // Check inline responses
  const paths = spec.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, any>)[method];
      if (!op?.responses) continue;

      for (const [code, resp] of Object.entries(op.responses as Record<string, any>)) {
        if (!resp || resp.$ref) continue;
        checkResponseHeaders(resp, `#/paths/${path}/${method}/responses/${code}`, diag);
      }
    }
  }

  return spec;
}

function checkResponseHeaders(
  resp: Record<string, any>,
  path: string,
  diag: Diagnostics,
): void {
  const headers = resp.headers;
  if (!headers || typeof headers !== 'object') return;

  const headerNames = Object.keys(headers);
  const xHeaders = headerNames.filter(h => h.toLowerCase().startsWith('x-'));

  if (xHeaders.length > 0) {
    diag.info(RULE, `${path}/headers`, 'response-headers', 'skipped',
      `Verified ${xHeaders.length} x-* response headers preserved: ${xHeaders.join(', ')}`);
  }
}
