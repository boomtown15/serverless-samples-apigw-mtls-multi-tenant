import { describe, it, expect } from 'vitest';
import { openapi31Downgrade } from '../../src/transforms/openapi31-downgrade.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('openapi31Downgrade', () => {
  it('passes through OpenAPI 3.0 specs unchanged', () => {
    const spec = { openapi: '3.0.0', info: { title: 'Test', version: '1.0' }, paths: {} };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.openapi).toBe('3.0.0');
    expect(diag.entries).toHaveLength(0);
  });

  it('downgrades 3.1 to 3.0.0', () => {
    const spec = { openapi: '3.1.0', info: { title: 'Test', version: '1.0' }, paths: {} };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.openapi).toBe('3.0.0');
  });

  it('removes webhooks', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      webhooks: { newPet: { post: { summary: 'New pet' } } },
      paths: {},
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.webhooks).toBeUndefined();
    expect(diag.entries.some(e => e.feature === 'webhooks')).toBe(true);
  });

  it('removes jsonSchemaDialect', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
      paths: {},
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.jsonSchemaDialect).toBeUndefined();
  });

  it('converts type arrays with null to nullable', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Foo: { type: ['string', 'null'], description: 'Nullable string' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.components.schemas.Foo.type).toBe('string');
    expect(result.components.schemas.Foo.nullable).toBe(true);
  });

  it('converts multi-type arrays to oneOf', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Bar: { type: ['string', 'integer'] },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.components.schemas.Bar.oneOf).toEqual([{ type: 'string' }, { type: 'integer' }]);
    expect(result.components.schemas.Bar.type).toBeUndefined();
  });

  it('converts const to single-value enum', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Status: { const: 'active' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.components.schemas.Status.enum).toEqual(['active']);
    expect(result.components.schemas.Status.const).toBeUndefined();
  });

  it('converts $dynamicRef to $ref', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Tree: {
            type: 'object',
            properties: {
              children: { $dynamicRef: '#node' },
            },
            $dynamicAnchor: 'node',
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.components.schemas.Tree.properties.children.$ref).toBe('#node');
    expect(result.components.schemas.Tree.properties.children.$dynamicRef).toBeUndefined();
    expect(result.components.schemas.Tree.$dynamicAnchor).toBeUndefined();
  });

  it('removes contentEncoding and contentMediaType', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Base64File: {
            type: 'string',
            contentEncoding: 'base64',
            contentMediaType: 'image/png',
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.components.schemas.Base64File.contentEncoding).toBeUndefined();
    expect(result.components.schemas.Base64File.contentMediaType).toBeUndefined();
  });

  it('strips null from enum arrays and sets nullable', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/test': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      properties: {
                        status: { type: 'string', enum: [null, 'active', 'inactive'] },
                        code: { type: 'integer', enum: [null, 301, 302, 307] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    const props = result.paths['/test'].get.responses['200'].content['application/json'].schema.properties;
    expect(props.status.enum).toEqual(['active', 'inactive']);
    expect(props.status.nullable).toBe(true);
    expect(props.code.enum).toEqual([301, 302, 307]);
    expect(props.code.nullable).toBe(true);
  });

  it('leaves enum arrays without null unchanged', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/test': {
          get: {
            responses: { '200': { content: { 'application/json': { schema: { type: 'string', enum: ['a', 'b'] } } } } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.paths['/test'].get.responses['200'].content['application/json'].schema.enum).toEqual(['a', 'b']);
    expect(result.paths['/test'].get.responses['200'].content['application/json'].schema.nullable).toBeUndefined();
  });

  it('converts oneOf with sibling type:null to nullable', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/test': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      properties: {
                        field: {
                          oneOf: [{ type: 'string' }, { type: 'number' }],
                          type: 'null',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    const field = result.paths!['/test']!.get.responses['200'].content['application/json'].schema.properties.field;
    expect(field.nullable).toBe(true);
    expect(field.type).toBeUndefined();
    expect(field.oneOf).toBeDefined();
  });

  it('does not mutate the original spec', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      webhooks: { x: {} },
      paths: {},
    };
    const diag = createDiagnostics();
    openapi31Downgrade(spec, diag);
    expect(spec.webhooks).toBeDefined();
    expect(spec.openapi).toBe('3.1.0');
  });

  it('removes 3.1-only propertyNames keyword with warning', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Config: {
            type: 'object',
            propertyNames: { pattern: '^[a-z]+$' },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.components!.schemas!.Config.propertyNames).toBeUndefined();
    expect(diag.entries.some(e => e.feature === 'propertyNames' && e.level === 'warning')).toBe(true);
  });

  it('removes inline definitions block in schemas with warning', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          DataConnection: {
            type: 'object',
            definitions: {
              SubType: { type: 'string' },
            },
            properties: {
              name: { type: 'string' },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.components!.schemas!.DataConnection.definitions).toBeUndefined();
    expect(result.components!.schemas!.DataConnection.properties).toBeDefined();
    expect(diag.entries.some(e => e.feature === 'definitions' && e.level === 'warning')).toBe(true);
  });

  it('promotes nested definitions to top-level and rewrites $ref', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/test': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Parent/definitions/Child' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Parent: {
            type: 'object',
            definitions: {
              Child: { type: 'string', description: 'nested child' },
            },
            properties: { name: { type: 'string' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    // Promoted schema exists at top level
    expect(result.components!.schemas!.Parent_Child).toEqual({ type: 'string', description: 'nested child' });
    // $ref rewritten
    expect(result.paths!['/test'].get.responses['200'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/Parent_Child');
    // Original definitions block removed
    expect(result.components!.schemas!.Parent.definitions).toBeUndefined();
    expect(diag.entries.some(e => e.feature === 'promoted-definition')).toBe(true);
  });

  it('promotes property $ref to top-level schema', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Connection: {
            type: 'object',
            properties: {
              created: { type: 'string', format: 'date-time' },
              lastUpdated: { $ref: '#/components/schemas/Connection/properties/created' },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    // Property promoted to top-level
    expect(result.components!.schemas!.Connection_created).toEqual({ type: 'string', format: 'date-time' });
    // $ref rewritten
    expect(result.components!.schemas!.Connection.properties.lastUpdated.$ref)
      .toBe('#/components/schemas/Connection_created');
  });

  it('skips promotion when name collides with existing schema', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Parent_Child: { type: 'number' },
          Parent: {
            type: 'object',
            definitions: {
              Child: { type: 'string' },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    // Existing schema not overwritten
    expect(result.components!.schemas!.Parent_Child).toEqual({ type: 'number' });
    expect(diag.entries.some(e => e.feature === 'promoted-definition' && e.action === 'skipped')).toBe(true);
  });

  it('removes prefixItems and unevaluatedProperties with warnings', () => {
    const spec = {
      openapi: '3.1.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Tuple: {
            type: 'array',
            prefixItems: [{ type: 'string' }, { type: 'number' }],
          },
          Strict: {
            type: 'object',
            unevaluatedProperties: false,
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = openapi31Downgrade(spec, diag);
    expect(result.components!.schemas!.Tuple.prefixItems).toBeUndefined();
    expect(result.components!.schemas!.Strict.unevaluatedProperties).toBeUndefined();
    expect(diag.entries.filter(e => e.level === 'warning' &&
      (e.feature === 'prefixItems' || e.feature === 'unevaluatedProperties')
    )).toHaveLength(2);
  });

  it('emits breaking diagnostic when source has only webhooks (no paths)', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Webhooks', version: '1' },
      webhooks: {
        newEvent: { post: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    openapi31Downgrade(spec, diag);
    const breaking = diag.entries.filter(e => e.level === 'breaking' && e.feature === 'no-deployable-paths-webhooks-only');
    expect(breaking).toHaveLength(1);
    expect(breaking[0].message).toContain('webhooks');
  });

  it('does NOT emit no-deployable-paths breaking when paths also present', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Mixed', version: '1' },
      paths: { '/items': { get: { responses: { '200': { description: 'OK' } } } } },
      webhooks: { x: { post: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    openapi31Downgrade(spec, diag);
    const breaking = diag.entries.filter(e => e.feature === 'no-deployable-paths-webhooks-only');
    expect(breaking).toHaveLength(0);
  });
});
