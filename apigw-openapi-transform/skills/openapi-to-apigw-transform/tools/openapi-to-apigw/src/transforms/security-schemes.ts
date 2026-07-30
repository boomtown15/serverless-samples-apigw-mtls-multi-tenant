import type { OpenAPISpec, Diagnostics } from '../types.js';
import { HTTP_METHODS, needsLambdaAuthorizer, isNativeApiKeyScheme } from '../types.js';

const RULE = 'security-schemes';

/**
 * Authorizer URI placeholder using literal mustache-style markers.
 *
 * CloudFormation intrinsics (Fn::Sub) are NOT resolved inside external
 * files loaded via DefinitionUri.  Instead the deploy script resolves
 * these placeholders with the real Lambda ARN + region before uploading
 * the cleaned spec to S3.
 */
const AUTHORIZER_URI_PLACEHOLDER =
  'arn:aws:apigateway:{{AWS_REGION}}:lambda:path/2015-03-31/functions/{{AUTHORIZER_FUNCTION_ARN}}/invocations';

/**
 * Process security schemes for API Gateway deployment via DefinitionUri.
 *
 * This transform writes x-amazon-apigateway-authorizer extensions directly
 * into the OpenAPI spec. The SAM template uses DefinitionUri (no SAM Auth
 * overlay), so authorizer config must be embedded in the spec itself.
 *
 * What this transform does:
 * - Convert http/oauth2/openIdConnect to apiKey type (APIGW only recognizes apiKey for Lambda authorizers)
 * - Write TOKEN authorizer extensions for bearer/oauth2/openIdConnect schemes
 * - Write REQUEST authorizer extensions for basic auth schemes
 * - Preserve user-provided authorizer configs with real URIs
 * - Strip placeholder authorizer extensions (Fn::Sub, ${AuthorizerFunctionArn}, etc.)
 * - Propagate root-level security to operations (API Gateway ignores root security)
 * - Strip scopes from ALL Lambda-authorizer-bound schemes
 * - Set x-amazon-apigateway-api-key-source for native API key schemes
 * - Flag non-standard apiKey locations for manual configuration
 */
export function securitySchemes(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);
  const schemes = result.components?.securitySchemes;

  if (!schemes || Object.keys(schemes).length === 0) {
    return result;
  }

  for (const [name, scheme] of Object.entries(schemes)) {
    const s = scheme as Record<string, any>;
    processScheme(name, s, diag);
  }

  // Propagate root-level security to operation level
  propagateRootSecurity(result, diag);

  // Strip scopes from all Lambda-authorizer-bound schemes —
  // API Gateway only allows scopes with COGNITO_USER_POOLS authorizers, not Lambda authorizers.
  stripLambdaAuthorizerScopes(result, schemes, diag);

  // Resolve operations with multiple authorizers — API Gateway only allows one per operation.
  resolveMultipleAuthorizers(result, diag);

  // If any scheme requires native API key, add api-key-source
  const hasNativeApiKey = Object.values(schemes).some(
    (s: any) => isNativeApiKeyScheme(s),
  );
  if (hasNativeApiKey) {
    result['x-amazon-apigateway-api-key-source'] = 'HEADER';
    diag.info(RULE, '#', 'api-key-source', 'converted',
      'Added x-amazon-apigateway-api-key-source: HEADER for native API key');
  }

  return result;
}

