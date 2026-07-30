import type { OpenAPISpec, Diagnostics } from '../types.js';
import { HTTP_METHODS } from '../types.js';

const RULE = 'sanitize-names';

/** Characters allowed in API Gateway path segments (excluding path params). */
const VALID_SEGMENT = /^[a-zA-Z0-9_\-.,:{}\s]+$/;
const RESERVED_PATHS = new Set(['/ping', '/sping']);

/**
 * Sanitize schema names and path segments for API Gateway compatibility.
 * - Schema names: alphanumeric only (with collision avoidance)
 * - Path segments: alphanumeric, underscores, hyphens, periods, commas, colons, curly braces
 * - Path params must be separate segments
 * - Avoid /ping and /sping (reserved)
 */
export function sanitizeNames(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);

  // Phase 1: Rename schemas
  const schemas = result.components?.schemas;
  if (schemas) {
    const renameMap = buildSchemaRenameMap(schemas, diag);

    if (renameMap.size > 0) {
      // Apply renames to schema keys
      const newSchemas: Record<string, any> = {};
      for (const [oldName, schemaDef] of Object.entries(schemas)) {
        const newName = renameMap.get(oldName) ?? oldName;
        newSchemas[newName] = schemaDef;
      }
      result.components!.schemas = newSchemas;

      // Update all $ref references throughout the spec
      updateRefs(result, renameMap);
    }
  }

  // Phase 2: Sanitize paths
  sanitizePaths(result, diag);

  return result;
}

function buildSchemaRenameMap(
  schemas: Record<string, any>,
  diag: Diagnostics,
): Map<string, string> {
  const renameMap = new Map<string, string>();
  const usedNames = new Set<string>();

  // First pass: build sanitized names
  const pending: Array<[string, string]> = [];
  for (const name of Object.keys(schemas)) {
    const sanitized = name.replace(/[^a-zA-Z0-9]/g, '');
    if (sanitized === name) {
      usedNames.add(name);
    } else {
      pending.push([name, sanitized]);
    }
  }

  // Second pass: assign with collision avoidance
  for (const [original, sanitized] of pending) {
    let finalName = sanitized;
    if (usedNames.has(finalName)) {
      // Collision — add V2, V3, etc.
      let suffix = 2;
      while (usedNames.has(`${sanitized}V${suffix}`)) {
        suffix++;
      }
      finalName = `${sanitized}V${suffix}`;
      diag.warn(RULE, `#/components/schemas/${original}`, 'schema-name-collision', 'renamed',
        `Schema '${original}' collides with existing '${sanitized}', renamed to '${finalName}'`);
    } else {
      diag.info(RULE, `#/components/schemas/${original}`, 'schema-name', 'renamed',
        `Renamed schema '${original}' → '${finalName}'`);
    }
    renameMap.set(original, finalName);
    usedNames.add(finalName);
  }

  return renameMap;
}

function updateRefs(obj: any, renameMap: Map<string, string>): void {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      updateRefs(item, renameMap);
    }
    return;
  }

  if (typeof obj.$ref === 'string') {
    const prefix = '#/components/schemas/';
    if (obj.$ref.startsWith(prefix)) {
      const oldName = obj.$ref.slice(prefix.length);
      const newName = renameMap.get(oldName);
      if (newName) {
        obj.$ref = `${prefix}${newName}`;
      }
    }
    // Also handle Swagger 2.0 style refs that might still be present
    const defPrefix = '#/definitions/';
    if (obj.$ref.startsWith(defPrefix)) {
      const oldName = obj.$ref.slice(defPrefix.length);
      const newName = renameMap.get(oldName);
      if (newName) {
        obj.$ref = `${defPrefix}${newName}`;
      }
    }
  }

  for (const value of Object.values(obj)) {
    updateRefs(value, renameMap);
  }
}

