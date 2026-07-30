import type { OpenAPISpec, Diagnostics } from '../types.js';
import { HTTP_METHODS } from '../types.js';

const RULE = 'bracket-param-rename';

/** Matches `[X]` or `[$X]` occurrences in a parameter name. */
const BRACKET_PATTERN = /\[(\$?)([A-Za-z0-9_]+)\]/g;

/**
 * Rename query parameters whose names use bracket notation (e.g.
 * `filter[tag]`, `page[number]`, `createdAt[$gte]`). API Gateway's
 * parameter-name regex `^[a-zA-Z0-9:._$-]+$` rejects brackets, so
 * deploys fail with `Invalid mapping expression`.
 *
 * Rewrite rules (keep `$` — it's legal in APIGW identifiers and
 * preserves Mongo-operator semantics):
 *   filter[tag]        -> _tag
 *   page[number]       -> _number
 *   createdAt[$gte]    -> _$gte
 *   a[x][y]            -> _x_y   (flatten left-to-right)
 *
 * Only query parameters are rewritten; header/path/cookie names are
 * left alone (brackets in those positions are unusual and handled
 * elsewhere).
 *
 * Emits a `warning` per rename and a `breaking` entry with
 * feature=`query-param-renamed` so the change surfaces in
 * `breaking-changes.json` (URL query keys change from the client's
 * perspective).
 */
export function bracketParamRename(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);
  const paths = result.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const item = pathItem as Record<string, any>;

    if (Array.isArray(item.parameters)) {
      renameParams(item.parameters, `#/paths/${path}/parameters`, diag);
    }

    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op?.parameters || !Array.isArray(op.parameters)) continue;
      renameParams(op.parameters, `#/paths/${path}/${method}/parameters`, diag);
    }
  }

  return result;
}

function renameParams(params: any[], basePath: string, diag: Diagnostics): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (!p || p.$ref) continue;
    if (p.in !== 'query') continue;
    const original = p.name;
    if (typeof original !== 'string' || !original.includes('[')) continue;

    const renamed = rename(original);
    if (renamed === original) continue;

    p.name = renamed;

    diag.warn(RULE, `${basePath}/${i}`, 'bracket-query-param', 'renamed',
      `Renamed query parameter '${original}' → '${renamed}' (API Gateway rejects brackets in parameter names)`,
      { original, renamed, in: 'query' });
    diag.breaking(RULE, `${basePath}/${i}`, 'query-param-renamed', 'renamed',
      `Query key '${original}' is now '${renamed}'. Clients sending the old key will lose that value; update client URLs.`,
      { original, renamed, in: 'query' });
  }
}

function rename(name: string): string {
  let out = '';
  let i = 0;
  let matched = false;
  const re = new RegExp(BRACKET_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) {
    matched = true;
    out += `_${m[1]}${m[2]}`;
    i = re.lastIndex;
  }
  if (!matched) return name;
  out += name.slice(i);
  return out;
}
