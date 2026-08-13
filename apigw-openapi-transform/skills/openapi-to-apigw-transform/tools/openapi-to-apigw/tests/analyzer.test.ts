import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { analyzeSpec } from '../src/analyzer.js';
import { parseSpec } from '../src/parser.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');

function loadAndAnalyze(fixtureFile: string) {
  const filePath = join(FIXTURES_DIR, fixtureFile);
  const spec = parseSpec(filePath);
  return analyzeSpec(spec, filePath);
}

describe('analyzeSpec', () => {
  describe('Swagger 2.0 spec', () => {
    it('detects needsSwagger2Upgrade as true', () => {
      const result = loadAndAnalyze('swagger20-petstore.yaml');

      expect(result.needsSwagger2Upgrade).toBe(true);
      expect(result.needs31Downgrade).toBe(false);
    });

    it('reports openapiVersion starting with 2', () => {
      const result = loadAndAnalyze('swagger20-petstore.yaml');

      expect(result.openapiVersion).toMatch(/^2\./);
    });

    it('extracts fileName from the path', () => {
      const result = loadAndAnalyze('swagger20-petstore.yaml');

      expect(result.fileName).toBe('swagger20-petstore.yaml');
    });
  });

  describe('OpenAPI 3.0 spec', () => {
    it('does not need Swagger 2 upgrade or 3.1 downgrade', () => {
      const result = loadAndAnalyze('openapi30-complex-schemas.yaml');

      expect(result.needsSwagger2Upgrade).toBe(false);
      expect(result.needs31Downgrade).toBe(false);
    });

    it('reports correct openapiVersion', () => {
      const result = loadAndAnalyze('openapi30-complex-schemas.yaml');

      expect(result.openapiVersion).toBe('3.0.0');
    });
  });

  describe('OpenAPI 3.1 spec', () => {
    it('detects needs31Downgrade as true', () => {
      const result = loadAndAnalyze('openapi31-features.yaml');

      expect(result.needs31Downgrade).toBe(true);
      expect(result.needsSwagger2Upgrade).toBe(false);
    });

    it('reports openapiVersion as 3.1.0', () => {
      const result = loadAndAnalyze('openapi31-features.yaml');

      expect(result.openapiVersion).toBe('3.1.0');
    });
  });

  describe('path, operation, and schema counts', () => {
    it('extracts correct counts from Swagger 2.0 petstore', () => {
      const result = loadAndAnalyze('swagger20-petstore.yaml');

      // /pets (get, post) and /pets/{petId} (get) = 2 paths, 3 operations
      expect(result.pathCount).toBe(2);
      expect(result.operationCount).toBe(3);
      // definitions: Pet, NewPet, Error = 3 schemas
      expect(result.schemaCount).toBe(3);
    });

    it('extracts correct counts from OpenAPI 3.0 complex schemas', () => {
      const result = loadAndAnalyze('openapi30-complex-schemas.yaml');

      // /item-requests, /items, /items/{ItemId}, /items/{ItemId}/pricing = 4 paths
      expect(result.pathCount).toBe(4);
      // post, get, get, get = 4 operations
      expect(result.operationCount).toBe(4);
      // Count the schemas in components.schemas
      expect(result.schemaCount).toBe(10);
    });

    it('extracts correct counts from OpenAPI 3.1 features', () => {
      const result = loadAndAnalyze('openapi31-features.yaml');

      // /pets (get, post), /pets/{petId} (get) = 2 paths, 3 operations
      expect(result.pathCount).toBe(2);
      expect(result.operationCount).toBe(3);
      // Pet, NullableAge, TreeNode = 3 schemas
      expect(result.schemaCount).toBe(3);
    });
  });

  describe('security schemes extraction', () => {
    it('extracts security scheme fields correctly from OpenAPI 3.0', () => {
      const result = loadAndAnalyze('openapi30-security-mixed.yaml');

      expect(result.securitySchemes.length).toBeGreaterThan(0);

      const bearer = result.securitySchemes.find(s => s.name === 'BearerAuth');
      expect(bearer).toBeDefined();
      expect(bearer!.type).toBe('http');
      expect(bearer!.scheme).toBe('bearer');

      const oauth2 = result.securitySchemes.find(s => s.name === 'OAuth2');
      expect(oauth2).toBeDefined();
      expect(oauth2!.type).toBe('oauth2');
      expect(oauth2!.flows).toContain('authorizationCode');

      const nativeKey = result.securitySchemes.find(s => s.name === 'NativeApiKey');
      expect(nativeKey).toBeDefined();
      expect(nativeKey!.type).toBe('apiKey');
      expect(nativeKey!.in).toBe('header');
      expect(nativeKey!.paramName).toBe('x-api-key');

      const openId = result.securitySchemes.find(s => s.name === 'OpenID');
      expect(openId).toBeDefined();
      expect(openId!.type).toBe('openIdConnect');
      expect(openId!.openIdConnectUrl).toBeDefined();
    });

    it('extracts Swagger 2.0 securityDefinitions', () => {
      const result = loadAndAnalyze('swagger20-petstore.yaml');

      expect(result.securitySchemes).toHaveLength(1);
      const apiKey = result.securitySchemes[0];
      expect(apiKey.name).toBe('api_key');
      expect(apiKey.type).toBe('apiKey');
      expect(apiKey.in).toBe('header');
      expect(apiKey.paramName).toBe('x-api-key');
    });
  });

  describe('security schemes (inline specs)', () => {
    it('recognizes Swagger 2.0 type:basic as http/basic', () => {
      const spec: any = {
        swagger: '2.0',
        info: { title: 'T', version: '1' },
        securityDefinitions: {
          BasicAuth: { type: 'basic' },
        },
        paths: {},
      };
      const analysis = analyzeSpec(spec, 'test.yaml');
      const basic = analysis.securitySchemes.find(s => s.name === 'BasicAuth');
      expect(basic).toBeDefined();
      expect(basic!.type).toBe('http');
      expect(basic!.scheme).toBe('basic');
    });

    it('still preserves OpenAPI 3.0 http/basic schemes', () => {
      const spec: any = {
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        components: {
          securitySchemes: {
            BasicAuth: { type: 'http', scheme: 'basic' },
          },
        },
        paths: {},
      };
      const analysis = analyzeSpec(spec, 'test.yaml');
      const basic = analysis.securitySchemes.find(s => s.name === 'BasicAuth');
      expect(basic).toBeDefined();
      expect(basic!.type).toBe('http');
      expect(basic!.scheme).toBe('basic');
    });
  });

  describe('server URLs extraction', () => {
    it('extracts server URLs from OpenAPI 3.0 servers field', () => {
      const result = loadAndAnalyze('openapi30-security-mixed.yaml');

      expect(result.serverUrls).toContain('https://api.example.com');
    });

    it('extracts server URL from OpenAPI 3.1 servers field', () => {
      const result = loadAndAnalyze('openapi31-features.yaml');

      expect(result.serverUrls).toContain('https://api.example.com/v2');
    });

    it('constructs URL from Swagger 2.0 host/basePath/schemes', () => {
      const result = loadAndAnalyze('swagger20-petstore.yaml');

      expect(result.serverUrls).toHaveLength(1);
      expect(result.serverUrls[0]).toBe('https://petstore.swagger.io/v1');
    });

    it('returns empty array for spec with no servers', () => {
      const spec = { openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} };
      const result = analyzeSpec(spec, '/tmp/no-servers.yaml');

      expect(result.serverUrls).toEqual([]);
    });
  });
});
