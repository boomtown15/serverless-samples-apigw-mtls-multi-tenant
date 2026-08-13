import { describe, it, expect } from 'vitest';
import { inlineSchemaPromotion } from '../../src/transforms/inline-schema-promotion.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('inlineSchemaPromotion', () => {
  it('promotes a #/paths/-scoped inline schema ref into components/schemas', () => {
    const spec: any = {
      openapi: '3.0.0',
      paths: {
        '/people': {
          post: {
            operationId: 'createPerson',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' } } },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/people2': {
          post: {
            requestBody: {
              $ref: '#/paths/~1people/post/requestBody/content/application~1json/schema',
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: { schemas: {} },
    };

    const diag = createDiagnostics();
    const result = inlineSchemaPromotion(spec, diag);

    const names = Object.keys(result.components.schemas);
    expect(names.length).toBe(1);
    const name = names[0];
    expect(result.components.schemas[name]).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    });

    expect(result.paths['/people2'].post.requestBody.$ref).toBe(`#/components/schemas/${name}`);

    const infos = diag.entries.filter(e => e.level === 'info' && e.feature === 'inline-schema-promoted');
    expect(infos.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves normal #/components/schemas refs unchanged', () => {
    const spec: any = {
      openapi: '3.0.0',
      paths: {
        '/a': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Foo' } } },
              },
            },
          },
        },
      },
      components: { schemas: { Foo: { type: 'string' } } },
    };
    const diag = createDiagnostics();
    const result = inlineSchemaPromotion(spec, diag);
    expect(result.paths['/a'].get.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/Foo');
    expect(diag.entries.filter(e => e.feature === 'inline-schema-promoted')).toHaveLength(0);
  });

  it('de-duplicates promoted schema names when distinct targets derive the same base name', () => {
    const schema1 = { type: 'object', properties: { a: { type: 'string' } } };
    const schema2 = { type: 'object', properties: { b: { type: 'string' } } };
    const spec: any = {
      openapi: '3.0.0',
      paths: {
        '/x': {
          post: {
            requestBody: { content: { 'application/json': { schema: schema1 } } },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/y': {
          post: {
            requestBody: { content: { 'application/json': { schema: schema2 } } },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/consumer1': {
          post: {
            requestBody: { $ref: '#/paths/~1x/post/requestBody/content/application~1json/schema' },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/consumer2': {
          post: {
            requestBody: { $ref: '#/paths/~1y/post/requestBody/content/application~1json/schema' },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: { schemas: {} },
    };
    const diag = createDiagnostics();
    const result = inlineSchemaPromotion(spec, diag);
    const names = Object.keys(result.components.schemas);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it('de-duplicates against pre-existing components/schemas entries', () => {
    const spec: any = {
      openapi: '3.0.0',
      paths: {
        '/person': {
          post: {
            operationId: 'createPerson',
            requestBody: {
              content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/consumer': {
          post: {
            requestBody: { $ref: '#/paths/~1person/post/requestBody/content/application~1json/schema' },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: {
        schemas: {
          // A name that collides with what deriveName would produce ('createPersonBody').
          CreatePersonBody: { type: 'string' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = inlineSchemaPromotion(spec, diag);
    const names = Object.keys(result.components.schemas);
    expect(names.length).toBe(2); // pre-existing + uniquified new
    expect(names).toContain('CreatePersonBody');
    // Uniquified entry should have a numeric suffix.
    const suffixedName = names.find(n => n !== 'CreatePersonBody');
    expect(suffixedName).toMatch(/^CreatePersonBody\d+$/);
    // The pre-existing schema must not have been overwritten.
    expect(result.components.schemas.CreatePersonBody).toEqual({ type: 'string' });
  });

  it('skips promoting non-schema targets and emits a warning', () => {
    const spec: any = {
      openapi: '3.0.0',
      paths: {
        '/a': {
          get: {
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } },
            },
          },
        },
        '/b': {
          get: {
            // Points at a Response Object, not a Schema Object.
            responses: { '200': { $ref: '#/paths/~1a/get/responses/200' } },
          },
        },
      },
      components: { schemas: {} },
    };
    const diag = createDiagnostics();
    const result = inlineSchemaPromotion(spec, diag);
    // No schema should have been promoted (Response object isn't a Schema).
    expect(Object.keys(result.components.schemas)).toHaveLength(0);
    // Ref should remain unchanged.
    expect(result.paths['/b'].get.responses['200'].$ref).toBe('#/paths/~1a/get/responses/200');
    // Warning should have been emitted.
    const warns = diag.entries.filter(e => e.level === 'warning' && e.feature === 'inline-schema-promotion-skipped');
    expect(warns).toHaveLength(1);
  });
});
