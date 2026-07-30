import { describe, it, expect } from 'vitest';
import { jsonSchemaCleanup } from '../../src/transforms/json-schema-cleanup.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('jsonSchemaCleanup', () => {
  it('removes discriminator from schemas', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Pet: { type: 'object', discriminator: { propertyName: 'petType' } } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Pet.discriminator).toBeUndefined();
    expect(diag.entries.some(e => e.feature === 'discriminator')).toBe(true);
  });

  it('removes nullable from schemas', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Name: { type: 'string', nullable: true } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Name.nullable).toBeUndefined();
  });

  it('removes example from schemas', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Id: { type: 'integer', example: 42 } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Id.example).toBeUndefined();
  });

  it('removes examples from schemas', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Color: { type: 'string', examples: ['red', 'blue'] } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Color.examples).toBeUndefined();
  });

  it('removes deprecated from schemas', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Old: { type: 'string', deprecated: true } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Old.deprecated).toBeUndefined();
  });

  it('removes readOnly from schemas', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Id: { type: 'integer', readOnly: true } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Id.readOnly).toBeUndefined();
  });

  it('removes default from schema properties', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Status: { type: 'string', default: 'active' } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Status.default).toBeUndefined();
  });

  it('preserves default in response codes (responses object key)', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            responses: {
              '200': { description: 'OK' },
              default: { description: 'Error' },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.paths['/test'].get.responses.default).toBeDefined();
  });

  it('removes format:decimal', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Price: { type: 'number', format: 'decimal' } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Price.format).toBeUndefined();
  });

  it('converts Int32 on number to integer', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Count: { type: 'number', format: 'int32' } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Count.type).toBe('integer');
  });

  it('converts Int64 on number to integer', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { BigId: { type: 'number', format: 'int64' } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.BigId.type).toBe('integer');
  });

  it('removes exclusiveMinimum', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { Age: { type: 'integer', exclusiveMinimum: 0 } } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components.schemas.Age.exclusiveMinimum).toBeUndefined();
  });

  it('wraps primitive response types in object refs', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/health': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.paths['/health'].get.responses['200'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/StringResponse');
    expect(result.components.schemas.StringResponse).toEqual({ type: 'string' });
  });

  it('preserves schemas named after unsupported keywords (e.g. "deprecated")', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: {
        deprecated: { type: 'object', properties: { name: { type: 'string' } } },
        example: { type: 'object', properties: { value: { type: 'string' } } },
        Normal: { type: 'object', deprecated: true, example: 'test' },
      } },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    // Schema definitions named "deprecated"/"example" must survive
    expect(result.components.schemas.deprecated).toBeDefined();
    expect(result.components.schemas.deprecated.type).toBe('object');
    expect(result.components.schemas.example).toBeDefined();
    // But the "deprecated" and "example" fields on Normal schema should be removed
    expect(result.components.schemas.Normal.deprecated).toBeUndefined();
    expect(result.components.schemas.Normal.example).toBeUndefined();
  });

  it('flattens allOf with $ref in response schema', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      allOf: [
                        { $ref: '#/components/schemas/Base' },
                        { $ref: '#/components/schemas/Extra' },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Base: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
          Extra: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      },
    };
    const result = jsonSchemaCleanup(spec, createDiagnostics());
    const schema = result.paths['/items'].get.responses['200'].content['application/json'].schema;
    expect(schema.allOf).toBeUndefined();
    expect(schema.type).toBe('object');
    expect(schema.properties.id).toBeDefined();
    expect(schema.properties.name).toBeDefined();
    expect(schema.required).toEqual(['name']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('flattens oneOf in response schema using first entry', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      oneOf: [
                        { $ref: '#/components/schemas/TypeA' },
                        { $ref: '#/components/schemas/TypeB' },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          TypeA: { type: 'object', properties: { a: { type: 'string' } } },
          TypeB: { type: 'object', properties: { b: { type: 'integer' } } },
        },
      },
    };
    const result = jsonSchemaCleanup(spec, createDiagnostics());
    const schema = result.paths['/items'].get.responses['200'].content['application/json'].schema;
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties.a).toBeDefined();
  });

  it('does NOT flatten allOf inside components/schemas', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: {
        Pet: { allOf: [{ $ref: '#/components/schemas/Animal' }, { type: 'object', properties: { name: { type: 'string' } } }] },
        Animal: { type: 'object', properties: { legs: { type: 'integer' } } },
      } },
    };
    const result = jsonSchemaCleanup(spec, createDiagnostics());
    expect(result.components.schemas.Pet.allOf).toBeDefined();
  });

  it('removes non-standard format values', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Period: { type: 'string', format: 'period' },
          Normal: { type: 'string', format: 'date-time' },
          Custom: { type: 'string', format: 'string' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components!.schemas!.Period.format).toBeUndefined();
    expect(result.components!.schemas!.Normal.format).toBe('date-time');
    expect(result.components!.schemas!.Custom.format).toBeUndefined();
  });

  it('deduplicates enum values', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {},
      components: {
        schemas: {
          Code: { type: 'string', enum: ['A', 'B', 'A', 'C', 'B'] },
        },
      },
    };
    const diag = createDiagnostics();
    const result = jsonSchemaCleanup(spec, diag);
    expect(result.components!.schemas!.Code.enum).toEqual(['A', 'B', 'C']);
  });

  it('does not mutate original spec', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { schemas: { X: { type: 'string', nullable: true } } },
    };
    const diag = createDiagnostics();
    jsonSchemaCleanup(spec, diag);
    expect(spec.components.schemas.X.nullable).toBe(true);
  });

  describe('literal-comment-end sanitisation', () => {
    it('rewrites */ in schema description to * /', () => {
      const spec = {
        openapi: '3.0.0', paths: {},
        components: {
          schemas: {
            Cron: {
              type: 'object',
              description: 'Cron expression. Example: */5 means every 5 minutes.',
              properties: { expr: { type: 'string' } },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = jsonSchemaCleanup(spec as any, diag);
      const desc = (result.components as any).schemas.Cron.description;
      expect(desc).not.toContain('*/');
      expect(desc).toContain('* /');
      const entries = diag.entries.filter(e => e.feature === 'literal-comment-end-in-description');
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('info');
      expect(entries[0].action).toBe('converted');
    });

    it('rewrites */ in schema title to * /', () => {
      const spec = {
        openapi: '3.0.0', paths: {},
        components: {
          schemas: {
            Weird: {
              title: 'Has a */ in its title',
              type: 'object',
              properties: {},
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = jsonSchemaCleanup(spec as any, diag);
      const title = (result.components as any).schemas.Weird.title;
      expect(title).not.toContain('*/');
      expect(title).toContain('* /');
      const entries = diag.entries.filter(e => e.feature === 'literal-comment-end-in-title');
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('info');
    });

    it('emits warning for */ in other string fields without modifying them', () => {
      const spec = {
        openapi: '3.0.0', paths: {},
        components: {
          schemas: {
            Odd: {
              type: 'object',
              properties: {
                code: { type: 'string', pattern: '^\\*/foo' },
              },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = jsonSchemaCleanup(spec as any, diag);
      expect((result.components as any).schemas.Odd.properties.code.pattern).toBe('^\\*/foo');
      const warnings = diag.entries.filter(e => e.feature === 'literal-comment-end-in-other-field');
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0].level).toBe('warning');
      expect(warnings[0].action).toBe('flagged');
    });

    it('does not emit anything when no */ is present', () => {
      const spec = {
        openapi: '3.0.0', paths: {},
        components: {
          schemas: {
            Clean: {
              type: 'object',
              description: 'Normal description without any problem',
              properties: { a: { type: 'string' } },
            },
          },
        },
      };
      const diag = createDiagnostics();
      jsonSchemaCleanup(spec as any, diag);
      expect(diag.entries.filter(e => e.feature.startsWith('literal-comment-end'))).toHaveLength(0);
    });
  });
});
