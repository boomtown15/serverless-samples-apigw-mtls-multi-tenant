import type { OpenAPISpec, Diagnostics } from '../types.js';

const RULE = 'embedded-path-param-split';

const EXT_SUFFIX_RE = /^(\{[^}]+\})\.([A-Za-z0-9_]+)$/;
const ACTION_SUFFIX_RE = /^(\{[^}]+\}):([A-Za-z0-9_]+)$/;

/**
 * Auto-split embedded path parameters into valid API Gateway path form.
 *
 *   /{id}.json        -> /{id}             (file-extension suffix; strip)
 *   /{formId}:action  -> /{formId}/action  (action verb; split into sub-path)
 *
 * On collision with an existing sibling key, the rewritten variant is
 * dropped with a `breaking` diagnostic.
 *
 * Diagnostic locator uses the original path (matching codebase rename idiom).
 * `x-original-path` is set on the pathItem as a best-effort inspection aid;
 * it may later be stripped by `extensionCleanup` but the diagnostic carries
 * authoritative traceability.
 */
export function embeddedPathParamSplit(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  if (!spec.paths) return spec;
  const result = structuredClone(spec);
  const paths = result.paths as Record<string, any>;

  for (const originalKey of Object.keys(paths)) {
    const rewritten = rewritePath(originalKey);
    if (rewritten === null || rewritten === originalKey) continue;

    if (paths[rewritten] !== undefined) {
      diag.breaking(RULE, `#/paths/${originalKey}`, 'embedded-path-param-collision', 'removed',
        `Dropped path '${originalKey}' - rewritten form '${rewritten}' collides with existing sibling`);
      delete paths[originalKey];
      continue;
    }

    const pathItem = paths[originalKey];
    if (pathItem && typeof pathItem === 'object') {
      pathItem['x-original-path'] = originalKey;
    }
    paths[rewritten] = pathItem;
    delete paths[originalKey];
    diag.warn(RULE, `#/paths/${originalKey}`, 'embedded-path-param-split', 'renamed',
      `Split embedded path param: '${originalKey}' -> '${rewritten}'`);
  }

  return result;
}

function rewritePath(path: string): string | null {
  const segments = path.split('/');
  let changed = false;
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '') { out.push(seg); continue; }
    const extMatch = seg.match(EXT_SUFFIX_RE);
    if (extMatch) {
      out.push(extMatch[1]);
      changed = true;
      continue;
    }
    const actMatch = seg.match(ACTION_SUFFIX_RE);
    if (actMatch) {
      out.push(actMatch[1]);
      out.push(actMatch[2]);
      changed = true;
      continue;
    }
    out.push(seg);
  }
  return changed ? out.join('/') : null;
}
