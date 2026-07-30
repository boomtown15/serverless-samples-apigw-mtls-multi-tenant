import type { OpenAPISpec, Diagnostics } from '../types.js';
import { HTTP_METHODS } from '../types.js';

const RULE = 'inline-parameter-refs';

/**
 * Inline root-level $ref parameters.
 * API Gateway DefinitionBody import cannot resolve `$ref` to `#/components/parameters/Name`.
 * Resolve these to inline parameter definitions.
 */
export function inlineParameterRefs(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);
  const reusableParameters = result.components?.parameters ?? {};

  const paths = result.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const item = pathItem as Record<string, any>;

    // Inline path-level parameters (paths → pathItem → parameters)
    if (Array.isArray(item.parameters)) {
      item.parameters = inlineParameterArray(
        item.parameters,
        reusableParameters,
        result,
        `#/paths/${path}/parameters`,
        diag,
      );
    }

    // Inline operation-level parameters (paths → method → parameters)
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || !Array.isArray(op.parameters)) continue;

      op.parameters = inlineParameterArray(
        op.parameters,
        reusableParameters,
        result,
        `#/paths/${path}/${method}/parameters`,
        diag,
      );
    }
  }

  return result;
}

function inlineParameterArray(
  parameters: any[],
  reusableParameters: Record<string, any>,
  spec: OpenAPISpec,
  diagnosticPath: string,
  diag: Diagnostics,
): any[] {
  return parameters.map((param, index) => {
    if (!param?.$ref) return param;

    const refPath = param.$ref as string;
    const resolved = resolveRef(refPath, reusableParameters, spec);

    if (resolved) {
      diag.info(RULE, `${diagnosticPath}/${index}`, 'parameter-$ref', 'converted',
        `Inlined parameter $ref '${refPath}'`);
      return structuredClone(resolved);
    }

    diag.warn(RULE, `${diagnosticPath}/${index}`, 'parameter-$ref', 'flagged',
      `Could not resolve parameter $ref '${refPath}'`);
    return param;
  });
}

function resolveRef(
  refPath: string,
  reusableParameters: Record<string, any>,
  spec: OpenAPISpec,
): Record<string, any> | null {
  // Handle #/components/parameters/Name
  const componentsMatch = refPath.match(/^#\/components\/parameters\/(.+)$/);
  if (componentsMatch) {
    return reusableParameters[componentsMatch[1]] ?? null;
  }

  // Handle #/parameters/Name (Swagger 2.0 style, may still be present after conversion)
  const swaggerMatch = refPath.match(/^#\/parameters\/(.+)$/);
  if (swaggerMatch) {
    const name = swaggerMatch[1];
    return reusableParameters[name] ?? spec.parameters?.[name] ?? null;
  }

  // Handle #/paths/~1encoded~1path/parameters/N (cross-path refs)
  const pathParamMatch = refPath.match(/^#\/paths\/(.+)\/parameters\/(\d+)$/);
  if (pathParamMatch) {
    const encodedPath = pathParamMatch[1];
    const paramIndex = parseInt(pathParamMatch[2], 10);
    // Decode JSON Pointer encoding: ~1 → /, ~0 → ~, then URL-decode
    const decodedPath = decodeURIComponent(encodedPath.replace(/~1/g, '/').replace(/~0/g, '~'));
    const pathItem = spec.paths?.[decodedPath];
    if (pathItem && Array.isArray(pathItem.parameters) && pathItem.parameters[paramIndex]) {
      return pathItem.parameters[paramIndex];
    }
  }

  return null;
}
