import { describe, it, expect } from 'vitest';
import { swagger2ToOpenapi3 } from '../../src/transforms/swagger2-to-openapi3.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('swagger2ToOpenapi3', () => {
  it('passes through OpenAPI 3.0 specs unchanged', () => {
    const spec = { openapi: '3.0.0', info: { title: 'Test', version: '1.0' }, paths: {} };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    expect(result.openapi).toBe('3.0.0');
    expect(diag.entries).toHaveLength(0);
  });

  it('converts Swagger 2.0 version to OpenAPI 3.0.0', () => {
    const spec = {
      swagger: '2.0',
      info: { title: 'Petstore', version: '1.0' },
      host: 'api.example.com',
      basePath: '/v1',
      schemes: ['https'],
      paths: {},
    };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    expect(result.openapi).toBe('3.0.0');
    expect(result.swagger).toBeUndefined();
    expect(result.servers).toEqual([{ url: 'https://api.example.com/v1' }]);
  });

  it('converts definitions to components/schemas', () => {
    const spec = {
      swagger: '2.0',
      info: { title: 'Test', version: '1.0' },
      definitions: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
      paths: {},
    };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    expect(result.components.schemas.Pet).toBeDefined();
    expect(result.components.schemas.Pet.type).toBe('object');
  });

  it('converts securityDefinitions to components/securitySchemes', () => {
    const spec = {
      swagger: '2.0',
      info: { title: 'Test', version: '1.0' },
      securityDefinitions: {
        api_key: { type: 'apiKey', name: 'x-api-key', in: 'header' },
        basic: { type: 'basic' },
      },
      paths: {},
    };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    expect(result.components.securitySchemes.api_key.type).toBe('apiKey');
    expect(result.components.securitySchemes.basic).toEqual({ type: 'http', scheme: 'basic' });
  });

  it('converts OAuth2 with accessCode flow', () => {
    const spec = {
      swagger: '2.0',
      info: { title: 'Test', version: '1.0' },
      securityDefinitions: {
        oauth: {
          type: 'oauth2',
          flow: 'accessCode',
          authorizationUrl: 'https://auth.example.com/auth',
          tokenUrl: 'https://auth.example.com/token',
          scopes: { read: 'Read access' },
        },
      },
      paths: {},
    };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    const oauth = result.components.securitySchemes.oauth;
    expect(oauth.type).toBe('oauth2');
    expect(oauth.flows.authorizationCode).toBeDefined();
    expect(oauth.flows.authorizationCode.scopes).toEqual({ read: 'Read access' });
  });

  it('converts body parameters to requestBody', () => {
    const spec = {
      swagger: '2.0',
      info: { title: 'Test', version: '1.0' },
      consumes: ['application/json'],
      produces: ['application/json'],
      paths: {
        '/pets': {
          post: {
            parameters: [
              { in: 'body', name: 'body', schema: { $ref: '#/definitions/Pet' } },
            ],
            responses: { '201': { description: 'Created' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    const post = result.paths['/pets'].post;
    expect(post.requestBody).toBeDefined();
    expect(post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/Pet');
    expect(post.parameters).toBeUndefined(); // body param should not be in params
  });

  it('converts response schemas with produces content types', () => {
    const spec = {
      swagger: '2.0',
      info: { title: 'Test', version: '1.0' },
      produces: ['application/json', 'application/xml'],
      paths: {
        '/pets': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                schema: { type: 'array', items: { $ref: '#/definitions/Pet' } },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    const resp = result.paths['/pets'].get.responses['200'];
    expect(resp.content['application/json']).toBeDefined();
    expect(resp.content['application/xml']).toBeDefined();
  });

  it('converts response headers', () => {
    const spec = {
      swagger: '2.0',
      info: { title: 'Test', version: '1.0' },
      produces: ['application/json'],
      paths: {
        '/pets': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                headers: {
                  'x-rate-limit': { type: 'integer', description: 'Calls per hour' },
                },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    const headers = result.paths['/pets'].get.responses['200'].headers;
    expect(headers['x-rate-limit'].schema.type).toBe('integer');
    expect(headers['x-rate-limit'].description).toBe('Calls per hour');
  });

  it('preserves root-level security', () => {
    const spec = {
      swagger: '2.0',
      info: { title: 'Test', version: '1.0' },
      security: [{ api_key: [] }],
      paths: {},
    };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    expect(result.security).toEqual([{ api_key: [] }]);
  });

  it('converts formData parameters to requestBody', () => {
    const spec = {
      swagger: '2.0',
      info: { title: 'Test', version: '1.0' },
      consumes: ['multipart/form-data'],
      paths: {
        '/upload': {
          post: {
            parameters: [
              { in: 'formData', name: 'file', type: 'file', required: true },
              { in: 'formData', name: 'description', type: 'string' },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = swagger2ToOpenapi3(spec, diag);
    const post = result.paths['/upload'].post;
    expect(post.requestBody).toBeDefined();
    const schema = post.requestBody.content['multipart/form-data'].schema;
    expect(schema.properties.file.format).toBe('binary');
    expect(schema.required).toContain('file');
  });
});