function processScheme(
  name: string,
  scheme: Record<string, any>,
  diag: Diagnostics,
): void {
  const path = `#/components/securitySchemes/${name}`;

  // If already has authorizer extension, check if it's a placeholder
  if (scheme['x-amazon-apigateway-authorizer']) {
    const uri = scheme['x-amazon-apigateway-authorizer'].authorizerUri;
    if (isPlaceholderUri(uri)) {
      // Remove placeholder extensions — we'll add our own below
      delete scheme['x-amazon-apigateway-authorizer'];
      delete scheme['x-amazon-apigateway-authtype'];
      diag.info(RULE, path, 'authorizer-extension-removed', 'removed',
        `Removed placeholder x-amazon-apigateway-authorizer from '${name}' — will add generated authorizer`);
    } else {
      // Real URI → user-provided config, leave it alone
      return;
    }
  }

  // Normalize scheme value for case-insensitive comparison (RFC 7235)
  const httpScheme = typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : scheme.scheme;

  if (scheme.type === 'http' && httpScheme === 'bearer') {
    convertToApiKeyScheme(scheme, 'token', diag, path, name,
      `http/bearer scheme '${name}' — converted to apiKey + Lambda token authorizer`);
    return;
  }

  if (scheme.type === 'oauth2') {
    convertToApiKeyScheme(scheme, 'token', diag, path, name,
      `OAuth2 scheme '${name}' — converted to apiKey + Lambda token authorizer`);
    return;
  }

  if (scheme.type === 'openIdConnect') {
    convertToApiKeyScheme(scheme, 'token', diag, path, name,
      `OpenID Connect scheme '${name}' — converted to apiKey + Lambda token authorizer (discovery: ${scheme.openIdConnectUrl ?? 'N/A'})`);
    return;
  }

  if (scheme.type === 'apiKey') {
    // If the source spec explicitly set x-amazon-apigateway-authtype to 'custom',
    // the author intended a Lambda authorizer. Respect that, even for x-api-key header.
    const hasExplicitAuthtype = scheme['x-amazon-apigateway-authtype'] === 'custom';

    if (isNativeApiKeyScheme(scheme) && !hasExplicitAuthtype) {
      diag.info(RULE, path, 'apiKey/native', 'skipped',
        `API key scheme '${name}' uses native x-api-key header — no authorizer needed`);
      return;
    }
    if (scheme.in === 'header') {
      // Non-standard header apiKey → REQUEST Lambda authorizer reading from the custom header
      scheme['x-amazon-apigateway-authtype'] = 'custom';
      scheme['x-amazon-apigateway-authorizer'] = {
        type: 'request',
        authorizerUri: AUTHORIZER_URI_PLACEHOLDER,
        identitySource: `method.request.header.${scheme.name}`,
        authorizerResultTtlInSeconds: 300,
      };
      diag.info(RULE, path, 'apiKey/header-authorizer', 'converted',
        `API key scheme '${name}' uses custom header '${scheme.name}' — added Lambda request authorizer`);
      return;
    }
    if (scheme.in === 'query') {
      // Query param apiKey → REQUEST Lambda authorizer reading from query string
      scheme['x-amazon-apigateway-authtype'] = 'custom';
      scheme['x-amazon-apigateway-authorizer'] = {
        type: 'request',
        authorizerUri: AUTHORIZER_URI_PLACEHOLDER,
        identitySource: `method.request.querystring.${scheme.name}`,
        authorizerResultTtlInSeconds: 300,
      };
      diag.info(RULE, path, 'apiKey/query-authorizer', 'converted',
        `API key scheme '${name}' uses query param '${scheme.name}' — added Lambda request authorizer`);
      return;
    }
    // Cookie or other unsupported location. API Gateway cannot use it as an
    // authorizer identity source, so no authorizer can be generated and every
    // operation referencing this scheme would deploy with NO authentication.
    // That is a silent removal of auth, so report it as breaking: it must land
    // in breaking-changes.json and trip the CLI's default --fail-on breaking.
    diag.breaking(RULE, path, 'apiKey/non-standard', 'removed',
      `API key scheme '${name}' uses unsupported location (in=${scheme.in}, name=${scheme.name}). ` +
      'API Gateway cannot enforce it, so NO authorizer was generated — operations using this scheme ' +
      'will deploy unauthenticated. Manual Lambda authorizer configuration is required before exposing the API.');
    delete scheme['x-amazon-apigateway-authtype'];
    delete scheme['x-amazon-apigateway-authorizer'];
    return;
  }

  if (scheme.type === 'http' && httpScheme === 'basic') {
    convertToApiKeyScheme(scheme, 'request', diag, path, name,
      `http/basic scheme '${name}' — converted to apiKey + Lambda request authorizer`);
    return;
  }

  diag.warn(RULE, path, `unknown-scheme:${scheme.type}`, 'flagged',
    `Unknown security scheme type '${scheme.type}' for '${name}' — left unchanged`);
}

function applyAuthorizer(scheme: Record<string, any>, authType: 'token' | 'request'): void {
  scheme['x-amazon-apigateway-authtype'] = 'custom';
  const ext: Record<string, any> = {
    type: authType,
    authorizerUri: AUTHORIZER_URI_PLACEHOLDER,
    authorizerResultTtlInSeconds: 300,
  };
  if (authType === 'request') {
    ext.identitySource = 'method.request.header.Authorization';
  }
  scheme['x-amazon-apigateway-authorizer'] = ext;
}

