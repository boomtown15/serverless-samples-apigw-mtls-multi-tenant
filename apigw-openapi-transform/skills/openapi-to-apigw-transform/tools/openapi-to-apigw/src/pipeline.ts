import type { OpenAPISpec, Diagnostics, TransformFn, TransformContext } from './types.js';
import { transforms } from './transforms/index.js';

/**
 * Run the full transformation pipeline on an OpenAPI spec.
 * Each transform receives the spec, diagnostics collector, and optional
 * context (e.g. source file path for relative $ref resolution),
 * and returns a (potentially modified) spec.
 */
export function runPipeline(
  spec: OpenAPISpec,
  diag: Diagnostics,
  customTransforms?: TransformFn[],
  context?: TransformContext,
): OpenAPISpec {
  const pipeline = customTransforms ?? transforms;
  let current = spec;

  for (const transform of pipeline) {
    try {
      current = transform(current, diag, context);
    } catch (err) {
      const name = transform.name || 'anonymous';
      throw new Error(`Transform '${name}' failed: ${(err as Error).message}`, { cause: err });
    }
  }

  return current;
}
