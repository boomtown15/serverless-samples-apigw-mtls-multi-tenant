import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { parseSpec, discoverSpecs, serializeSpec } from '../src/parser.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const TEMP_DIR = join(__dirname, 'fixtures', '_temp_parser_test');

describe('parseSpec', () => {
  it('parses a valid YAML fixture file', () => {
    const filePath = join(FIXTURES_DIR, 'swagger20-petstore.yaml');
    const spec = parseSpec(filePath);

    expect(spec).toBeDefined();
    expect(typeof spec).toBe('object');
    expect(spec.swagger).toBe('2.0');
    expect(spec.info.title).toContain('Petstore');
  });

  it('parses an OpenAPI 3.0 YAML fixture', () => {
    const filePath = join(FIXTURES_DIR, 'openapi30-complex-schemas.yaml');
    const spec = parseSpec(filePath);

    expect(spec.openapi).toBe('3.0.0');
    expect(spec.paths).toBeDefined();
  });

  it('throws with "Failed to read" for non-existent file', () => {
    expect(() => parseSpec('/nonexistent/path/to/spec.yaml')).toThrowError('Failed to read');
  });

  it('result has openapi or swagger field', () => {
    const spec30 = parseSpec(join(FIXTURES_DIR, 'openapi30-complex-schemas.yaml'));
    expect(spec30.openapi).toBeDefined();

    const specSwagger = parseSpec(join(FIXTURES_DIR, 'swagger20-petstore.yaml'));
    expect(specSwagger.swagger).toBeDefined();
  });
});

describe('discoverSpecs', () => {
  it('returns array with single file when given a file path', () => {
    const filePath = join(FIXTURES_DIR, 'swagger20-petstore.yaml');
    const result = discoverSpecs(filePath);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(filePath);
  });

  it('returns multiple files from the fixtures directory', () => {
    const result = discoverSpecs(FIXTURES_DIR);

    expect(result.length).toBeGreaterThan(1);
    // All returned paths should end with valid extensions
    for (const file of result) {
      expect(file).toMatch(/\.(yaml|yml|json)$/);
    }
  });

  describe('YAML over JSON deduplication', () => {
    beforeAll(() => {
      mkdirSync(TEMP_DIR, { recursive: true });
      // Create a YAML file
      writeFileSync(
        join(TEMP_DIR, 'api-spec.yaml'),
        'openapi: "3.0.0"\ninfo:\n  title: Test\n  version: "1.0"\npaths: {}\n',
      );
      // Create a JSON duplicate with the same base name
      writeFileSync(
        join(TEMP_DIR, 'api-spec.json'),
        JSON.stringify({ openapi: '3.0.0', info: { title: 'Test', version: '1.0' }, paths: {} }),
      );
      // Create a second YAML-only spec
      writeFileSync(
        join(TEMP_DIR, 'another.yml'),
        'openapi: "3.0.0"\ninfo:\n  title: Another\n  version: "1.0"\npaths: {}\n',
      );
    });

    afterAll(() => {
      rmSync(TEMP_DIR, { recursive: true, force: true });
    });

    it('prefers YAML over JSON when both exist with same base name', () => {
      const result = discoverSpecs(TEMP_DIR);

      // Should have 2 specs: api-spec (YAML preferred) and another
      expect(result).toHaveLength(2);

      const basenames = result.map(f => f.split('/').pop());
      expect(basenames).toContain('api-spec.yaml');
      expect(basenames).not.toContain('api-spec.json');
      expect(basenames).toContain('another.yml');
    });
  });
});

describe('serializeSpec', () => {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0' },
    paths: {},
  };

  it('serializes to YAML format', () => {
    const result = serializeSpec(spec, 'yaml');

    expect(typeof result).toBe('string');
    expect(result).toContain('openapi:');
    expect(result).toContain('title: Test');
  });

  it('serializes to valid JSON format', () => {
    const result = serializeSpec(spec, 'json');

    expect(typeof result).toBe('string');
    // Should be parseable JSON
    const parsed = JSON.parse(result);
    expect(parsed.openapi).toBe('3.0.0');
    expect(parsed.info.title).toBe('Test');
  });

  it('JSON output is pretty-printed with 2-space indent', () => {
    const result = serializeSpec(spec, 'json');
    // Second line should start with 2-space indent
    const lines = result.split('\n');
    expect(lines[1]).toMatch(/^ {2}"/);
  });

  it('quotes YAML 1.1 sexagesimal-looking string values to prevent API Gateway rejection', () => {
    const specWithSexagesimal = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          TestSchema: {
            type: 'object',
            properties: {
              timecode: {
                type: 'string',
                pattern: '00:00:00.00',
              },
            },
          },
        },
      },
    };

    const result = serializeSpec(specWithSexagesimal, 'yaml');
    // The sexagesimal-looking value must be quoted so that YAML 1.1 parsers
    // (like SnakeYAML used by API Gateway) do not misinterpret it as a number.
    expect(result).toContain('pattern: "00:00:00.00"');
  });
});

describe('serializeSpec anchor expansion', () => {
  it('emits no YAML anchors even when objects are shared by reference', () => {
    const sharedSchema = { type: 'string', maxLength: 10 };
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/a': { get: { responses: { '200': { description: 'ok', schema: sharedSchema } } } },
        '/b': { get: { responses: { '200': { description: 'ok', schema: sharedSchema } } } },
      },
    };
    const out = serializeSpec(spec, 'yaml');
    // Match any YAML anchor (&name) or alias (*name), not just &id1-style.
    // The `yaml` library emits &a1/*a1 by default, so the narrower regex
    // would pass even when anchors are present. These broader patterns
    // use a trailing space/newline so they don't match `*` in YAML list
    // markers or `&` in unrelated content.
    expect(out).not.toMatch(/&[a-zA-Z_]\w*\s/);
    expect(out).not.toMatch(/\*[a-zA-Z_]\w*\s/);
  });
});
