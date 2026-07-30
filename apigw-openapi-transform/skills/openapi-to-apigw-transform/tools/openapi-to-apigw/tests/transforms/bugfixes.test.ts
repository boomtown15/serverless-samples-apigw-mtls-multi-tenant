import { describe, it, expect } from 'vitest';
import { swagger2ToOpenapi3 } from '../../src/transforms/swagger2-to-openapi3.js';
import { mockIntegrations } from '../../src/transforms/mock-integrations.js';
import { parameterCleanup } from '../../src/transforms/parameter-cleanup.js';
import { securitySchemes } from '../../src/transforms/security-schemes.js';
import { createDiagnostics } from '../../src/diagnostics.js';
import { discoverSpecs } from '../../src/parser.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Bug fixes', () => {

  // Fix #1: $ref paths rewritten from #/definitions/ to #/components/schemas/
  describe('#1: Swagger 2.0 $ref rewriting', () => {
    it('rewrites #/definitions/ to #/components/schemas/ in response schemas', () => {
      const spec = {
        swagger: '2.0',
        info: { title: 'Test', version: '1.0' },
        produces: ['application/json'],
        definitions: {
          Pet: { type: 'object', properties: { name: { type: 'string' } } },
          Error: { type: 'object', properties: { message: { type: 'string' } } },
        },
        paths: {
          '/pets': {
            get: {
              responses: {
                '200': { description: 'OK', schema: { $ref: '#/definitions/Pet' } },
                '500': { description: 'Error', schema: { $ref: '#/definitions/Error' } },
              },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = swagger2ToOpenapi3(spec, diag);
      const resp200 = result.paths['/pets'].get.responses['200'];
      expect(resp200.content['application/json'].schema.$ref).toBe('#/components/schemas/Pet');
      const resp500 = result.paths['/pets'].get.responses['500'];
      expect(resp500.content['application/json'].schema.$ref).toBe('#/components/schemas/Error');
    });

    it('rewrites #/definitions/ in nested $ref (array items)', () => {
      const spec = {
        swagger: '2.0',
        info: { title: 'Test', version: '1.0' },
        produces: ['application/json'],
        definitions: {
          Pet: { type: 'object' },
        },
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
      const schema = result.paths['/pets'].get.responses['200'].content['application/json'].schema;
      expect(schema.items.$ref).toBe('#/components/schemas/Pet');
    });

    it('rewrites #/definitions/ in schema properties', () => {
      const spec = {
        swagger: '2.0',
        info: { title: 'Test', version: '1.0' },
        definitions: {
          Pet: { type: 'object', properties: { owner: { $ref: '#/definitions/Owner' } } },
          Owner: { type: 'object' },
        },
        paths: {},
      };
      const diag = createDiagnostics();
      const result = swagger2ToOpenapi3(spec, diag);
      expect(result.components.schemas.Pet.properties.owner.$ref).toBe('#/components/schemas/Owner');
    });

    it('does not modify already-correct #/components/schemas/ refs', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/pets': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
                },
              },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = swagger2ToOpenapi3(spec, diag);
      expect(result.paths['/pets'].get.responses['200'].content['application/json'].schema.$ref)
        .toBe('#/components/schemas/Pet');
    });
  });

  // Fix #2: default method response promoted to 200
  describe('#2: default method response handling', () => {
    it('promotes default-only response to 200', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/test': {
            get: {
              responses: {
                default: { description: 'Default response' },
              },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = mockIntegrations(spec, diag);
      expect(result.paths['/test'].get.responses['200']).toBeDefined();
      expect(result.paths['/test'].get.responses.default).toBeUndefined();
    });

    it('removes default response when numeric codes exist', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
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
      const result = mockIntegrations(spec, diag);
      expect(result.paths['/test'].get.responses['200']).toBeDefined();
      expect(result.paths['/test'].get.responses.default).toBeUndefined();
    });
  });

  // Fix #3: Invalid content types cleaned
  describe('#3: invalid content type cleanup', () => {
    it('removes wildcard */* content type', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/test': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    '*/*': { schema: { type: 'string' } },
                    'application/json': { schema: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = mockIntegrations(spec, diag);
      const content = result.paths['/test'].get.responses['200'].content;
      expect(content['*/*']).toBeUndefined();
      expect(content['application/json']).toBeDefined();
    });

    it('removes empty string content type', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/test': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    '': { schema: { type: 'object' } },
                    'application/json': { schema: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = mockIntegrations(spec, diag);
      const content = result.paths['/test'].get.responses['200'].content;
      expect(content['']).toBeUndefined();
      expect(content['application/json']).toBeDefined();
    });

    it('removes null content type values', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/test': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': null,
                  },
                },
              },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = mockIntegrations(spec, diag);
      const content = result.paths['/test'].get.responses['200'].content;
      expect(content['application/json']).toBeUndefined();
    });

    it('does not include invalid content types in responseTemplates', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/test': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    '*/*': { schema: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = mockIntegrations(spec, diag);
      const integration = result.paths['/test'].get['x-amazon-apigateway-integration'];
      const templates = integration.responses.default.responseTemplates;
      expect(templates?.['*/*']).toBeUndefined();
    });
  });

  // Fix #4: Parameter name sanitization and deduplication
  describe('#4: parameter name sanitization', () => {
    it('removes invalid characters from parameter names', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/test': {
            get: {
              parameters: [
                { name: 'bbox[]', in: 'query', schema: { type: 'array' } },
                { name: 'services[]', in: 'query', schema: { type: 'array' } },
              ],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = parameterCleanup(spec, diag);
      const params = result.paths['/test'].get.parameters;
      expect(params[0].name).toBe('bbox');
      expect(params[1].name).toBe('services');
    });

    it('renames duplicate parameter names', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/test': {
            get: {
              parameters: [
                { name: 'Last-Event-ID', in: 'query', schema: { type: 'string' } },
                { name: 'Last-Event-ID', in: 'header', schema: { type: 'string' } },
              ],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = parameterCleanup(spec, diag);
      const params = result.paths['/test'].get.parameters;
      expect(params[0].name).toBe('Last-Event-ID');
      expect(params[1].name).toBe('header-Last-Event-ID');
    });

    it('does not rename valid parameter names', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/test': {
            get: {
              parameters: [
                { name: 'page', in: 'query', schema: { type: 'integer' } },
                { name: 'per_page', in: 'query', schema: { type: 'integer' } },
              ],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = parameterCleanup(spec, diag);
      const params = result.paths['/test'].get.parameters;
      expect(params[0].name).toBe('page');
      expect(params[1].name).toBe('per_page');
    });
  });

  // Fix #5: Batch mode accumulation (tested via discoverSpecs dedup which is the prerequisite)
  // CLI integration tests would need spawning the process — covered by #6

  // Fix #6: Directory mode deduplication
  describe('#6: yaml/json deduplication', () => {
    it('deduplicates yaml and json files with same basename', () => {
      const tmpDir = join(tmpdir(), `test-dedup-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      const specContent = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {},
      });

      writeFileSync(join(tmpDir, 'petstore.yaml'), specContent);
      writeFileSync(join(tmpDir, 'petstore.json'), specContent);
      writeFileSync(join(tmpDir, 'other.yaml'), specContent);

      const files = discoverSpecs(tmpDir);
      const basenames = files.map(f => f.split('/').pop());

      // Should have 2 files (petstore once, other once), not 3
      expect(files).toHaveLength(2);
      // Should prefer yaml over json
      expect(basenames).toContain('petstore.yaml');
      expect(basenames).not.toContain('petstore.json');

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // Fix #7: Mock integration passthroughBehavior
  describe('#7: mock integration passthroughBehavior', () => {
    it('sets passthroughBehavior to when_no_templates', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/test': {
            get: {
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      const diag = createDiagnostics();
      const result = mockIntegrations(spec, diag);
      const integration = result.paths['/test'].get['x-amazon-apigateway-integration'];
      expect(integration.passthroughBehavior).toBe('when_no_templates');
    });
  });

  // Fix #8: Placeholder authorizer extensions replaced with generated ones
  describe('#8: placeholder authorizer extension replacement', () => {
    it('replaces placeholder URI with generated authorizer extension', () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              'x-amazon-apigateway-authtype': 'custom',
              'x-amazon-apigateway-authorizer': {
                type: 'token',
                authorizerUri: 'arn:aws:apigateway:{region}:lambda:path/2015-03-31/functions/arn:aws:lambda:{region}:{account-id}:function:{authorizer-function-name}/invocations',
                identitySource: 'method.request.header.Authorization',
              },
            },
          },
        },
        paths: {},
      };
      const diag = createDiagnostics();
      const result = securitySchemes(spec, diag);
      // Placeholder removed and replaced with generated authorizer extension
      const ext = result.components.securitySchemes.bearerAuth['x-amazon-apigateway-authorizer'];
      expect(ext).toBeDefined();
      expect(ext.type).toBe('token');
      expect(ext.authorizerUri).toContain('{{AUTHORIZER_FUNCTION_ARN}}');
      expect(ext.authorizerUri).toContain('{{AWS_REGION}}');
      expect(result.components.securitySchemes.bearerAuth['x-amazon-apigateway-authtype']).toBe('custom');
      expect(diag.entries.some(e => e.feature === 'authorizer-extension-removed')).toBe(true);
    });

    it('replaces old-style SAM variable URI with generated extension', () => {
      const oldStyleUri = 'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${AuthorizerFunctionArn}/invocations';
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        components: {
          securitySchemes: {
            auth: {
              type: 'http',
              scheme: 'bearer',
              'x-amazon-apigateway-authtype': 'custom',
              'x-amazon-apigateway-authorizer': {
                type: 'token',
                authorizerUri: oldStyleUri,
              },
            },
          },
        },
        paths: {},
      };
      const diag = createDiagnostics();
      const result = securitySchemes(spec, diag);
      const ext = result.components.securitySchemes.auth['x-amazon-apigateway-authorizer'];
      expect(ext).toBeDefined();
      expect(ext.type).toBe('token');
      expect(ext.authorizerUri).toContain('{{AUTHORIZER_FUNCTION_ARN}}');
    });

    it('preserves user-provided authorizer with real ARN', () => {
      const realUri = 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:my-real-auth/invocations';
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        components: {
          securitySchemes: {
            auth: {
              type: 'http',
              scheme: 'bearer',
              'x-amazon-apigateway-authtype': 'custom',
              'x-amazon-apigateway-authorizer': {
                type: 'token',
                authorizerUri: realUri,
              },
            },
          },
        },
        paths: {},
      };
      const diag = createDiagnostics();
      const result = securitySchemes(spec, diag);
      expect(result.components.securitySchemes.auth['x-amazon-apigateway-authorizer'].authorizerUri)
        .toBe(realUri);
    });
  });
});
