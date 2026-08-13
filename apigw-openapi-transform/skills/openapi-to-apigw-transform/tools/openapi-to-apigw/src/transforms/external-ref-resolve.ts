import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import YAML from 'yaml';
import type { OpenAPISpec, Diagnostics, TransformContext } from '../types.js';

const RULE = 'external-ref-resolve';
const DEPTH_CAP = 10;

/**
 * Resolve external file $refs by inlining target schemas into the spec.
 *
 * Policy:
 *   - File-only: relative refs resolved against context.sourceFilePath
 *   - URL refs (http://, https://) -> stub + warning (out of scope v1.5.0)
 *   - Missing files -> stub + warning
 *   - Recursive: inlined subtrees are re-scanned for further external refs
 *   - Cycle-safe: visited set of (absPath, fragment) pairs; on re-entry, stub
 *   - Depth-capped at DEPTH_CAP=10; beyond, stub
 *
 * A stub has shape { type: 'object', description: 'stubbed: <reason> <original>' }.
 */
export function externalRefResolve(
  spec: OpenAPISpec,
  diag: Diagnostics,
  context?: TransformContext,
): OpenAPISpec {
  const result = structuredClone(spec);
  const baseDir = context?.sourceFilePath ? dirname(context.sourceFilePath) : undefined;
  walkAndResolve(result, '#', diag, baseDir, new Set<string>(), 0);
  return result;
}

function walkAndResolve(
  obj: any,
  path: string,
  diag: Diagnostics,
  baseDir: string | undefined,
  visited: Set<string>,
  depth: number,
): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) walkAndResolve(obj[i], `${path}/${i}`, diag, baseDir, visited, depth);
    return;
  }

  if (typeof obj.$ref === 'string' && !obj.$ref.startsWith('#')) {
    const originalRef = obj.$ref;

    if (/^https?:\/\//i.test(originalRef)) {
      stub(obj, originalRef, 'external ref', diag, path);
      return;
    }

    if (depth >= DEPTH_CAP) {
      stub(obj, originalRef, `depth > ${DEPTH_CAP}`, diag, path);
      return;
    }

    if (!baseDir) {
      stub(obj, originalRef, 'no source file context', diag, path);
      return;
    }

    const [filePart, fragment = ''] = originalRef.split('#');
    const absPath = isAbsolute(filePart) ? filePart : resolve(baseDir, filePart);
    const visitKey = `${absPath}#${fragment}`;

    if (visited.has(visitKey)) {
      stub(obj, originalRef, 'cycle', diag, path);
      return;
    }

    if (!existsSync(absPath)) {
      stub(obj, originalRef, 'external ref', diag, path);
      return;
    }

    let targetSpec: any;
    try {
      const content = readFileSync(absPath, 'utf-8');
      targetSpec = absPath.endsWith('.json') ? JSON.parse(content) : YAML.parse(content);
    } catch {
      stub(obj, originalRef, 'external ref', diag, path);
      return;
    }

    const targetNode = navigateFragment(targetSpec, fragment);
    if (targetNode === undefined || targetNode === null || typeof targetNode !== 'object' || Array.isArray(targetNode)) {
      stub(obj, originalRef, 'external ref', diag, path);
      return;
    }

    const inlined = structuredClone(targetNode);
    delete obj.$ref;
    Object.assign(obj, inlined);

    diag.info(RULE, path, 'external-ref-resolved', 'converted',
      `Inlined external $ref '${originalRef}' from '${absPath}'`);

    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);
    walkAndResolve(obj, path, diag, dirname(absPath), nextVisited, depth + 1);
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#')) continue;
    walkAndResolve(value, `${path}/${key}`, diag, baseDir, visited, depth);
  }
}

function navigateFragment(spec: any, fragment: string): any {
  if (!fragment) return spec;
  const parts = fragment.replace(/^\//, '').split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = spec;
  for (const part of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

function stub(obj: any, originalRef: string, reason: string, diag: Diagnostics, path: string): void {
  delete obj.$ref;
  obj.type = 'object';
  obj.description = `stubbed: ${reason} ${originalRef}`;
  diag.warn(RULE, path, 'external-ref-stubbed', 'flagged',
    `Stubbed external ref: ${reason} '${originalRef}'`);
}
