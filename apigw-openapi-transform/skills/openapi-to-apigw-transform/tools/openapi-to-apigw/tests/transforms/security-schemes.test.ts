import { describe, it, expect } from 'vitest';
import { securitySchemes } from '../../src/transforms/security-schemes.js';
import { createDiagnostics } from '../../src/diagnostics.js';
import { needsLambdaAuthorizer } from '../../src/types.js';

describe('securitySchemes', () => {
  it('converts bearer scheme to apiKey with TOKEN authorizer for APIGW compatibility', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    const scheme = result.components!.securitySchemes!.BearerAuth;
    const ext = scheme['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('token');
    expect(ext.authorizerUri).toContain('{{AUTHORIZER_FUNCTION_ARN}}');
    expect(ext.authorizerUri).toContain('{{AWS_REGION}}');
    expect(ext.authorizerResultTtlInSeconds).toBe(300);
    expect(scheme['x-amazon-apigateway-authtype']).toBe('custom');
    // Converted to apiKey for APIGW compatibility
    expect(scheme.type).toBe('apiKey');
    expect(scheme.name).toBe('Authorization');
    expect(scheme.in).toBe('header');
    expect(scheme.scheme).toBeUndefined();
    expect(scheme.description).toContain('type=http');
    expect(scheme.description).toContain('scheme=bearer');
  });

  it('converts oauth2 scheme to apiKey with TOKEN authorizer', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: {
        OAuth2: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'https://a.co', tokenUrl: 'https://t.co', scopes: {} } } },
      } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    const scheme = result.components!.securitySchemes!.OAuth2;
    const ext = scheme['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('token');
    expect(ext.authorizerUri).toContain('{{AUTHORIZER_FUNCTION_ARN}}');
    expect(ext.authorizerResultTtlInSeconds).toBe(300);
    expect(scheme.type).toBe('apiKey');
    expect(scheme.name).toBe('Authorization');
    expect(scheme.in).toBe('header');
    expect(scheme.flows).toBeUndefined();
    expect(scheme.description).toContain('type=oauth2');
  });

  it('converts openIdConnect scheme to apiKey with TOKEN authorizer', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: { OIDC: { type: 'openIdConnect', openIdConnectUrl: 'https://a.co/.well-known/openid-configuration' } } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    const scheme = result.components!.securitySchemes!.OIDC;
    const ext = scheme['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('token');
    expect(ext.authorizerUri).toContain('{{AUTHORIZER_FUNCTION_ARN}}');
    expect(scheme.type).toBe('apiKey');
    expect(scheme.openIdConnectUrl).toBeUndefined();
    expect(scheme.description).toContain('type=openIdConnect');
  });

  it('converts basic auth scheme to apiKey with REQUEST authorizer', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: { BasicAuth: { type: 'http', scheme: 'basic' } } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    const scheme = result.components!.securitySchemes!.BasicAuth;
    const ext = scheme['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('request');
    expect(ext.identitySource).toBe('method.request.header.Authorization');
    expect(ext.authorizerUri).toContain('{{AUTHORIZER_FUNCTION_ARN}}');
    expect(ext.authorizerResultTtlInSeconds).toBe(300);
    expect(scheme['x-amazon-apigateway-authtype']).toBe('custom');
    expect(scheme.type).toBe('apiKey');
    expect(scheme.description).toContain('type=http');
    expect(scheme.description).toContain('scheme=basic');
  });

  it('handles case-insensitive HTTP scheme values (Basic, Bearer)', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: {
        Auth1: { type: 'http', scheme: 'Basic' },
        Auth2: { type: 'http', scheme: 'BEARER' },
      } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    expect(result.components!.securitySchemes!.Auth1.type).toBe('apiKey');
    expect(result.components!.securitySchemes!.Auth1['x-amazon-apigateway-authorizer'].type).toBe('request');
    expect(result.components!.securitySchemes!.Auth2.type).toBe('apiKey');
    expect(result.components!.securitySchemes!.Auth2['x-amazon-apigateway-authorizer'].type).toBe('token');
  });

  it('uses native API key for x-api-key header (no authorizer extension)', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: { ApiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' } } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    expect(result['x-amazon-apigateway-api-key-source']).toBe('HEADER');
    expect(result.components.securitySchemes.ApiKey['x-amazon-apigateway-authorizer']).toBeUndefined();
  });

  it('adds REQUEST authorizer for non-standard query apiKey', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: { ServerToken: { type: 'apiKey', name: 'server_token', in: 'query' } } },
    };
    const diag = createDiagnostics();
    const result = securitySchemes(spec, diag);
    const ext = result.components!.securitySchemes!.ServerToken['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('request');
    expect(ext.identitySource).toBe('method.request.querystring.server_token');
    expect(diag.entries.some(e => e.feature === 'apiKey/query-authorizer')).toBe(true);
  });

  it('adds REQUEST authorizer for non-standard header apiKey', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: { CustomKey: { type: 'apiKey', name: 'api-key', in: 'header' } } },
    };
    const diag = createDiagnostics();
    const result = securitySchemes(spec, diag);
    const ext = result.components!.securitySchemes!.CustomKey['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('request');
    expect(ext.identitySource).toBe('method.request.header.api-key');
  });

  it('reports an unenforceable cookie apiKey as BREAKING, not a warning', () => {
    // API Gateway cannot read a cookie identity source, so no authorizer can be
    // generated and the operation would deploy with no authentication. That is a
    // silent removal of auth, so it must be breaking-level: it belongs in
    // breaking-changes.json and must trip the CLI's default --fail-on breaking.
    const spec = {
      openapi: '3.0.0',
      paths: { '/private': { get: { security: [{ CookieAuth: [] }], responses: { '200': { description: 'OK' } } } } },
      components: { securitySchemes: { CookieAuth: { type: 'apiKey', name: 'session', in: 'cookie' } } },
    };
    const diag = createDiagnostics();
    const result = securitySchemes(spec, diag);

    expect(result.components!.securitySchemes!.CookieAuth['x-amazon-apigateway-authorizer']).toBeUndefined();
    const entry = diag.entries.find(e => e.feature === 'apiKey/non-standard');
    expect(entry).toBeDefined();
    expect(entry!.level).toBe('breaking');
  });

  it('propagates root-level security to operations', () => {
    const spec = {
      openapi: '3.0.0',
      security: [{ BearerAuth: [] }],
      paths: {
        '/protected': { get: { responses: { '200': { description: 'OK' } } } },
        '/custom': { get: { security: [{ ApiKey: [] }], responses: { '200': { description: 'OK' } } } },
      },
      components: { securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer' },
        ApiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' },
      } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    expect(result.paths['/protected'].get.security).toEqual([{ BearerAuth: [] }]);
    expect(result.paths['/custom'].get.security).toEqual([{ ApiKey: [] }]);
  });

  it('preserves user-provided authorizer with real URI', () => {
    const realUri = 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:my-auth/invocations';
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: { Custom: {
        type: 'http', scheme: 'bearer',
        'x-amazon-apigateway-authorizer': { type: 'token', authorizerUri: realUri },
      } } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    expect(result.components.securitySchemes.Custom['x-amazon-apigateway-authorizer'].authorizerUri).toBe(realUri);
  });

  it('strips scopes from http/bearer security requirements', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            security: [{ BearerAuth: ['read', 'write'] }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      components: { securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    expect(result.paths['/test'].get.security).toEqual([{ BearerAuth: [] }]);
  });

  it('strips scopes from oauth2 security requirements', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            security: [{ OAuth2: ['read', 'write'] }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      components: { securitySchemes: {
        OAuth2: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://t.co', scopes: {} } } },
      } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    expect(result.paths['/test'].get.security).toEqual([{ OAuth2: [] }]);
  });

  it('converts OAuth2 to apiKey but preserves authorizer (not native API key)', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: {
        OAuth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://t.co', scopes: {} } } },
      } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    const scheme = result.components!.securitySchemes!.OAuth;
    // Type is apiKey for APIGW compatibility, but has Lambda authorizer (not native API key)
    expect(scheme.type).toBe('apiKey');
    expect(scheme['x-amazon-apigateway-authorizer']).toBeDefined();
    expect(scheme['x-amazon-apigateway-authorizer'].type).toBe('token');
    expect(scheme.description).toContain('type=oauth2');
  });

  it('adds authorizer for x-api-key header when x-amazon-apigateway-authtype is explicitly set to custom', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: {
        Key2: {
          type: 'apiKey',
          name: 'X-Api-Key',
          in: 'header',
          'x-amazon-apigateway-authtype': 'custom',
        },
      } },
    };
    const diag = createDiagnostics();
    const result = securitySchemes(spec, diag);
    // Should add authorizer because authtype was explicitly set
    const ext = result.components!.securitySchemes!.Key2['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('request');
    expect(ext.identitySource).toContain('X-Api-Key');
  });

  it('skips native x-api-key header when no explicit authtype is set', () => {
    const spec = {
      openapi: '3.0.0', paths: {},
      components: { securitySchemes: {
        ApiKey: { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
      } },
    };
    const result = securitySchemes(spec, createDiagnostics());
    // No authtype → treated as native, no authorizer
    expect(result['x-amazon-apigateway-api-key-source']).toBe('HEADER');
    expect(result.components!.securitySchemes!.ApiKey['x-amazon-apigateway-authorizer']).toBeUndefined();
  });
});

