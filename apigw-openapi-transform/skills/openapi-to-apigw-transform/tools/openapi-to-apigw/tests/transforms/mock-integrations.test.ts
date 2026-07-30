import { describe, it, expect } from 'vitest';
import { mockIntegrations } from '../../src/transforms/mock-integrations.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('mockIntegrations', () => {
  it('adds mock integration to every operation', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/pets': {
          get: { responses: { '200': { description: 'OK' } } },
          post: { responses: { '201': { description: 'Created' } } },
        },
      },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    expect(result.paths['/pets'].get['x-amazon-apigateway-integration'].type).toBe('mock');
    expect(result.paths['/pets'].post['x-amazon-apigateway-integration'].type).toBe('mock');
  });

  it('matches primary success response code', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items': {
          post: { responses: { '201': { description: 'Created' }, '400': { description: 'Bad' } } },
        },
      },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    const integration = result.paths['/items'].post['x-amazon-apigateway-integration'];
    expect(integration.responses.default.statusCode).toBe('201');
  });

  it('defaults to 200 when no success code defined', () => {
    const spec = {
      openapi: '3.0.0',
      paths: { '/x': { get: { responses: { '400': { description: 'Error' } } } } },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    expect(result.paths['/x'].get['x-amazon-apigateway-integration']
      .requestTemplates['application/json']).toContain('200');
  });

  it('adds request templates for each request content type', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/data': {
          post: {
            requestBody: {
              content: {
                'application/json': { schema: {} },
                'application/xml': { schema: {} },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    const templates = result.paths['/data'].post['x-amazon-apigateway-integration'].requestTemplates;
    expect(templates['application/json']).toBeDefined();
    expect(templates['application/xml']).toBeDefined();
  });

  it('detects binary content types and adds api-level extension', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/upload': {
          post: {
            requestBody: { content: { 'multipart/form-data': { schema: {} } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    expect(result['x-amazon-apigateway-binary-media-types']).toContain('multipart/form-data');
  });

  it('does not overwrite existing integrations', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            'x-amazon-apigateway-integration': { type: 'http', uri: 'https://backend.com' },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    expect(result.paths['/test'].get['x-amazon-apigateway-integration'].type).toBe('http');
  });

  it('adds response templates for response content types', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/data': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': { schema: {} },
                  'application/jose+jwe': { schema: {} },
                },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    const respTemplates = result.paths['/data'].get['x-amazon-apigateway-integration']
      .responses.default.responseTemplates;
    expect(respTemplates['application/json']).toBeDefined();
    expect(respTemplates['application/jose+jwe']).toBeDefined();
  });

  it('fixes content type typos like applcation/json', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/test': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: { 'applcation/json': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    const content = result.paths!['/test']!.get.responses['200'].content;
    expect(content['application/json']).toBeDefined();
    expect(content['applcation/json']).toBeUndefined();
  });

  it('converts wildcard status codes (5XX → 500)', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/test': {
          get: {
            responses: {
              '200': { description: 'OK' },
              '5XX': { description: 'Server Error' },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    expect(result.paths!['/test']!.get.responses['500']).toBeDefined();
    expect(result.paths!['/test']!.get.responses['5XX']).toBeUndefined();
    expect(diag.entries.some(e => e.feature === 'wildcard-status-code')).toBe(true);
  });

  it('corrects swapped content types like plain/text to text/plain', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/source': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: { 'plain/text': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
    };
    const result = mockIntegrations(spec, createDiagnostics());
    const content = result.paths['/source'].get.responses['200'].content;
    expect(content['text/plain']).toBeDefined();
    expect(content['plain/text']).toBeUndefined();
  });

  it('adds mock integration to x-amazon-apigateway-any-method', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/catch-all': {
          'x-amazon-apigateway-any-method': {
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const result = mockIntegrations(spec, createDiagnostics());
    const anyMethod = result.paths['/catch-all']['x-amazon-apigateway-any-method'];
    expect(anyMethod['x-amazon-apigateway-integration']).toBeDefined();
    expect(anyMethod['x-amazon-apigateway-integration'].type).toBe('mock');
  });

  it('adds default 200 method response when operation has no responses', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/users': {
          get: {
            security: [{ BearerAuth: [] }],
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = mockIntegrations(spec, diag);
    const op = result.paths!['/users']!.get;
    expect(op.responses).toBeDefined();
    expect(op.responses['200']).toBeDefined();
    expect(op.responses['200'].description).toBe('Mock response');
    expect(op['x-amazon-apigateway-integration'].type).toBe('mock');
    expect(op['x-amazon-apigateway-integration'].responses.default.statusCode).toBe('200');
    expect(diag.entries.some((e: any) => e.feature === 'default-method-response')).toBe(true);
  });
});
