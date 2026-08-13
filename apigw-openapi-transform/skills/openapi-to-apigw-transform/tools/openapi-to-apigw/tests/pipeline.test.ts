import { describe, it, expect } from 'vitest';
import { runPipeline } from '../src/pipeline.js';
import { createDiagnostics } from '../src/diagnostics.js';
import type { OpenAPISpec, TransformFn } from '../src/types.js';

describe('runPipeline', () => {
  it('applies all transforms in order', () => {
    const spec: OpenAPISpec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/test': {
          get: {
            responses: {
              '200': { description: 'OK' },
            },
          },
        },
      },
      components: {
        schemas: {
          My_Schema: {
            type: 'object',
            discriminator: { propertyName: 'type' },
            nullable: true,
            example: { foo: 'bar' },
          },
        },
      },
    };

    const diag = createDiagnostics();
    const result = runPipeline(spec, diag);

    // Schema should be renamed (sanitize-names)
    expect(result.components.schemas.MySchema).toBeDefined();
    expect(result.components.schemas.My_Schema).toBeUndefined();

    // Unsupported fields removed (json-schema-cleanup)
    expect(result.components.schemas.MySchema.discriminator).toBeUndefined();
    expect(result.components.schemas.MySchema.nullable).toBeUndefined();
    expect(result.components.schemas.MySchema.example).toBeUndefined();

    // Mock integration added
    expect(result.paths['/test'].get['x-amazon-apigateway-integration']).toBeDefined();

    // Request validation added
    expect(result['x-amazon-apigateway-request-validators']).toBeDefined();

    // Diagnostics logged
    expect(diag.entries.length).toBeGreaterThan(0);
  });

  it('handles Swagger 2.0 spec through full pipeline', () => {
    const spec: OpenAPISpec = {
      swagger: '2.0',
      info: { title: 'Petstore', version: '1.0' },
      host: 'api.example.com',
      basePath: '/v1',
      schemes: ['https'],
      produces: ['application/json'],
      paths: {
        '/pets': {
          get: {
            responses: {
              '200': {
                description: 'List of pets',
                schema: { type: 'array', items: { $ref: '#/definitions/Pet' } },
              },
            },
          },
        },
      },
      definitions: {
        Pet: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
      },
    };

    const diag = createDiagnostics();
    const result = runPipeline(spec, diag);

    // Should be converted to 3.0
    expect(result.openapi).toBe('3.0.0');
    expect(result.swagger).toBeUndefined();

    // Schemas should be in components
    expect(result.components.schemas.Pet).toBeDefined();

    // Mock integration added
    const getPets = result.paths['/v1/pets']?.get ?? result.paths['/pets']?.get;
    expect(getPets?.['x-amazon-apigateway-integration']).toBeDefined();
  });

  it('handles OpenAPI 3.1 spec through full pipeline', () => {
    const spec: OpenAPISpec = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0' },
      webhooks: { newItem: { post: { summary: 'New item' } } },
      paths: {
        '/items': {
          get: {
            responses: {
              '200': { description: 'OK' },
            },
          },
        },
      },
      components: {
        schemas: {
          NullableField: { type: ['string', 'null'] },
          ConstStatus: { const: 'active' },
        },
      },
    };

    const diag = createDiagnostics();
    const result = runPipeline(spec, diag);

    expect(result.openapi).toBe('3.0.0');
    expect(result.webhooks).toBeUndefined();
    expect(result.components.schemas.NullableField.type).toBe('string');
    // nullable will be removed by json-schema-cleanup
    expect(result.components.schemas.NullableField.nullable).toBeUndefined();
    expect(result.components.schemas.ConstStatus.enum).toEqual(['active']);
  });

  it('supports custom transforms', () => {
    const spec: OpenAPISpec = { openapi: '3.0.0', paths: {}, custom: false };
    const diag = createDiagnostics();

    const customTransform = (s: OpenAPISpec) => ({ ...s, custom: true });
    const result = runPipeline(spec, diag, [customTransform]);

    expect(result.custom).toBe(true);
  });

  it('wraps transform errors with the transform function name', () => {
    const spec: OpenAPISpec = { openapi: '3.0.0', paths: {} };
    const diag = createDiagnostics();

    function explodingTransform(_s: OpenAPISpec): OpenAPISpec {
      throw new Error('something went wrong');
    }

    expect(() => runPipeline(spec, diag, [explodingTransform])).toThrowError(
      /Transform 'explodingTransform' failed: something went wrong/,
    );
  });

  it('wraps anonymous transform errors with "anonymous"', () => {
    const spec: OpenAPISpec = { openapi: '3.0.0', paths: {} };
    const diag = createDiagnostics();

    // Arrow function assigned to variable loses its name in the wrapper
    const anonTransform = Object.defineProperty(
      (_s: OpenAPISpec) => { throw new Error('boom'); },
      'name',
      { value: '' },
    );

    expect(() => runPipeline(spec, diag, [anonTransform])).toThrowError(
      /Transform 'anonymous' failed: boom/,
    );
  });

  it('forwards context.sourceFilePath to transforms', () => {
    let capturedPath: string | undefined;
    const capturingTransform: TransformFn = (spec, _diag, ctx) => {
      capturedPath = ctx?.sourceFilePath;
      return spec;
    };
    const spec = { openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {} };
    const diag = createDiagnostics();
    runPipeline(spec, diag, [capturingTransform], { sourceFilePath: '/abs/foo.yaml' });
    expect(capturedPath).toBe('/abs/foo.yaml');
  });

  it('handles empty spec gracefully (no paths, no components)', () => {
    const spec: OpenAPISpec = { openapi: '3.0.0' };
    const diag = createDiagnostics();

    // Should not throw even with minimal spec
    const result = runPipeline(spec, diag);

    expect(result).toBeDefined();
    expect(result.openapi).toBe('3.0.0');
  });

  it('integration: RPC + embedded-split + x-prefix securityScheme all compose correctly', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'compose', version: '1' },
      paths: {
        '/#X-Amz-Target=Svc.ListItems': {
          post: { responses: { '200': { description: 'OK' } } },
        },
        '/items/{id}.json': {
          get: { responses: { '200': { description: 'OK' } } },
        },
      },
      components: {
        securitySchemes: {
          'x-custom-auth': { type: 'apiKey', in: 'header', name: 'X-Auth' },
        },
      },
    };
    const diag = createDiagnostics();
    const cleaned = runPipeline(spec, diag);
    // RPC rewritten
    expect(cleaned.paths['/ListItems']).toBeDefined();
    // embedded split
    expect(cleaned.paths['/items/{id}']).toBeDefined();
    // x-prefix scheme survived
    expect(cleaned.components.securitySchemes['x-custom-auth']).toBeDefined();
  });
});
