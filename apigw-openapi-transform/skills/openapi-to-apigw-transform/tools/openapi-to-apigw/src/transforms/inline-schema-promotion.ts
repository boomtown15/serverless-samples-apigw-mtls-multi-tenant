import type { OpenAPISpec, Diagnostics } from '../types.js';

const RULE = 'inline-schema-promotion';

/**
 * Promote inline schemas referenced via `$ref: #/paths/...` into
 * `components/schemas`.
 *
 * Some OpenAPI specs use path-scoped JSON pointers to reuse schemas
 * defined inline in another operation (e.g.
 * `#/paths/~1people/post/requestBody/content/application~1json/schema`).
 * API Gateway's OpenAPI import resolves these refs but assigns a
 * model identifier of `null`, causing `Invalid OAS input` rejection.
 *
 * Strategy:
 *   1. Walk the spec collecting every `$ref` that starts with
 *      `#/paths/` and resolves to a schema object.
 *   2. For each unique target, generate a name (operationId-derived
 *      where possible, otherwise path+method slug) and move the
 *      schema into `components/schemas/<name>`. De-duplicate names
 *      with numeric suffix.
 *   3. Rewrite every ref to the new location.
 *
 * Emits an `info` diagnostic per promotion.
 */
export function inlineSchemaPromotion(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);
  result.components = result.components ?? {};
  result.components.schemas = result.components.schemas ?? {};

  const refsToRewrite: Array<{ holder: any; key: string; targetPath: string }> = [];
  collectPathRefs(result, refsToRewrite);

  if (refsToRewrite.length === 0) return result;

  const promoted = new Map<string, string>();
  for (const { targetPath } of refsToRewrite) {
    if (promoted.has(targetPath)) continue;
    const resolved = resolvePointer(result, targetPath);
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) continue;

    // Only promote values that look like JSON Schema objects. A Response
    // Object or other spec element would have incompatible shape and
    // silently corrupt components/schemas. Skip with a warning.
    if (!looksLikeSchema(resolved)) {
      diag.warn(RULE, targetPath, 'inline-schema-promotion-skipped', 'skipped',
        `Skipped promoting '${targetPath}' — target does not look like a JSON Schema (no type/properties/items/allOf/$ref/etc.)`);
      continue;
    }

    const baseName = deriveName(targetPath, result);
    const uniqueName = uniquify(baseName, result.components.schemas);
    result.components.schemas[uniqueName] = structuredClone(resolved);
    promoted.set(targetPath, uniqueName);

    diag.info(RULE, targetPath, 'inline-schema-promoted', 'converted',
      `Promoted inline schema at '${targetPath}' → '#/components/schemas/${uniqueName}' (API Gateway requires named models)`);
  }

  for (const { holder, key, targetPath } of refsToRewrite) {
    const name = promoted.get(targetPath);
    if (!name) continue;
    holder[key] = `#/components/schemas/${name}`;
  }

  return result;
}

function collectPathRefs(
  obj: any,
  out: Array<{ holder: any; key: string; targetPath: string }>,
): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectPathRefs(item, out);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$ref' && typeof v === 'string' && v.startsWith('#/paths/')) {
      out.push({ holder: obj, key: k, targetPath: v });
    } else {
      collectPathRefs(v, out);
    }
  }
}

function resolvePointer(spec: any, ref: string): any {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: any = spec;
  for (const part of parts) {
    if (cur == null) return null;
    cur = cur[part];
  }
  return cur;
}

function deriveName(ref: string, spec: any): string {
  const parts = ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  const path = parts[1] ?? '';
  const method = parts[2] ?? '';

  const opId = spec.paths?.[path]?.[method]?.operationId;
  if (typeof opId === 'string' && opId.length > 0) {
    return slug(opId + 'Body');
  }

  return slug(path + method + 'Body');
}

function slug(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9]/g, '');
  if (!cleaned) return 'InlineSchema';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function uniquify(base: string, existing: Record<string, any>): string {
  if (!existing[base]) return base;
  let i = 2;
  while (existing[`${base}${i}`]) i++;
  return `${base}${i}`;
}

const SCHEMA_MARKERS = new Set([
  'type', 'properties', 'items', '$ref', 'allOf', 'oneOf', 'anyOf',
  'enum', 'format', 'additionalProperties', 'required', 'pattern',
  'minLength', 'maxLength', 'minimum', 'maximum', 'nullable', 'example',
]);

function looksLikeSchema(obj: Record<string, any>): boolean {
  for (const key of Object.keys(obj)) {
    if (SCHEMA_MARKERS.has(key)) return true;
  }
  return false;
}