function sanitizePaths(spec: OpenAPISpec, diag: Diagnostics): void {
  // Strip `?`-suffixed path keys (e.g. `/foo?view=all`). API Gateway rejects
  // query strings embedded in path keys.
  stripQueryInPathKeys(spec, diag);

  const paths = spec.paths;
  if (!paths) return;

  const newPaths: Record<string, any> = {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    // Check if path has any operations
    const hasOperations = HTTP_METHODS.some(m => !!(pathItem as Record<string, any>)[m]);
    if (!hasOperations) {
      diag.info(RULE, `#/paths/${path}`, 'empty-path', 'removed',
        `Removed path '${path}' — no HTTP operations (API Gateway rejects empty path items)`);
      continue;
    }

    const segments = path.split('/').filter(Boolean);

    // Check for embedded path parameters (param not in its own segment).
    // embeddedPathParamSplit handles whole-segment forms (`{p}.ext`, `{p}:action`)
    // earlier in the pipeline. This check catches the residual mid-segment
    // cases (e.g. `/resource{id}`, `/prefix-{name}.json`) that can't be
    // auto-rewritten and which API Gateway would reject at deploy time.
    const hasEmbeddedParam = segments.some(seg =>
      seg.includes('{') && !(seg.startsWith('{') && seg.endsWith('}'))
    );
    if (hasEmbeddedParam) {
      diag.breaking(RULE, `#/paths/${path}`, 'embedded-path-param', 'removed',
        `Removed path '${path}' - contains embedded path parameter (API Gateway requires path parameters to be separate segments)`);
      continue;
    }

    // Check for invalid characters in non-parameter segments
    // Valid: alphanumeric, underscore, hyphen, period, comma, colon, curly braces
    let hasInvalidChars = false;
    for (const seg of segments) {
      if (seg.startsWith('{') && seg.endsWith('}')) continue; // path param
      if (!VALID_SEGMENT.test(seg)) {
        hasInvalidChars = true;
        break;
      }
    }
    if (hasInvalidChars) {
      diag.breaking(RULE, `#/paths/${path}`, 'invalid-path-chars', 'removed',
        `Removed path '${path}' — contains characters not supported by API Gateway (only alphanumeric, underscores, hyphens, periods, commas, colons, curly braces allowed)`);
      continue;
    }

    // Flag reserved paths (but don't remove — they still work, just conflict with health checks)
    if (RESERVED_PATHS.has(path)) {
      diag.warn(RULE, `#/paths/${path}`, 'reserved-path', 'flagged',
        `Path '${path}' is reserved by API Gateway for health checks`);
    }

    newPaths[path] = pathItem;
  }

  // Resolve sibling path parameter conflicts:
  // API Gateway only allows one path parameter name per segment position among siblings.
  // Rename losing param names to the winner instead of dropping paths.
  resolveSiblingParamConflicts(newPaths, diag);

  spec.paths = newPaths;
}

/**
 * Resolve sibling path-parameter conflicts by renaming the lower-frequency
 * parameter names to match a winner chosen per conflict point.
 *
 * API Gateway requires that all paths sharing a parent prefix use the same
 * path-parameter name at a given segment position. Instead of dropping the
 * losing paths (which silently removes API surface), we rename the param to
 * the winner. URL shape is unchanged; only the server-visible parameter name
 * differs, which is invisible to HTTP clients.
 *
 * Pass 1: count occurrences of each (conflictKey, paramName) pair.
 * Pass 2: winner = max frequency per key, tiebreak by lexicographically smallest
 *         firstSeen path. For every path whose segment paramName ≠ winner,
 *         rename by substitution. If the renamed path collides with an existing
 *         different path, drop it with a breaking diagnostic (we will not merge
 *         two different operations into one URL).
 */