/**
 * Convert http/oauth2/openIdConnect schemes to apiKey type for APIGW compatibility.
 *
 * API Gateway REST API's OpenAPI import only recognizes `type: apiKey` for custom
 * Lambda authorizers. Schemes with `type: http`, `type: oauth2`, or `type: openIdConnect`
 * are silently ignored — the authorizer extensions are never applied. Converting to
 * `type: apiKey` with `in: header, name: Authorization` makes APIGW recognize the
 * authorizer while preserving the same header-based auth behavior.
 */
function convertToApiKeyScheme(
  scheme: Record<string, any>,
  authType: 'token' | 'request',
  diag: Diagnostics,
  path: string,
  name: string,
  message: string,
): void {
  const originalType = scheme.type;
  const originalScheme = scheme.scheme;

  // Apply authorizer extensions first
  applyAuthorizer(scheme, authType);

  // Convert to apiKey so APIGW recognizes the authorizer
  scheme.type = 'apiKey';
  scheme.name = 'Authorization';
  scheme.in = 'header';

  // Clean up http-specific fields
  delete scheme.scheme;
  delete scheme.bearerFormat;
  // Clean up oauth2-specific fields
  delete scheme.flows;
  // Clean up openIdConnect-specific fields
  delete scheme.openIdConnectUrl;

  // Preserve original type info in description
  const originalDesc = scheme.description ? `${scheme.description} ` : '';
  const typeInfo = originalScheme
    ? `[Original: type=${originalType}, scheme=${originalScheme}]`
    : `[Original: type=${originalType}]`;
  scheme.description = `${originalDesc}${typeInfo}`;

  diag.info(RULE, path, `${originalType}${originalScheme ? '/' + originalScheme : ''}`, 'converted', message);
}

/** Detect placeholder authorizer URIs that should be removed. Missing URIs
 *  (undefined/null) are treated as non-placeholder to preserve valid configs
 *  like Cognito User Pool authorizers that use providerARNs instead of authorizerUri. */
function isPlaceholderUri(uri: unknown): boolean {
  if (uri === undefined || uri === null) return false;
  if (typeof uri === 'object' && 'Fn::Sub' in uri) return true;
  if (typeof uri !== 'string') return false;
  if (uri.includes('${AuthorizerFunctionArn}') || uri.includes('${AuthorizerFunction.Arn}')) return true;
  if (uri.includes('{{AUTHORIZER_FUNCTION_ARN}}') || uri.includes('{{AWS_REGION}}')) return true;
  if (uri.includes('PLACEHOLDER') || uri.includes('000000000000')) return true;
  // Match CloudFormation-style ${Var} or unresolved {var} in ARN-like URIs
  // (but not path params like /auth/{tenantId}/validate which are in non-ARN URIs)
  if (/\$\{[a-zA-Z_:]+\}/.test(uri)) return true;
  if (uri.startsWith('arn:') && /\{[a-zA-Z_-]+\}/.test(uri)) return true;
  return false;
}

/**
 * Strip scopes from security requirements bound to Lambda authorizers.
 * API Gateway only allows scopes with COGNITO_USER_POOLS authorizers,
 * not Lambda authorizers. This covers oauth2, openIdConnect, http/bearer,
 * and http/basic — all types that needsLambdaAuthorizer() returns true for.
 */
/** Collect all security requirement arrays from operations and root-level security. */
function collectSecurityArrays(spec: OpenAPISpec): { security: Record<string, any>[]; path: string }[] {
  const result: { security: Record<string, any>[]; path: string }[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, any>)[method];
      if (op?.security && Array.isArray(op.security)) {
        result.push({ security: op.security, path: `#/paths/${path}/${method}` });
      }
    }
  }
  if (Array.isArray(spec.security)) {
    result.push({ security: spec.security, path: '#/security' });
  }
  return result;
}

