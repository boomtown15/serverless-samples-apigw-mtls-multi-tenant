import type { OpenAPISpec, Diagnostics } from '../types.js';

const RULE = 'extension-cleanup';

/**
 * Clean x-* extensions for API Gateway compatibility.
 * - Retain x-amazon-apigateway-* extensions
 * - Convert x-* enum extensions to standard JSON Schema enum
 * - Remove all other x-* extensions on schema properties
 * - Preserve x-* named response headers (they are NOT extensions)
 */
export function extensionCleanup(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);
  walkAndClean(result, '#', diag, false);
  return result;
}

function walkAndClean(obj: any, path: string, diag: Diagnostics, inHeaders: boolean): void {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkAndClean(obj[i], `${path}/${i}`, diag, inHeaders);
    }
    return;
  }

  // Determine if we're inside a response headers block
  const isHeadersContext = inHeaders || path.endsWith('/headers');

  // Scope guard: keys directly under `#/components/securitySchemes` are scheme
  // *names*, not vendor extensions. An `x-`-prefixed scheme name is a valid
  // identifier — the OpenAPI spec does not reserve `x-` at this location. Skip
  // the strip for map keys here; still recurse into scheme bodies where `x-`
  // IS a vendor extension.
  const isSecuritySchemesMap = path === '#/components/securitySchemes';

  const keysToDelete: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith('x-')) continue;
    if (isSecuritySchemesMap) continue; // key is a scheme name, not an extension

    // Always preserve x-amazon-apigateway-* extensions
    if (key.startsWith('x-amazon-apigateway-')) continue;

    // If we're inside response headers, keys starting with x- are header names, not extensions
    if (isHeadersContext && isResponseHeaderName(path, key)) continue;

    // Check if the value is an array that acts as an enum constraint
    if (Array.isArray(value) && value.length > 0 && isSchemaContext(path)) {
      // Convert to standard enum
      if (!obj.enum) {
        obj.enum = value;
        diag.info(RULE, `${path}/${key}`, key, 'converted',
          `Converted x-* extension '${key}' array to standard enum`, value);
      }
      keysToDelete.push(key);
      continue;
    }

    // Remove other x-* extensions
    diag.info(RULE, `${path}/${key}`, key, 'removed',
      `Removed unsupported extension '${key}'`, value);
    keysToDelete.push(key);
  }

  for (const key of keysToDelete) {
    delete obj[key];
  }

  // Recurse — track if we're entering a headers context
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref') continue;
    const nextIsHeaders = key === 'headers' && path.match(/\/responses\//);
    walkAndClean(value, `${path}/${key}`, diag, isHeadersContext || !!nextIsHeaders);
  }
}

/**
 * Detect if a key in a headers context is a header name (not a schema extension).
 * Response headers are direct children of the headers object.
 */
function isResponseHeaderName(path: string, key: string): boolean {
  // If the path ends with /headers, the key is a header name
  return path.endsWith('/headers');
}

/**
 * Detect if the current path looks like a schema context
 * (inside components/schemas, properties, items, etc.)
 */
function isSchemaContext(path: string): boolean {
  return path.includes('/schemas/') ||
    path.includes('/properties/') ||
    path.includes('/items') ||
    path.includes('/schema');
}
