import type { TransformFn } from '../types.js';
import { swagger2ToOpenapi3 } from './swagger2-to-openapi3.js';
import { openapi31Downgrade } from './openapi31-downgrade.js';
import { externalRefResolve } from './external-ref-resolve.js';
import { inlineSchemaPromotion } from './inline-schema-promotion.js';
import { jsonSchemaCleanup } from './json-schema-cleanup.js';
import { rpcFragmentPath } from './rpc-fragment-path.js';
import { embeddedPathParamSplit } from './embedded-path-param-split.js';
import { sanitizeNames } from './sanitize-names.js';
import { parameterCleanup } from './parameter-cleanup.js';
import { bracketParamRename } from './bracket-param-rename.js';
import { extensionCleanup } from './extension-cleanup.js';
import { serverBasepath } from './server-basepath.js';
import { inlineResponseRefs } from './inline-response-refs.js';
import { inlineParameterRefs } from './inline-parameter-refs.js';
import { securitySchemes } from './security-schemes.js';
import { mockIntegrations } from './mock-integrations.js';
import { requestValidation } from './request-validation.js';
import { responseHeaders } from './response-headers.js';

/**
 * All transform rules in pipeline order.
 * Order matters:
 * 1. Version normalization (Swagger 2.0 → 3.0, 3.1 → 3.0)
 * 2. Content cleanup (JSON Schema, names, params)
 * 3. Ref inlining (responses, parameters) then extension cleanup
 * 4. Structural changes (server paths)
 * 5. API Gateway extensions (security, mock integrations, validation)
 * 6. Verification (response headers check)
 */
export const transforms: TransformFn[] = [
  swagger2ToOpenapi3,
  openapi31Downgrade,
  externalRefResolve,    // v1.5.0: inline adjacent external $refs before schema logic
  inlineSchemaPromotion, // Must run before jsonSchemaCleanup (which assumes schemas live under components/schemas)
  jsonSchemaCleanup,
  rpcFragmentPath,      // Must run BEFORE sanitizeNames (which drops paths containing `#`)
  embeddedPathParamSplit, // Must run BEFORE sanitizeNames (rewrites /{id}.json and /{id}:action into valid forms)
  sanitizeNames,
  bracketParamRename,   // Must run BEFORE parameterCleanup (which strips [ ] as invalid chars)
  parameterCleanup,
  inlineResponseRefs,
  inlineParameterRefs,  // Must run before extensionCleanup: x-* keyed entries in components/parameters are stripped by extension cleanup
  extensionCleanup,
  serverBasepath,
  securitySchemes,
  mockIntegrations,
  requestValidation,
  responseHeaders,
];

export {
  swagger2ToOpenapi3,
  openapi31Downgrade,
  externalRefResolve,
  inlineSchemaPromotion,
  jsonSchemaCleanup,
  rpcFragmentPath,
  embeddedPathParamSplit,
  sanitizeNames,
  parameterCleanup,
  bracketParamRename,
  extensionCleanup,
  serverBasepath,
  inlineResponseRefs,
  inlineParameterRefs,
  securitySchemes,
  mockIntegrations,
  requestValidation,
  responseHeaders,
};