describe('resolveMultipleAuthorizers', () => {
  it('keeps first authorizer when operation has multiple in one security object', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            security: [{ JWT: [], Project: [] }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      components: { securitySchemes: {
        JWT: { type: 'http', scheme: 'bearer' },
        Project: { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
      } },
    };
    const diag = createDiagnostics();
    const result = securitySchemes(spec, diag);
    const sec = result.paths!['/test'].get.security[0];
    expect(Object.keys(sec)).toEqual(['JWT']);
    expect(sec.Project).toBeUndefined();
    expect(diag.entries.some(e => e.feature === 'multiple-authorizers')).toBe(true);
  });

  it('removes duplicate Lambda authorizers from OR-array security alternatives', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            security: [{ clientKey: [] }, { BasicAuth: [] }, { ApiKeyAuth: [] }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      components: { securitySchemes: {
        clientKey: { type: 'apiKey', name: 'clientKey', in: 'query' },
        BasicAuth: { type: 'http', scheme: 'basic' },
        ApiKeyAuth: { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
      } },
    };
    const diag = createDiagnostics();
    const result = securitySchemes(spec, diag);
    const sec = result.paths!['/test'].get.security;
    // clientKey (Lambda authorizer) kept, BasicAuth (Lambda authorizer) removed, ApiKeyAuth (native) kept
    expect(sec).toHaveLength(2);
    expect(sec[0]).toEqual({ clientKey: [] });
    expect(sec[1]).toEqual({ ApiKeyAuth: [] });
    expect(diag.entries.some(e => e.feature === 'multiple-or-authorizers')).toBe(true);
  });

  it('leaves single-scheme security objects unchanged', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            security: [{ BearerAuth: [] }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      components: { securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer' },
      } },
    };
    const diag = createDiagnostics();
    const result = securitySchemes(spec, diag);
    expect(Object.keys(result.paths!['/test'].get.security[0])).toEqual(['BearerAuth']);
    expect(diag.entries.some(e => e.feature === 'multiple-authorizers')).toBe(false);
  });
});