function resolveSiblingParamConflicts(
  paths: Record<string, any>,
  diag: Diagnostics,
): void {
  type SegmentInfo = { paramName: string; segmentIndex: number; key: string };

  // Pass 1 — frequency and firstSeen
  const frequency = new Map<string, Map<string, number>>();
  const firstSeen = new Map<string, Map<string, string>>();
  const pathSegments = new Map<string, SegmentInfo[]>();

  for (const path of Object.keys(paths)) {
    const segments = path.split('/').filter(Boolean);
    const prefixParts: string[] = [];
    const infos: SegmentInfo[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.startsWith('{') && seg.endsWith('}')) {
        const paramName = seg.slice(1, -1);
        const key = `${i}:${prefixParts.join('/')}`;

        let freqMap = frequency.get(key);
        if (!freqMap) { freqMap = new Map(); frequency.set(key, freqMap); }
        freqMap.set(paramName, (freqMap.get(paramName) ?? 0) + 1);

        let seenMap = firstSeen.get(key);
        if (!seenMap) { seenMap = new Map(); firstSeen.set(key, seenMap); }
        if (!seenMap.has(paramName)) seenMap.set(paramName, path);

        infos.push({ paramName, segmentIndex: i, key });
        prefixParts.push('*');
      } else {
        prefixParts.push(seg);
      }
    }

    if (infos.length > 0) pathSegments.set(path, infos);
  }

  // Pick winner per conflict key (keys with >1 distinct name only).
  const winners = new Map<string, string>();
  for (const [key, freqMap] of frequency) {
    if (freqMap.size < 2) continue;
    let best: { name: string; freq: number; seen: string } | null = null;
    for (const [name, freq] of freqMap) {
      const seen = firstSeen.get(key)!.get(name)!;
      if (best === null || freq > best.freq || (freq === best.freq && seen < best.seen)) {
        best = { name, freq, seen };
      }
    }
    winners.set(key, best!.name);
  }

  if (winners.size === 0) return;

  // Pass 2 — rewrite. Iterate over a snapshot so we can mutate `paths`.
  const originalPathOrder = [...pathSegments.keys()];
  for (const oldPath of originalPathOrder) {
    const infos = pathSegments.get(oldPath)!;
    const segments = oldPath.split('/').filter(Boolean);
    const renames: Array<{ from: string; to: string }> = [];
    for (const info of infos) {
      const winner = winners.get(info.key);
      if (winner && winner !== info.paramName) {
        segments[info.segmentIndex] = `{${winner}}`;
        renames.push({ from: info.paramName, to: winner });
      }
    }
    if (renames.length === 0) continue;

    const newPath = '/' + segments.join('/');
    if (newPath === oldPath) continue;

    if (paths[newPath] !== undefined && paths[newPath] !== paths[oldPath]) {
      // Hard collision — a different path item already occupies newPath.
      diag.breaking(RULE, `#/paths/${oldPath}`, 'sibling-rename-collision', 'removed',
        `Removed path '${oldPath}' — renaming its sibling-conflicting parameter(s) would collide with existing path '${newPath}'. ` +
        `Clients calling '${oldPath}' will receive 404 after deployment.`);
      delete paths[oldPath];
      continue;
    }

    // Move path item and rewrite path-param names inside every operation.
    const pathItem = paths[oldPath];
    delete paths[oldPath];
    paths[newPath] = pathItem;

    if (pathItem && typeof pathItem === 'object') {
      const renameMap = new Map(renames.map(r => [r.from, r.to]));
      for (const method of HTTP_METHODS) {
        const op = (pathItem as Record<string, any>)[method];
        if (!op?.parameters || !Array.isArray(op.parameters)) continue;
        for (const param of op.parameters) {
          if (param?.in === 'path' && renameMap.has(param.name)) {
            param.name = renameMap.get(param.name);
          }
        }
      }
    }

    for (const r of renames) {
      diag.warn(RULE, `#/paths/${oldPath}`, 'sibling-path-param-conflict', 'renamed',
        `Renamed path parameter '{${r.from}}' → '{${r.to}}' to match sibling convention. ` +
        `Path moved: '${oldPath}' → '${newPath}'. URL values are unchanged for clients; ` +
        `backend handlers reading the old parameter name must be updated.`);
    }
  }
}

function stripQueryInPathKeys(spec: OpenAPISpec, diag: Diagnostics): void {
  const paths = spec.paths;
  if (!paths) return;

  const suffixed = Object.keys(paths).filter(k => k.includes('?'));
  if (suffixed.length === 0) return;

  for (const key of suffixed) {
    const idx = key.indexOf('?');
    const base = key.slice(0, idx);

    if (paths[base] !== undefined && paths[base] !== paths[key]) {
      // Collision: sibling base path already exists. Drop the suffixed variant.
      diag.breaking(RULE, `#/paths/${key}`, 'query-in-path-key', 'removed',
        `Removed path '${key}' — query-string suffix in path key collides with sibling '${base}' (API Gateway does not support query strings in path keys)`);
      delete paths[key];
      continue;
    }

    // No collision: rename to stripped form.
    paths[base] = paths[key];
    delete paths[key];
    diag.breaking(RULE, `#/paths/${key}`, 'query-in-path-key', 'converted',
      `Renamed path '${key}' → '${base}' — query-string suffix stripped (API Gateway does not support query strings in path keys). Documented suffix params are NOT auto-promoted to parameters[].`);
  }
}
