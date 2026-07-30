import type { OpenAPISpec, SourceAnalysis, ValidationResult, ValidationCheck, Diagnostics } from './types.js';
import { HTTP_METHODS, isNativeApiKeyScheme } from './types.js';

export interface ValidateOptions {
  /** Configured APIGW 'Resources per API' quota. Clamped to >= 300 internally (AWS default cannot be lowered). */
  resourcesPerApiLimit?: number;
}

/**
 * Count unique API Gateway resource-tree nodes implied by a list of paths.
 * API Gateway creates one resource per distinct path segment from root;
 * siblings under the same parent share that parent. Path-param segments
 * are keyed by their literal form so /a/{x} and /a/{y} are distinct siblings.
 */
export function countResources(paths: Iterable<string>): number {
  const nodes = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/').filter(Boolean);
    let accumulated = '';
    for (const seg of segments) {
      accumulated += '/' + seg;
      nodes.add(accumulated);
    }
  }
  return nodes.size;
}

/**
 * Pre-deployment completeness checks.
 * Verifies the cleaned spec matches source analysis counts and
 * has all required API Gateway extensions.
 */
export function validate(
  cleanedSpec: OpenAPISpec,
  sourceAnalysis: SourceAnalysis,
  diag: Diagnostics,
  options: ValidateOptions = {},
): ValidationResult {
  const checks: ValidationCheck[] = [];

  // Count paths
  const paths = cleanedSpec.paths ?? {};
  const pathCount = Object.keys(paths).length;
  checks.push({
    name: 'path-count',
    expected: sourceAnalysis.pathCount,
    actual: pathCount,
    pass: pathCount === sourceAnalysis.pathCount,
  });

  // Fail fast: zero deployable paths means API Gateway will reject the spec.
  // This catches specs where all paths were removed by sanitization rules.
  if (pathCount === 0 && sourceAnalysis.pathCount > 0) {
    diag.error('validator', '#/paths', 'zero-deployable-paths', 'flagged',
      `All ${sourceAnalysis.pathCount} paths were removed during transformation — ` +
      'no API Gateway-compatible paths remain. API Gateway requires at least one path with ' +
      'an HTTP method. Common causes: all paths use embedded path parameters (e.g. {name}.json), ' +
      'unsupported characters (#, =, @), or conflicting sibling path parameters. ' +
      'Manual remediation of the source spec is required.');
  }

  // Count operations
  let operationCount = 0;
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      if ((pathItem as Record<string, any>)[method]) operationCount++;
    }
  }
  checks.push({
    name: 'operation-count',
    expected: sourceAnalysis.operationCount,
    actual: operationCount,
    pass: operationCount === sourceAnalysis.operationCount,
  });

  // Count schemas
  const schemaCount = Object.keys(cleanedSpec.components?.schemas ?? {}).length;
  // Use >= because we may have added wrapper schemas (StringResponse, etc.)
  checks.push({
    name: 'schema-count',
    expected: `>= ${sourceAnalysis.schemaCount}`,
    actual: schemaCount,
    pass: schemaCount >= sourceAnalysis.schemaCount,
  });

  // Every operation has x-amazon-apigateway-integration
  let opsWithIntegration = 0;
  let totalOps = 0;
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, any>)[method];
      if (!op) continue;
      totalOps++;
      if (op['x-amazon-apigateway-integration']) opsWithIntegration++;
    }
  }
  checks.push({
    name: 'all-operations-have-integration',
    expected: totalOps,
    actual: opsWithIntegration,
    pass: opsWithIntegration === totalOps,
  });

  // Security: every secured operation has reachable authorizer
  const securityCheck = checkSecurityAuthorizers(cleanedSpec);
  checks.push(securityCheck);

  const configuredLimit = Math.max(300, options.resourcesPerApiLimit ?? 300);
  const resourceCount = countResources(Object.keys(paths));
  checks.push(checkResourceLimit(resourceCount, configuredLimit));

  if (resourceCount > configuredLimit) {
    diag.breaking('validator', '#/paths', 'resource-limit', 'flagged',
      `Spec has ${resourceCount} API Gateway resources (computed after transforms, including sibling-param rename) ` +
      `— exceeds configured limit of ${configuredLimit}. Deployment will fail. ` +
      `Request a Service Quotas increase (code L-01C8A9E0), consolidate paths under {proxy+}, or split into multiple APIs.`,
      { resourceCount, configuredLimit });
  } else if (resourceCount > configuredLimit * 0.85) {
    diag.info('validator', '#/paths', 'resource-limit', 'flagged',
      `Spec has ${resourceCount} API Gateway resources — approaching configured limit of ${configuredLimit}.`);
  }

  const pass = checks.every(c => c.pass);

  return {
    file: sourceAnalysis.fileName,
    checks,
    pass,
  };
}

function checkResourceLimit(resourceCount: number, configuredLimit: number): ValidationCheck {
  return {
    name: 'api-gateway-resource-limit',
    expected: `<= ${configuredLimit}`,
    actual: resourceCount,
    pass: resourceCount <= configuredLimit,
  };
}

function checkSecurityAuthorizers(spec: OpenAPISpec): ValidationCheck {
  const schemes = spec.components?.securitySchemes ?? {};
  const paths = spec.paths ?? {};

  let securedOps = 0;
  let opsWithReachableAuth = 0;

  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, any>)[method];
      if (!op?.security || !Array.isArray(op.security)) continue;

      for (const secReq of op.security) {
        for (const schemeName of Object.keys(secReq)) {
          securedOps++;
          const scheme = schemes[schemeName];
          if (!scheme) continue;

          // Only two shapes actually enforce auth in a deployed API Gateway REST API:
          //   1. the native x-api-key header, enforced by API Gateway itself, and
          //   2. a scheme carrying x-amazon-apigateway-authorizer (Lambda authorizer),
          //      whether generated by the security-schemes transform or user-supplied.
          //
          // Anything else — notably a scheme that *needs* a Lambda authorizer but whose
          // extensions were stripped because API Gateway cannot read its identity source
          // (e.g. `in: cookie`) — would deploy with no authentication at all. Counting
          // those as reachable auth silently weakened the API, so they now fail the check.
          const isNativeApiKey = isNativeApiKeyScheme(scheme);
          const hasAuthorizer = !!scheme['x-amazon-apigateway-authorizer'];

          if (isNativeApiKey || hasAuthorizer) {
            opsWithReachableAuth++;
          }
        }
      }
    }
  }

  return {
    name: 'secured-operations-have-authorizer',
    expected: securedOps,
    actual: opsWithReachableAuth,
    pass: securedOps === 0 || opsWithReachableAuth === securedOps,
  };
}
