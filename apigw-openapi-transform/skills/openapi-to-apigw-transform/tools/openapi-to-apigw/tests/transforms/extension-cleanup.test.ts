import { describe, it, expect } from 'vitest';
import { extensionCleanup } from '../../src/transforms/extension-cleanup.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('extensionCleanup', () => {
  it('removes unsupported x-* extensions', () => {
    const spec = {
      openapi: '3.0.0',
      paths: { '/test': { 'x-custom-tag': 'foo', get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    const result = extensionCleanup(spec, diag);
    expect(result.paths['/test']['x-custom-tag']).toBeUndefined();
  });

  it('preserves x-amazon-apigateway-* extensions', () => {
    const spec = {
      openapi: '3.0.0',
      'x-amazon-apigateway-api-key-source': 'HEADER',
      paths: {},
    };
    const diag = createDiagnostics();
    const result = extensionCleanup(spec, diag);
    expect(result['x-amazon-apigateway-api-key-source']).toBe('HEADER');
  });

  it('converts x-* enum arrays to standard enum on schema properties', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: {
        schemas: {
          Status: {
            type: 'object',
            properties: {
              code: { type: 'string', 'x-namespaced-enum': ['active', 'inactive', 'pending'] },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = extensionCleanup(spec, diag);
    const code = result.components.schemas.Status.properties.code;
    expect(code.enum).toEqual(['active', 'inactive', 'pending']);
    expect(code['x-namespaced-enum']).toBeUndefined();
  });

  it('does not overwrite existing enum with x-* conversion', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: {
        schemas: {
          Status: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                enum: ['a', 'b'],
                'x-namespaced-enum': ['c', 'd'],
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = extensionCleanup(spec, diag);
    expect(result.components.schemas.Status.properties.code.enum).toEqual(['a', 'b']);
    expect(result.components.schemas.Status.properties.code['x-namespaced-enum']).toBeUndefined();
  });

  it('preserves x-* named response headers', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                headers: {
                  'x-correlation-id': { schema: { type: 'string' } },
                  'Retry-After': { schema: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = extensionCleanup(spec, diag);
    const headers = result.paths['/items'].get.responses['200'].headers;
    expect(headers['x-correlation-id']).toBeDefined();
    expect(headers['Retry-After']).toBeDefined();
  });

  it('preserves x-prefix securityScheme names (not extensions)', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {},
      components: {
        securitySchemes: {
          'x-custom-auth': { type: 'apiKey', in: 'header', name: 'X-Auth' },
          'regularAuth': { type: 'http', scheme: 'bearer' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = extensionCleanup(spec, diag);
    expect(result.components.securitySchemes['x-custom-auth']).toEqual({ type: 'apiKey', in: 'header', name: 'X-Auth' });
    expect(result.components.securitySchemes['regularAuth']).toEqual({ type: 'http', scheme: 'bearer' });
  });

  it('still strips x-* keys nested inside a securityScheme body', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {},
      components: {
        securitySchemes: {
          'x-custom-auth': {
            type: 'apiKey', in: 'header', name: 'X-Auth',
            'x-stripped-nested': 'should-go',
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = extensionCleanup(spec, diag);
    expect(result.components.securitySchemes['x-custom-auth']).toBeDefined();
    expect(result.components.securitySchemes['x-custom-auth']['x-stripped-nested']).toBeUndefined();
  });
});
