import type { OpenAPISpec, Diagnostics } from '../types.js';

const RULE = 'rpc-fragment-path';
const RPC_PATH_RE = /^\/#X-Amz-Target=([^.]+)\.([^/?]+)$/;

/**
 * Rewrite AWS JSON-RPC fragment paths to plain operation paths.
 *
 *   /#X-Amz-Target=Service.Operation  ->  /{Operation}
 *
 * Service prefix dropped (one spec = one service). PascalCase preserved.
 * Original path attached to pathItem via `x-original-path` for traceability.
 * On collision with an existing key, the RPC variant is dropped (breaking).
 */
export function rpcFragmentPath(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  if (!spec.paths) return spec;
  const result = structuredClone(spec);
  const paths = result.paths as Record<string, any>;

  for (const originalKey of Object.keys(paths)) {
    const match = RPC_PATH_RE.exec(originalKey);
    if (!match) continue;
    const op = match[2];
    const newKey = `/${op}`;

    if (paths[newKey] !== undefined) {
      diag.breaking(RULE, `#/paths/${originalKey}`, 'rpc-fragment-path-collision', 'removed',
        `Dropped RPC path '${originalKey}' - collides with existing '${newKey}'`);
      delete paths[originalKey];
      continue;
    }

    const pathItem = paths[originalKey];
    if (pathItem && typeof pathItem === 'object') {
      pathItem['x-original-path'] = originalKey;
    }
    paths[newKey] = pathItem;
    delete paths[originalKey];
    diag.warn(RULE, `#/paths/${originalKey}`, 'rpc-fragment-path-rewritten', 'renamed',
      `Rewrote RPC path '${originalKey}' to '${newKey}'`);
  }

  return result;
}
