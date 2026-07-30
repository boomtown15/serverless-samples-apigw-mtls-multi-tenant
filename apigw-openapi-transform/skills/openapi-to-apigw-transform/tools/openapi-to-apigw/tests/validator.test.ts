import { describe, it, expect } from 'vitest';
import { validate, countResources } from '../src/validator.js';
import { createDiagnostics } from '../src/diagnostics.js';
import type { OpenAPISpec, SourceAnalysis, Diagnostics } from '../src/types.js';

function makeAnalysis(overrides: Partial<SourceAnalysis> = {}): SourceAnalysis {
  return {
    fileName: 'test.yaml',
    openapiVersion: '3.0.0',
    pathCount: 1,
    operationCount: 1,
    schemaCount: 0,
    securitySchemes: [],
    serverUrls: [],
    needsSwagger2Upgrade: false,
    needs31Downgrade: false,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<OpenAPISpec> = {}): OpenAPISpec {
  return {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0' },
    paths: {
      '/test': {
        get: {
          responses: { '200': { description: 'OK' } },
          'x-amazon-apigateway-integration': { type: 'mock' },
        },
      },
    },
    ...overrides,
  };
}

describe('validate', () => {
  describe('path-count check', () => {
    it('passes when path count matches source analysis', () => {
      const spec = makeSpec();
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'path-count');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
      expect(check!.actual).toBe(1);
    });

    it('fails when path count does not match', () => {
      const spec = makeSpec();
      const analysis = makeAnalysis({ pathCount: 5, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'path-count');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(false);
      expect(check!.expected).toBe(5);
      expect(check!.actual).toBe(1);
      expect(result.pass).toBe(false);
    });
  });

  describe('operation-count check', () => {
    it('fails when operation count does not match', () => {
      const spec = makeSpec();
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 3 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'operation-count');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(false);
      expect(check!.expected).toBe(3);
      expect(check!.actual).toBe(1);
      expect(result.pass).toBe(false);
    });
  });

  describe('schema-count check (>= behavior)', () => {
    it('passes when cleaned spec has more schemas than source due to wrappers', () => {
      const spec = makeSpec({
        paths: {
          '/test': {
            get: {
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: {
          schemas: {
            Pet: { type: 'object' },
            StringResponse: { type: 'string' },
            ExtraWrapper: { type: 'object' },
          },
        },
      });
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1, schemaCount: 2 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'schema-count');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
      expect(check!.actual).toBe(3); // 3 >= 2
    });

    it('fails when cleaned spec has fewer schemas than source', () => {
      const spec = makeSpec({
        paths: {
          '/test': {
            get: {
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: {
          schemas: {
            Pet: { type: 'object' },
          },
        },
      });
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1, schemaCount: 5 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'schema-count');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(false);
    });
  });

  describe('all-operations-have-integration check', () => {
    it('passes when all operations have x-amazon-apigateway-integration', () => {
      const spec = makeSpec({
        paths: {
          '/a': {
            get: {
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
            post: {
              responses: { '201': { description: 'Created' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
      });
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 2 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'all-operations-have-integration');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
      expect(check!.expected).toBe(2);
      expect(check!.actual).toBe(2);
    });

    it('fails when some operations are missing integration', () => {
      const spec = makeSpec({
        paths: {
          '/a': {
            get: {
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
            post: {
              responses: { '201': { description: 'Created' } },
              // missing integration
            },
          },
        },
      });
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 2 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'all-operations-have-integration');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(false);
      expect(check!.expected).toBe(2);
      expect(check!.actual).toBe(1);
      expect(result.pass).toBe(false);
    });
  });

  describe('secured-operations-have-authorizer check', () => {
    it('passes for scheme with x-amazon-apigateway-authorizer extension', () => {
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {
          '/protected': {
            get: {
              security: [{ MyAuth: [] }],
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: {
          securitySchemes: {
            MyAuth: {
              type: 'apiKey',
              name: 'Authorization',
              in: 'header',
              'x-amazon-apigateway-authorizer': {
                type: 'request',
                authorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/functions/arn:aws:lambda:us-east-1:123456:function:auth/invocations',
              },
            },
          },
        },
      };
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'secured-operations-have-authorizer');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
    });

    // `validate()` always runs on the POST-transform spec (see cli.ts: runPipeline → validate),
    // where securitySchemes has already rewritten oauth2 / openIdConnect / http-bearer /
    // http-basic into `type: apiKey` carrying x-amazon-apigateway-authorizer. These tests
    // therefore assert the shape the validator actually receives.
    it('passes for oauth2 after the transform attaches its token authorizer', () => {
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {
          '/oauth': {
            get: {
              security: [{ OAuthScheme: [] }],
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: {
          securitySchemes: {
            OAuthScheme: {
              type: 'apiKey',
              name: 'Authorization',
              in: 'header',
              'x-amazon-apigateway-authtype': 'custom',
              'x-amazon-apigateway-authorizer': {
                type: 'token',
                authorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:auth/invocations',
              },
              description: '[Original: type=oauth2]',
            },
          },
        },
      };
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'secured-operations-have-authorizer');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
    });

    it('FAILS for a raw oauth2 scheme with no authorizer attached', () => {
      // API Gateway silently ignores `type: oauth2` on import. If such a scheme ever
      // reaches validation without having been rewritten, the deployed API would have
      // no authentication — the exact silent-auth-loss this tool exists to prevent.
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {
          '/oauth': {
            get: {
              security: [{ OAuthScheme: ['read'] }],
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: {
          securitySchemes: {
            OAuthScheme: {
              type: 'oauth2',
              flows: { clientCredentials: { tokenUrl: 'https://example.com/token', scopes: {} } },
            },
          },
        },
      };
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'secured-operations-have-authorizer');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(false);
    });

    it('passes for http bearer after the transform attaches its token authorizer', () => {
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {
          '/bearer': {
            get: {
              security: [{ BearerAuth: [] }],
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: {
          securitySchemes: {
            BearerAuth: {
              type: 'apiKey',
              name: 'Authorization',
              in: 'header',
              'x-amazon-apigateway-authtype': 'custom',
              'x-amazon-apigateway-authorizer': {
                type: 'token',
                authorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:auth/invocations',
              },
              description: '[Original: type=http, scheme=bearer]',
            },
          },
        },
      };
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'secured-operations-have-authorizer');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
    });

    it('passes for native x-api-key apiKey scheme', () => {
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {
          '/apikey': {
            get: {
              security: [{ NativeKey: [] }],
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: {
          securitySchemes: {
            NativeKey: {
              type: 'apiKey',
              name: 'x-api-key',
              in: 'header',
            },
          },
        },
      };
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'secured-operations-have-authorizer');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
    });

    it('passes for non-standard apiKey scheme (query param) once the authorizer is attached', () => {
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {
          '/query-key': {
            get: {
              security: [{ QueryKey: [] }],
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: {
          securitySchemes: {
            QueryKey: {
              type: 'apiKey',
              name: 'token',
              in: 'query',
              'x-amazon-apigateway-authtype': 'custom',
              'x-amazon-apigateway-authorizer': {
                type: 'request',
                authorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:auth/invocations',
                identitySource: 'method.request.querystring.token',
              },
            },
          },
        },
      };
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'secured-operations-have-authorizer');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
    });

    it('FAILS for an apiKey scheme left with no authorizer (cookie location)', () => {
      // API Gateway cannot read cookie-based apiKey schemes, so securitySchemes
      // transform strips the authorizer extensions and only flags a warning. The
      // operation still declares `security`, so it would deploy wide open — that
      // must fail validation rather than be counted as "reachable auth".
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {
          '/cookie-auth': {
            get: {
              security: [{ CookieAuth: [] }],
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: {
          securitySchemes: {
            CookieAuth: {
              type: 'apiKey',
              name: 'session',
              in: 'cookie',
            },
          },
        },
      };
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'secured-operations-have-authorizer');

      expect(check).toBeDefined();
      expect(check!.expected).toBe(1);
      expect(check!.actual).toBe(0);
      expect(check!.pass).toBe(false);
      expect(result.pass).toBe(false);
    });

    it('FAILS when an operation references a security scheme that does not exist', () => {
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {
          '/ghost': {
            get: {
              security: [{ MissingScheme: [] }],
              responses: { '200': { description: 'OK' } },
              'x-amazon-apigateway-integration': { type: 'mock' },
            },
          },
        },
        components: { securitySchemes: {} },
      };
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'secured-operations-have-authorizer');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(false);
    });

    it('passes when no operations have security at all', () => {
      const spec = makeSpec();
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'secured-operations-have-authorizer');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
      expect(check!.expected).toBe(0);
      expect(check!.actual).toBe(0);
    });
  });

  describe('api-gateway-resource-limit check', () => {
    it('passes when path count is within default limit', () => {
      const spec = makeSpec();
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);
      const check = result.checks.find(c => c.name === 'api-gateway-resource-limit');

      expect(check).toBeDefined();
      expect(check!.pass).toBe(true);
    });

    it('fails resource-limit check and emits breaking when resourceCount exceeds 300', () => {
      // Build a spec with > 300 disjoint top-level paths → > 300 resources
      const paths: Record<string, any> = {};
      for (let i = 0; i < 350; i++) {
        paths[`/path-${i}`] = {
          get: {
            responses: { '200': { description: 'OK' } },
            'x-amazon-apigateway-integration': { type: 'mock' },
          },
        };
      }
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths,
      };
      const analysis = makeAnalysis({ pathCount: 350, operationCount: 350 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);

      // The resource-limit check fails when exceeding the 300 default limit
      const check = result.checks.find(c => c.name === 'api-gateway-resource-limit');
      expect(check!.pass).toBe(false);

      // A breaking diagnostic should have been emitted
      const breaking = diag.entries.find(
        e => e.level === 'breaking' && e.rule === 'validator' && e.feature === 'resource-limit',
      );
      expect(breaking).toBeDefined();
      expect(breaking!.message).toContain('350 API Gateway resources');
      expect(breaking!.message).toContain('exceeds configured limit of 300');
    });

    it('emits info when resourceCount exceeds 85%-100% of limit', () => {
      const paths: Record<string, any> = {};
      for (let i = 0; i < 275; i++) {
        paths[`/path-${i}`] = {
          get: {
            responses: { '200': { description: 'OK' } },
            'x-amazon-apigateway-integration': { type: 'mock' },
          },
        };
      }
      const spec: OpenAPISpec = { openapi: '3.0.0', paths };
      const analysis = makeAnalysis({ pathCount: 275, operationCount: 275 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);

      // Still passes — within the 300 limit
      const check = result.checks.find(c => c.name === 'api-gateway-resource-limit');
      expect(check!.pass).toBe(true);

      // But an info diagnostic should have been emitted (> 0.85 * 300 = 255)
      const info = diag.entries.find(
        e => e.level === 'info' && e.feature === 'resource-limit',
      );
      expect(info).toBeDefined();
      expect(info!.message).toContain('275 API Gateway resources');
      expect(info!.message).toContain('approaching configured limit of 300');
    });
  });

  describe('overall result', () => {
    it('passes when all checks pass', () => {
      const spec = makeSpec();
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1, schemaCount: 0 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);

      expect(result.pass).toBe(true);
      expect(result.file).toBe('test.yaml');
      expect(result.checks.every(c => c.pass)).toBe(true);
    });

    it('reports the source analysis file name', () => {
      const spec = makeSpec();
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1, fileName: 'my-api.yaml' });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);

      expect(result.file).toBe('my-api.yaml');
    });
  });

  describe('zero-deployable-paths check', () => {
    it('emits error diagnostic when all paths were removed', () => {
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {},
      };
      const analysis = makeAnalysis({ pathCount: 40, operationCount: 40 });
      const diag = createDiagnostics();

      const result = validate(spec, analysis, diag);

      expect(result.pass).toBe(false);
      const errorDiag = diag.entries.find(
        e => e.level === 'error' && e.feature === 'zero-deployable-paths',
      );
      expect(errorDiag).toBeDefined();
      expect(errorDiag!.message).toContain('All 40 paths were removed');
      expect(errorDiag!.message).toContain('Manual remediation');
    });

    it('does not emit error when source had 0 paths (webhook-only spec)', () => {
      const spec: OpenAPISpec = {
        openapi: '3.0.0',
        paths: {},
      };
      const analysis = makeAnalysis({ pathCount: 0, operationCount: 0 });
      const diag = createDiagnostics();

      validate(spec, analysis, diag);

      const errorDiag = diag.entries.find(
        e => e.level === 'error' && e.feature === 'zero-deployable-paths',
      );
      expect(errorDiag).toBeUndefined();
    });

    it('does not emit error when paths remain after transformation', () => {
      const spec = makeSpec();
      const analysis = makeAnalysis({ pathCount: 1, operationCount: 1 });
      const diag = createDiagnostics();

      validate(spec, analysis, diag);

      const errorDiag = diag.entries.find(
        e => e.level === 'error' && e.feature === 'zero-deployable-paths',
      );
      expect(errorDiag).toBeUndefined();
    });
  });
});

describe('countResources', () => {
  it('counts shared parent segments once', () => {
    expect(countResources(['/users', '/users/{id}', '/users/{id}/posts'])).toBe(3);
  });

  it('counts siblings under a shared parent distinctly', () => {
    expect(countResources(['/a/b/c', '/a/b/d'])).toBe(4);
  });

  it('counts fully disjoint paths separately', () => {
    expect(countResources(['/x/y', '/p/q'])).toBe(4);
  });

  it('returns 0 for empty input', () => {
    expect(countResources([])).toBe(0);
  });

  it('treats distinct path-param siblings as distinct nodes', () => {
    expect(countResources(['/a/{x}/b', '/a/{y}/b'])).toBe(5);
  });
});

describe('validate resource-limit gating', () => {
  function specWithPaths(paths: string[]) {
    const pathsObj: Record<string, any> = {};
    for (const p of paths) pathsObj[p] = { get: { 'x-amazon-apigateway-integration': { type: 'mock' }, responses: { '200': { description: 'ok' } } } };
    return {
      spec: { openapi: '3.0.0', paths: pathsObj },
      analysis: {
        fileName: 'test.yaml', openapiVersion: '3.0.0',
        pathCount: paths.length, operationCount: paths.length,
        schemaCount: 0, securitySchemes: [], serverUrls: [],
        needsSwagger2Upgrade: false, needs31Downgrade: false,
      },
    };
  }

  it('emits breaking when resourceCount exceeds configuredLimit', () => {
    // Generate 310 disjoint top-level paths → 310 resources, exceeding default clamped limit of 300.
    const paths = Array.from({ length: 310 }, (_, i) => `/p${i}`);
    const { spec, analysis } = specWithPaths(paths);
    const diag = createDiagnostics();
    const result = validate(spec as any, analysis as any, diag);
    const entries = diag.entries.filter(e => e.feature === 'resource-limit');
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('breaking');
    expect(result.checks.find(c => c.name === 'api-gateway-resource-limit')?.pass).toBe(false);
  });

  it('emits info when resourceCount is within 85%-100% of limit', () => {
    // 270 resources with default clamped limit of 300 → 270 > 0.85*300 (255), not > 300. Info only.
    const paths = Array.from({ length: 270 }, (_, i) => `/p${i}`);
    const { spec, analysis } = specWithPaths(paths);
    const diag = createDiagnostics();
    const result = validate(spec as any, analysis as any, diag);
    const entries = diag.entries.filter(e => e.feature === 'resource-limit');
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(result.checks.find(c => c.name === 'api-gateway-resource-limit')?.pass).toBe(true);
  });

  it('emits nothing when resourceCount is well under limit', () => {
    const { spec, analysis } = specWithPaths(['/a/b1/c', '/a/b2/d']);
    const diag = createDiagnostics();
    validate(spec as any, analysis as any, diag, { resourcesPerApiLimit: 1000 });
    const entries = diag.entries.filter(e => e.feature === 'resource-limit');
    expect(entries).toHaveLength(0);
  });

  it('defaults limit to 300 when not supplied', () => {
    const { spec, analysis } = specWithPaths(['/a/b1/c', '/a/b2/d']);
    const diag = createDiagnostics();
    validate(spec as any, analysis as any, diag);
    const entries = diag.entries.filter(e => e.feature === 'resource-limit');
    expect(entries).toHaveLength(0); // 5 resources << 300 and < 255
  });

  it('clamps options.resourcesPerApiLimit below 300 up to 300 via Math.max', () => {
    // 5 resources with requested limit 5 would emit info, but with clamp to 300, no diagnostic.
    const { spec, analysis } = specWithPaths(['/a/b1/c', '/a/b2/d']);
    const diag = createDiagnostics();
    validate(spec as any, analysis as any, diag, { resourcesPerApiLimit: 5 });
    // From the previous test we proved limit=5 gives info. If we pass 50 (still <300),
    // Math.max(300, 50) = 300, and 5 resources < 255, so no diagnostic.
    const diag2 = createDiagnostics();
    validate(spec as any, analysis as any, diag2, { resourcesPerApiLimit: 50 });
    const entries = diag2.entries.filter(e => e.feature === 'resource-limit');
    expect(entries).toHaveLength(0);
  });
});
