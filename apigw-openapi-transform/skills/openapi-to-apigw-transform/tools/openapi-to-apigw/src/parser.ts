import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import YAML from 'yaml';
import type { OpenAPISpec } from './types.js';

const SPEC_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

export function parseSpec(filePath: string): OpenAPISpec {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read spec file '${filePath}': ${(err as Error).message}`);
  }
  const ext = extname(filePath).toLowerCase();
  try {
    return ext === '.json' ? JSON.parse(content) : YAML.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse spec file '${filePath}': ${(err as Error).message}`);
  }
}

export function discoverSpecs(inputPath: string): string[] {
  const stat = statSync(inputPath);

  if (stat.isFile()) {
    return [inputPath];
  }

  if (stat.isDirectory()) {
    const files: string[] = [];
    const seenBasenames = new Set<string>();

    // Sort entries so yaml/yml come before json (prefer yaml over json duplicates)
    const entries = readdirSync(inputPath).sort((a, b) => {
      const extA = extname(a).toLowerCase();
      const extB = extname(b).toLowerCase();
      const yamlExts = ['.yaml', '.yml'];
      const aIsYaml = yamlExts.includes(extA);
      const bIsYaml = yamlExts.includes(extB);
      if (aIsYaml && !bIsYaml) return -1;
      if (!aIsYaml && bIsYaml) return 1;
      return a.localeCompare(b);
    });

    for (const entry of entries) {
      const full = join(inputPath, entry);
      if (!statSync(full).isFile() || !SPEC_EXTENSIONS.has(extname(entry).toLowerCase())) continue;

      // Deduplicate: skip if we already have a file with the same basename
      const base = entry.replace(/\.(yaml|yml|json)$/i, '');
      if (seenBasenames.has(base)) continue;

      try {
        const spec = parseSpec(full);
        if (spec.openapi || spec.swagger) {
          files.push(full);
          seenBasenames.add(base);
        }
      } catch (err) {
        // Only swallow parse errors; surface filesystem/permission errors
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Failed to read')) {
          console.warn(`Warning: skipping ${entry}: ${msg}`);
        }
        // Parse errors (malformed YAML/JSON, not an OpenAPI doc) — skip silently
      }
    }
    return files.sort();
  }

  return [];
}

export function serializeSpec(spec: OpenAPISpec, format: 'yaml' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify(spec, null, 2);
  }
  // Use YAML 1.1 schema for serialization so that values ambiguous under
  // YAML 1.1 (e.g. sexagesimal-looking strings like "00:00:00.00") are
  // automatically quoted.  API Gateway's YAML parser follows YAML 1.1
  // rules (SnakeYAML/Java), so unquoted sexagesimal values cause
  // "Invalid OAS input" rejections.
  //
  // aliasDuplicateObjects: false — API Gateway's OpenAPI import rejects
  // YAML anchors (&id001 / *id001). When shared object references exist
  // in the in-memory spec, expand them to independent copies.
  return YAML.stringify(spec, { lineWidth: 0, version: '1.1', aliasDuplicateObjects: false });
}
