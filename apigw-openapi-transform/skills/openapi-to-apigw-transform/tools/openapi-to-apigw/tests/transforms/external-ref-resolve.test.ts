import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { externalRefResolve } from '../../src/transforms/external-ref-resolve.js';
import { createDiagnostics } from '../../src/diagnostics.js';

const FIXTURES = resolve(__dirname, 'fixtures/external-refs');

describe('externalRefResolve', () => {
  it('inlines an adjacent-file $ref', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' },
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': { schema: { $ref: './other.json#/definitions/Foo' } },
                },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = externalRefResolve(spec, diag, { sourceFilePath: `${FIXTURES}/parent.yaml` });
    const schema = result.paths['/items'].get.responses['200'].content['application/json'].schema;
    expect(schema.$ref).toBeUndefined();
    expect(schema.type).toBe('object');
    expect(schema.properties.id.type).toBe('string');
    const info = diag.entries.filter(e => e.feature === 'external-ref-resolved');
    expect(info).toHaveLength(1);
  });

  it('stubs unreachable file refs with warning', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' },
      paths: {
        '/items': {
          get: { responses: { '200': { description: 'OK',
            content: { 'application/json': { schema: { $ref: './missing.json#/definitions/Bar' } } },
          } } },
        },
      },
    };
    const diag = createDiagnostics();
    const result = externalRefResolve(spec, diag, { sourceFilePath: `${FIXTURES}/parent.yaml` });
    const schema = result.paths['/items'].get.responses['200'].content['application/json'].schema;
    expect(schema.$ref).toBeUndefined();
    expect(schema.type).toBe('object');
    expect(schema.description).toContain('stubbed');
    const warns = diag.entries.filter(e => e.feature === 'external-ref-stubbed');
    expect(warns).toHaveLength(1);
  });

  it('stubs URL $refs with warning (file-only policy)', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {},
      components: { schemas: { Remote: { $ref: 'http://example.com/schema.json#/X' } } },
    };
    const diag = createDiagnostics();
    const result = externalRefResolve(spec, diag, { sourceFilePath: `${FIXTURES}/parent.yaml` });
    expect(result.components.schemas.Remote.$ref).toBeUndefined();
    expect(result.components.schemas.Remote.description).toContain('stubbed');
    const warns = diag.entries.filter(e => e.feature === 'external-ref-stubbed');
    expect(warns).toHaveLength(1);
  });

  it('recursively inlines chained external refs', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {},
      components: { schemas: { Start: { $ref: './chain-a.json#/definitions/A' } } },
    };
    const diag = createDiagnostics();
    const result = externalRefResolve(spec, diag, { sourceFilePath: `${FIXTURES}/parent.yaml` });
    const start = result.components.schemas.Start;
    expect(start.$ref).toBeUndefined();
    expect(start.type).toBe('object');
    expect(start.properties.next.$ref).toBeUndefined();
    expect(start.properties.next.type).toBe('object');
    expect(start.properties.next.properties.value.type).toBe('string');
    const info = diag.entries.filter(e => e.feature === 'external-ref-resolved');
    expect(info.length).toBeGreaterThanOrEqual(2);
  });

  it('stubs on cycle detection', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {},
      components: { schemas: { Start: { $ref: './cycle-a.json#/definitions/A' } } },
    };
    const diag = createDiagnostics();
    externalRefResolve(spec, diag, { sourceFilePath: `${FIXTURES}/parent.yaml` });
    const warns = diag.entries.filter(e => e.feature === 'external-ref-stubbed' && /cycle/.test(e.message));
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it('stubs when depth exceeds cap', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {},
      components: { schemas: { Start: { $ref: './deep/0.json#/definitions/D' } } },
    };
    const diag = createDiagnostics();
    externalRefResolve(spec, diag, { sourceFilePath: `${FIXTURES}/parent.yaml` });
    const warns = diag.entries.filter(e => e.feature === 'external-ref-stubbed' && /depth/.test(e.message));
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves internal-fragment refs alone', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {},
      components: { schemas: { Ref: { $ref: '#/components/schemas/Target' }, Target: { type: 'string' } } },
    };
    const diag = createDiagnostics();
    const result = externalRefResolve(spec, diag);
    expect(result.components.schemas.Ref.$ref).toBe('#/components/schemas/Target');
    expect(diag.entries.filter(e => e.rule === 'external-ref-resolve')).toHaveLength(0);
  });

  it('is a no-op when context.sourceFilePath is missing and only internal refs exist', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {},
      components: { schemas: { X: { $ref: '#/components/schemas/Y' }, Y: { type: 'string' } } },
    };
    const diag = createDiagnostics();
    const result = externalRefResolve(spec, diag);
    expect(result.components.schemas.X.$ref).toBe('#/components/schemas/Y');
  });

  it('stubs when target fragment resolves to a non-object (primitive/null/array)', () => {
    // `other.json` has `definitions.Foo.properties.id.type` = "string" (a primitive)
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {},
      components: {
        schemas: {
          Bad: { $ref: './other.json#/definitions/Foo/properties/id/type' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = externalRefResolve(spec, diag, { sourceFilePath: `${FIXTURES}/parent.yaml` });
    expect(result.components.schemas.Bad.$ref).toBeUndefined();
    expect(result.components.schemas.Bad.type).toBe('object');
    expect(result.components.schemas.Bad.description).toContain('stubbed');
    const warns = diag.entries.filter(e => e.feature === 'external-ref-stubbed');
    expect(warns).toHaveLength(1);
  });
});
