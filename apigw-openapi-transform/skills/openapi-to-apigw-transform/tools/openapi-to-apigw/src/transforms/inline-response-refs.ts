import type { OpenAPISpec, Diagnostics } from '../types.js';
import { HTTP_METHODS } from '../types.js';

const RULE = 'inline-response-refs';

/**
 * Inline root-level $ref responses.
 * API Gateway does not support `"500": {"$ref": "#/responses/UnexpectedError"}` form.
 * Resolve these to inline schema definitions.
 */
export function inlineResponseRefs(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);
  const reusableResponses = result.components?.responses ?? {};

  const paths = result.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, any>)[method];
      if (!op?.responses) continue;

      for (const [code, resp] of Object.entries(op.responses as Record<string, any>)) {
        if (!resp?.$ref) continue;

        // Resolve the $ref
        const refPath = resp.$ref as string;
        const resolved = resolveRef(refPath, reusableResponses, result);

        if (resolved) {
          op.responses[code] = structuredClone(resolved);
          diag.info(RULE, `#/paths/${path}/${method}/responses/${code}`, 'response-$ref', 'converted',
            `Inlined response $ref '${refPath}'`);
        } else {
          diag.warn(RULE, `#/paths/${path}/${method}/responses/${code}`, 'response-$ref', 'flagged',
            `Could not resolve response $ref '${refPath}'`);
        }
      }
    }
  }

  return result;
}

function resolveRef(
  refPath: string,
  reusableResponses: Record<string, any>,
  spec: OpenAPISpec,
): Record<string, any> | null {
  // Handle #/components/responses/Name
  const componentsMatch = refPath.match(/^#\/components\/responses\/(.+)$/);
  if (componentsMatch) {
    return reusableResponses[componentsMatch[1]] ?? null;
  }

  // Handle #/responses/Name (Swagger 2.0 style, may still be present after conversion)
  const swaggerMatch = refPath.match(/^#\/responses\/(.+)$/);
  if (swaggerMatch) {
    const name = swaggerMatch[1];
    return reusableResponses[name] ?? spec.responses?.[name] ?? null;
  }

  return null;
}