function stripLambdaAuthorizerScopes(
  spec: OpenAPISpec,
  schemes: Record<string, any>,
  diag: Diagnostics,
): void {
  const lambdaSchemeNames = new Set(
    Object.entries(schemes)
      .filter(([, s]) => s.type && needsLambdaAuthorizer({ type: s.type, scheme: s.scheme, in: s.in, paramName: s.name, explicitCustomAuthtype: s['x-amazon-apigateway-authtype'] === 'custom' }))
      .map(([name]) => name),
  );
  if (lambdaSchemeNames.size === 0) return;

  let stripped = 0;
  for (const { security } of collectSecurityArrays(spec)) {
    for (const secReq of security) {
      if (!secReq || typeof secReq !== 'object') continue;
      for (const [name, scopes] of Object.entries(secReq)) {
        if (lambdaSchemeNames.has(name) && Array.isArray(scopes) && scopes.length > 0) {
          secReq[name] = [];
          stripped++;
        }
      }
    }
  }

  if (stripped > 0) {
    diag.info(RULE, '#', 'lambda-authorizer-scopes-stripped', 'removed',
      `Stripped scopes from ${stripped} security requirements (scopes not supported with Lambda authorizers)`);
  }
}

function propagateRootSecurity(spec: OpenAPISpec, diag: Diagnostics): void {
  const rootSecurity = spec.security;
  if (!rootSecurity || !Array.isArray(rootSecurity) || rootSecurity.length === 0) return;

  const paths = spec.paths ?? {};
  let propagated = 0;

  for (const [, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, any>)[method];
      if (!op) continue;

      if (!op.security) {
        op.security = structuredClone(rootSecurity);
        propagated++;
      }
    }
  }

  if (propagated > 0) {
    diag.info(RULE, '#/security', 'root-security', 'converted',
      `Propagated root-level security to ${propagated} operations without explicit security`);
  }
}

/**
 * Resolve operations with multiple authorizers.
 * API Gateway only allows ONE authorizer per operation.
 *
 * Two cases:
 * 1. Single object with multiple keys: `{JWT: [], Project: []}` → keep first
 * 2. Multiple OR-array entries referencing different Lambda authorizers:
 *    `[{clientKey: []}, {BasicAuth: []}, {ApiKeyAuth: []}]` → keep first
 *    Lambda authorizer, drop other Lambda authorizers, keep native API key entries
 */
function resolveMultipleAuthorizers(spec: OpenAPISpec, diag: Diagnostics): void {
  const schemes = spec.components?.securitySchemes ?? {};

  for (const { security, path } of collectSecurityArrays(spec)) {
    // Case 1: single object with multiple keys
    for (let i = 0; i < security.length; i++) {
      const secReq = security[i];
      if (!secReq || typeof secReq !== 'object') continue;
      const keys = Object.keys(secReq);
      if (keys.length > 1) {
        const kept = keys[0];
        const dropped = keys.slice(1);
        for (const k of dropped) {
          delete secReq[k];
        }
        diag.warn(RULE, `${path}/security/${i}`, 'multiple-authorizers', 'converted',
          `Kept '${kept}', removed '${dropped.join(', ')}' — API Gateway allows only one authorizer per operation`);
      }
    }

    // Case 2: multiple OR-array entries with different Lambda authorizers
    // APIGW rejects: "A combination of multiple Authorizers has been detected"
    let firstAuthorizerIdx = -1;
    const indicesToRemove: number[] = [];
    for (let i = 0; i < security.length; i++) {
      const secReq = security[i];
      if (!secReq || typeof secReq !== 'object') continue;
      const schemeName = Object.keys(secReq)[0];
      if (!schemeName) continue;
      const scheme = schemes[schemeName] as Record<string, any> | undefined;
      if (!scheme) continue;
      // Check if this scheme has a Lambda authorizer (not native API key)
      const hasAuthorizer = !!scheme['x-amazon-apigateway-authorizer'];
      if (hasAuthorizer) {
        if (firstAuthorizerIdx === -1) {
          firstAuthorizerIdx = i;
        } else {
          indicesToRemove.push(i);
        }
      }
    }
    if (indicesToRemove.length > 0) {
      const keptName = Object.keys(security[firstAuthorizerIdx])[0];
      const droppedNames = indicesToRemove.map(i => Object.keys(security[i])[0]);
      // Remove in reverse order to preserve indices
      for (let j = indicesToRemove.length - 1; j >= 0; j--) {
        security.splice(indicesToRemove[j], 1);
      }
      diag.warn(RULE, `${path}/security`, 'multiple-or-authorizers', 'converted',
        `Kept '${keptName}', removed OR-alternatives '${droppedNames.join(', ')}' — API Gateway allows only one authorizer per operation`);
    }
  }
}