describe('needsLambdaAuthorizer', () => {
  it('returns true for oauth2', () => {
    expect(needsLambdaAuthorizer({ type: 'oauth2' })).toBe(true);
  });

  it('returns true for openIdConnect', () => {
    expect(needsLambdaAuthorizer({ type: 'openIdConnect' })).toBe(true);
  });

  it('returns true for http bearer', () => {
    expect(needsLambdaAuthorizer({ type: 'http', scheme: 'bearer' })).toBe(true);
  });

  it('returns true for http basic', () => {
    expect(needsLambdaAuthorizer({ type: 'http', scheme: 'basic' })).toBe(true);
  });

  it('returns false for native x-api-key header', () => {
    expect(needsLambdaAuthorizer({ type: 'apiKey', in: 'header', paramName: 'x-api-key' })).toBe(false);
  });

  it('returns true for native x-api-key header with explicit custom authtype', () => {
    expect(needsLambdaAuthorizer({ type: 'apiKey', in: 'header', paramName: 'X-Api-Key', explicitCustomAuthtype: true })).toBe(true);
  });

  it('returns true for apiKey with custom header (non-native)', () => {
    expect(needsLambdaAuthorizer({ type: 'apiKey', in: 'header', paramName: 'api-key' })).toBe(true);
  });

  it('returns true for apiKey in query param', () => {
    expect(needsLambdaAuthorizer({ type: 'apiKey', in: 'query', paramName: 'server_token' })).toBe(true);
  });

  it('returns true for apiKey in cookie', () => {
    expect(needsLambdaAuthorizer({ type: 'apiKey', in: 'cookie', paramName: 'session' })).toBe(true);
  });

  it('returns false for unknown type', () => {
    expect(needsLambdaAuthorizer({ type: 'unknown' })).toBe(false);
  });
});
