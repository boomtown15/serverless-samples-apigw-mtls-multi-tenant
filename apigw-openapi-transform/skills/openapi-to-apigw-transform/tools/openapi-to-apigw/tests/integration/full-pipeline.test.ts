import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { parseSpec, serializeSpec } from '../../src/parser.js';
import { analyzeSpec } from '../../src/analyzer.js';
import { createDiagnostics } from '../../src/diagnostics.js';
import { runPipeline } from '../../src/pipeline.js';
import { validate } from '../../src/validator.js';
import { generateSamTemplate, generateAuthorizerTemplate } from '../../src/generators/sam-template.js';
import { generateDeployScript } from '../../src/generators/deploy-script.js';
import type { SpecDeployInfo } from '../../src/generators/deploy-script.js';
import { HTTP_METHODS } from '../../src/types.js';
import type { DiagnosticEntry } from '../../src/types.js';

const FIXTURES = resolve(__dirname, '../fixtures');

function fixture(name: string) {
  return resolve(FIXTURES, name);
}

function hasIntegrationOnAll(spec: any): boolean {
  for (const pathItem of Object.values(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, any>)[method];
      if (op && !op['x-amazon-apigateway-integration']) return false;
    }
  }
  return true;
}

function schemaNames(spec: any): string[] {
  return Object.keys(spec.components?.schemas ?? {});
}

function diagsByRule(entries: DiagnosticEntry[], rule: string) {
  return entries.filter(e => e.rule === rule);
}

function diagsByFeature(entries: DiagnosticEntry[], feature: string) {
  return entries.filter(e => e.feature === feature);
}

// ─── Swagger 2.0: Petstore ─────────────────────────────────────────────────
describe('Swagger 2.0 Petstore', () => {
  const spec = parseSpec(fixture('swagger20-petstore.yaml'));
  const analysis = analyzeSpec(spec, fixture('swagger20-petstore.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);
  const validation = validate(cleaned, analysis, diag);

  it('converts to OpenAPI 3.0.0', () => {
    expect(cleaned.openapi).toBe('3.0.0');
    expect(cleaned.swagger).toBeUndefined();
  });

  it('passes validation', () => {
    expect(validation.pass).toBe(true);
  });

  it('moves definitions to components/schemas', () => {
    expect(cleaned.components.schemas.Pet).toBeDefined();
    expect(cleaned.components.schemas.NewPet).toBeDefined();
    expect(cleaned.components.schemas.Error).toBeDefined();
  });

  it('converts body params to requestBody', () => {
    const post = cleaned.paths['/v1/pets']?.post;
    expect(post.requestBody).toBeDefined();
    expect(post.requestBody.content['application/json']).toBeDefined();
    expect(post.parameters).toBeUndefined(); // body param removed from params
  });

  it('preserves allOf composition', () => {
    expect(cleaned.components.schemas.Pet.allOf).toBeDefined();
  });

  it('converts response headers (x-next preserved)', () => {
    const resp = cleaned.paths['/v1/pets']?.get?.responses?.['200'];
    expect(resp.headers?.['x-next']).toBeDefined();
  });

  it('prepends basePath /v1 to all paths', () => {
    expect(cleaned.paths['/v1/pets']).toBeDefined();
    expect(cleaned.paths['/v1/pets/{petId}']).toBeDefined();
    expect(cleaned.paths['/pets']).toBeUndefined();
  });

  it('converts securityDefinitions to components/securitySchemes', () => {
    expect(cleaned.components.securitySchemes.api_key).toBeDefined();
    expect(cleaned.components.securitySchemes.api_key.type).toBe('apiKey');
  });

  it('logs swagger conversion in diagnostics', () => {
    expect(diagsByRule(diag.entries, 'swagger2-to-openapi3').length).toBeGreaterThan(0);
  });
});

// ─── Swagger 2.0: Uber (non-standard apiKey) ───────────────────────────────
describe('Swagger 2.0 Uber', () => {
  const spec = parseSpec(fixture('swagger20-uber.yaml'));
  const analysis = analyzeSpec(spec, fixture('swagger20-uber.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);
  const validation = validate(cleaned, analysis, diag);

  it('passes validation', () => {
    expect(validation.pass).toBe(true);
  });

  it('adds REQUEST authorizer for query apiKey', () => {
    const scheme = cleaned.components!.securitySchemes!.apikey;
    const ext = scheme['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('request');
    expect(ext.identitySource).toContain('querystring');
  });

  it('removes format:decimal', () => {
    const price = cleaned.components.schemas.PriceEstimate;
    expect(price.properties.low_estimate.format).toBeUndefined();
    expect(price.properties.high_estimate.format).toBeUndefined();
    expect(diagsByFeature(diag.entries, 'format:decimal').length).toBeGreaterThan(0);
  });

  it('preserves format:double', () => {
    expect(cleaned.components.schemas.PriceEstimate.properties.surge_multiplier.format).toBe('double');
  });

  it('converts int32 on integer type (keeps type)', () => {
    // int32 on already-integer is fine; int32 on number → integer
    expect(cleaned.components.schemas.Product.properties.capacity.type).toBe('integer');
  });
});

// ─── OpenAPI 3.0: Complex Schemas (Underscore Names, Collisions, OAuth2) ────
describe('OpenAPI 3.0 Complex Schemas', () => {
  const spec = parseSpec(fixture('openapi30-complex-schemas.yaml'));
  const analysis = analyzeSpec(spec, fixture('openapi30-complex-schemas.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);
  const validation = validate(cleaned, analysis, diag);

  it('passes validation', () => {
    expect(validation.pass).toBe(true);
  });

  it('sanitizes schema names with underscores to alphanumeric', () => {
    for (const name of schemaNames(cleaned)) {
      expect(name).toMatch(/^[a-zA-Z0-9]+$/);
    }
    expect(cleaned.components.schemas['CurrencyAmount_SimpleType']).toBeUndefined();
    expect(cleaned.components.schemas['CurrencyAmountSimpleType']).toBeDefined();
  });

  it('handles name collision (ItemRate1_0 vs Item_Rate1_0)', () => {
    const names = schemaNames(cleaned);
    const rateNames = names.filter(n => n.startsWith('ItemRate10'));
    expect(rateNames.length).toBe(2); // both present with distinct names
    expect(diag.entries.some(e => e.feature === 'schema-name-collision')).toBe(true);
  });

  it('updates $ref references after renaming', () => {
    // PricingOrCostAmount_0 referenced CurrencyAmount_SimpleType
    const schema = cleaned.components.schemas['PricingOrCostAmount0'];
    expect(schema.properties.Amount.$ref).toContain('CurrencyAmountSimpleType');
  });

  it('converts OAuth2 schemes to apiKey with TOKEN authorizer for APIGW', () => {
    const svc = cleaned.components.securitySchemes.ServiceOAuth2;
    expect(svc.type).toBe('apiKey');
    expect(svc.name).toBe('Authorization');
    expect(svc.in).toBe('header');
    expect(svc['x-amazon-apigateway-authorizer']).toBeDefined();
    expect(svc['x-amazon-apigateway-authorizer'].type).toBe('token');
    expect(svc['x-amazon-apigateway-authtype']).toBe('custom');

    const usr = cleaned.components.securitySchemes.UserOAuth2;
    expect(usr.type).toBe('apiKey');
    expect(usr['x-amazon-apigateway-authorizer']).toBeDefined();
    expect(usr['x-amazon-apigateway-authorizer'].type).toBe('token');
  });

  it('propagates root-level security to operations without own security', () => {
    // /items/{ItemId} and /items/{ItemId}/pricing have no explicit security
    const getItem = cleaned.paths['/api/v4.0/inventory/items/{ItemId}']?.get;
    expect(getItem.security).toBeDefined();
    // Scopes stripped (not supported with Lambda authorizers)
    expect(getItem.security).toEqual([{ ServiceOAuth2: [] }]);
  });

  it('preserves x-correlation-id response header', () => {
    const resp = cleaned.paths['/api/v4.0/inventory/item-requests']?.post?.responses?.['201'];
    expect(resp.headers['x-correlation-id']).toBeDefined();
  });

  it('inlines $ref responses (400Error)', () => {
    const resp = cleaned.paths['/api/v4.0/inventory/item-requests']?.post?.responses?.['400'];
    expect(resp.$ref).toBeUndefined();
    expect(resp.description).toBe('Bad request');
    expect(resp.headers['x-correlation-id']).toBeDefined();
  });

  it('preserves multiple content types (json, jose+jwe)', () => {
    const post = cleaned.paths['/api/v4.0/inventory/item-requests']?.post;
    expect(post.requestBody.content['application/json']).toBeDefined();
    expect(post.requestBody.content['application/jose+jwe']).toBeDefined();
  });

  it('prepends server base path /api/v4.0/inventory', () => {
    expect(cleaned.paths['/api/v4.0/inventory/items']).toBeDefined();
    expect(cleaned.paths['/items']).toBeUndefined();
  });

  it('removes unsupported fields: discriminator, nullable, example, readOnly, deprecated', () => {
    const item = cleaned.components.schemas.ItemDetail6;
    expect(item.properties.ItemId.readOnly).toBeUndefined();
    expect(item.properties.Status.nullable).toBeUndefined();
    expect(item.properties.Status.example).toBeUndefined();
    expect(item.properties.ItemSubType.discriminator).toBeUndefined();
  });

  it('converts x-namespaced-enum to standard enum', () => {
    const item = cleaned.components.schemas.ItemDetail6;
    expect(item.properties.ItemType.enum).toEqual(['Physical', 'Digital']);
    expect(item.properties.ItemType['x-namespaced-enum']).toBeUndefined();
  });

  it('generates SAM template with DefinitionUri (no DefinitionBody, no SAM Auth)', () => {
    const sam = generateSamTemplate(analysis, { region: 'us-east-1' });
    // Always DefinitionUri — no DefinitionBody, no SAM Auth overlay
    expect(sam).toContain('DefinitionUri');
    expect(sam).not.toContain('DefinitionBody');
    expect(sam).not.toContain('Authorizers');
    expect(sam).not.toContain('TOKEN');
    // Has authorizers → AuthorizerFunctionArn parameter + AuthorizerPermission
    expect(sam).toContain('AuthorizerFunctionArn');
    expect(sam).toContain('AuthorizerPermission');
    expect(sam).toContain('AWS::Lambda::Permission');
  });

  it('generates separate authorizer template for specs with OAuth2', () => {
    const auth = generateAuthorizerTemplate(analysis, { region: 'us-east-1' });
    expect(auth).not.toBeNull();
    expect(auth).toContain('AuthorizerFunction');
    expect(auth).toContain('AWS::Serverless::Function');
    expect(auth).toContain('AuthorizerFunctionArn');
    // Phase-1 template for single-stack two-phase deploy (no Export needed)
    expect(auth).toContain('phase 1');
  });
});

// ─── OpenAPI 3.1: Feature Downgrade ─────────────────────────────────────────
describe('OpenAPI 3.1 Feature Downgrade', () => {
  const spec = parseSpec(fixture('openapi31-features.yaml'));
  const analysis = analyzeSpec(spec, fixture('openapi31-features.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);
  const validation = validate(cleaned, analysis, diag);

  it('passes validation', () => {
    expect(validation.pass).toBe(true);
  });

  it('downgrades to OpenAPI 3.0.0', () => {
    expect(cleaned.openapi).toBe('3.0.0');
  });

  it('removes webhooks', () => {
    expect(cleaned.webhooks).toBeUndefined();
    expect(diagsByFeature(diag.entries, 'webhooks').length).toBeGreaterThan(0);
  });

  it('removes jsonSchemaDialect', () => {
    expect(cleaned.jsonSchemaDialect).toBeUndefined();
    expect(diagsByFeature(diag.entries, 'jsonSchemaDialect').length).toBeGreaterThan(0);
  });

  it('converts type array ["string", "null"] to type:string (nullable removed)', () => {
    const pet = cleaned.components.schemas.Pet;
    expect(pet.properties.tag.type).toBe('string');
    // nullable is added by 3.1 downgrade, then removed by json-schema-cleanup
    expect(pet.properties.tag.nullable).toBeUndefined();
  });

  it('converts multi-type array to oneOf', () => {
    const age = cleaned.components.schemas.NullableAge;
    expect(age.oneOf).toEqual([{ type: 'integer' }, { type: 'string' }]);
    expect(age.type).toBeUndefined();
  });

  it('converts const to single-value enum', () => {
    const pet = cleaned.components.schemas.Pet;
    expect(pet.properties.status.enum).toEqual(['active']);
    expect(pet.properties.status.const).toBeUndefined();
  });

  it('removes contentEncoding and contentMediaType', () => {
    const pet = cleaned.components.schemas.Pet;
    expect(pet.properties.avatar.contentEncoding).toBeUndefined();
    expect(pet.properties.avatar.contentMediaType).toBeUndefined();
  });

  it('converts $dynamicRef to $ref and removes $dynamicAnchor', () => {
    const tree = cleaned.components.schemas.TreeNode;
    expect(tree.properties.children.items.$ref).toBe('#node');
    expect(tree.properties.children.items.$dynamicRef).toBeUndefined();
    expect(tree.$dynamicAnchor).toBeUndefined();
  });

  it('prepends server base path /v2', () => {
    expect(cleaned.paths['/v2/pets']).toBeDefined();
    expect(cleaned.paths['/v2/pets/{petId}']).toBeDefined();
  });
});

// ─── Mixed Security Schemes ─────────────────────────────────────────────────
describe('Mixed Security Schemes', () => {
  const spec = parseSpec(fixture('openapi30-security-mixed.yaml'));
  const analysis = analyzeSpec(spec, fixture('openapi30-security-mixed.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);
  const validation = validate(cleaned, analysis, diag);

  it('FAILS validation because CookieAuth cannot be enforced by API Gateway', () => {
    // This fixture deliberately includes a cookie-based apiKey scheme. API Gateway
    // cannot use a cookie as an authorizer identity source, so /cookie-auth would
    // deploy unauthenticated. Validation must surface that rather than pass.
    expect(validation.pass).toBe(false);
    const authCheck = validation.checks.find(c => c.name === 'secured-operations-have-authorizer');
    expect(authCheck!.pass).toBe(false);
    expect(authCheck!.actual).toBe((authCheck!.expected as number) - 1);
  });

  it('reports the unenforceable cookie scheme as a breaking diagnostic', () => {
    const entry = diag.entries.find(e => e.feature === 'apiKey/non-standard');
    expect(entry).toBeDefined();
    expect(entry!.level).toBe('breaking');
  });

  it('every other secured operation still has a reachable authorizer', () => {
    // Only CookieAuth is unenforceable; the other 9 secured operations must be covered.
    const authCheck = validation.checks.find(c => c.name === 'secured-operations-have-authorizer');
    expect(authCheck!.expected).toBe(10);
    expect(authCheck!.actual).toBe(9);
  });

  it('converts bearer scheme to apiKey with TOKEN authorizer', () => {
    expect(cleaned.components.securitySchemes.BearerAuth.type).toBe('apiKey');
    expect(cleaned.components.securitySchemes.BearerAuth.name).toBe('Authorization');
    expect(cleaned.components.securitySchemes.BearerAuth.in).toBe('header');
    const ext = cleaned.components.securitySchemes.BearerAuth['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('token');
    expect(cleaned.components.securitySchemes.BearerAuth['x-amazon-apigateway-authtype']).toBe('custom');
  });

  it('converts OAuth2 scheme to apiKey with TOKEN authorizer', () => {
    expect(cleaned.components.securitySchemes.OAuth2.type).toBe('apiKey');
    const ext = cleaned.components.securitySchemes.OAuth2['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('token');
  });

  it('converts OpenID Connect scheme to apiKey with TOKEN authorizer', () => {
    expect(cleaned.components.securitySchemes.OpenID.type).toBe('apiKey');
    const ext = cleaned.components.securitySchemes.OpenID['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('token');
  });

  it('uses native API key for x-api-key header', () => {
    expect(cleaned['x-amazon-apigateway-api-key-source']).toBe('HEADER');
    expect(cleaned.components.securitySchemes.NativeApiKey['x-amazon-apigateway-authorizer']).toBeUndefined();
  });

  it('adds REQUEST authorizer for query apiKey', () => {
    const ext = cleaned.components!.securitySchemes!.QueryApiKey['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('request');
    expect(ext.identitySource).toContain('querystring.server_token');
  });

  it('adds REQUEST authorizer for custom header apiKey', () => {
    const ext = cleaned.components!.securitySchemes!.CustomHeaderApiKey['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('request');
    expect(ext.identitySource).toContain('header.api-key');
  });

  it('converts basic auth scheme to apiKey with REQUEST authorizer', () => {
    expect(cleaned.components.securitySchemes.BasicAuth.type).toBe('apiKey');
    expect(cleaned.components.securitySchemes.BasicAuth.name).toBe('Authorization');
    expect(cleaned.components.securitySchemes.BasicAuth.in).toBe('header');
    const ext = cleaned.components.securitySchemes.BasicAuth['x-amazon-apigateway-authorizer'];
    expect(ext).toBeDefined();
    expect(ext.type).toBe('request');
    expect(ext.identitySource).toBe('method.request.header.Authorization');
    expect(cleaned.components.securitySchemes.BasicAuth['x-amazon-apigateway-authtype']).toBe('custom');
  });

  it('propagates root-level BearerAuth to /inherited-security', () => {
    const op = cleaned.paths['/inherited-security']?.get;
    expect(op.security).toEqual([{ BearerAuth: [] }]);
  });

  it('does not propagate to /public (explicit empty security)', () => {
    const op = cleaned.paths['/public']?.get;
    expect(op.security).toEqual([]);
  });

  it('removes cookie parameters', () => {
    const params = cleaned.paths['/cookie-auth']?.get?.parameters ?? [];
    expect(params.every((p: any) => p.in !== 'cookie')).toBe(true);
  });
});

// ─── Binary Content Types ───────────────────────────────────────────────────
describe('Binary Content Types', () => {
  const spec = parseSpec(fixture('openapi30-binary-content.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);

  it('detects and declares binary media types', () => {
    const binaryTypes = cleaned['x-amazon-apigateway-binary-media-types'];
    expect(binaryTypes).toBeDefined();
    expect(binaryTypes).toContain('multipart/form-data');
    expect(binaryTypes).toContain('application/octet-stream');
    expect(binaryTypes).toContain('image/png');
    expect(binaryTypes).toContain('image/jpeg');
    expect(binaryTypes).toContain('application/pdf');
    expect(binaryTypes).toContain('application/gzip');
  });

  it('does not include application/json as binary', () => {
    const binaryTypes = cleaned['x-amazon-apigateway-binary-media-types'] ?? [];
    expect(binaryTypes).not.toContain('application/json');
  });

  it('adds mock integrations to all endpoints', () => {
    expect(hasIntegrationOnAll(cleaned)).toBe(true);
  });
});

// ─── Unsupported Fields & Extensions ────────────────────────────────────────
describe('Unsupported Fields & Extensions', () => {
  const spec = parseSpec(fixture('openapi30-unsupported-fields.yaml'));
  const analysis = analyzeSpec(spec, fixture('openapi30-unsupported-fields.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);
  const validation = validate(cleaned, analysis, diag);

  it('passes validation', () => {
    expect(validation.pass).toBe(true);
  });

  it('removes all unsupported schema fields', () => {
    const item = cleaned.components.schemas.Item;
    expect(item.properties.id.readOnly).toBeUndefined();
    expect(item.properties.name.example).toBeUndefined();
    expect(item.properties.description.deprecated).toBeUndefined();
    expect(item.properties.status.default).toBeUndefined();
    expect(item.properties.status.nullable).toBeUndefined();
    expect(item.properties.category.discriminator).toBeUndefined();
    expect(item.properties.threshold.exclusiveMinimum).toBeUndefined();
    expect(item.properties.metadata.examples).toBeUndefined();
  });

  it('converts int32/int64 on number to integer', () => {
    const item = cleaned.components.schemas.Item;
    expect(item.properties.priority.type).toBe('integer');
    expect(item.properties.score.type).toBe('integer');
  });

  it('removes format:decimal', () => {
    expect(cleaned.components.schemas.Item.properties.price.format).toBeUndefined();
  });

  it('removes unsupported parameter fields (style, explode, etc.)', () => {
    const getParams = cleaned.paths['/items']?.get?.parameters ?? [];
    const filterParam = getParams.find((p: any) => p.name === 'filter');
    expect(filterParam).toBeDefined();
    expect(filterParam.style).toBeUndefined();
    expect(filterParam.explode).toBeUndefined();
    expect(filterParam.allowReserved).toBeUndefined();
    expect(filterParam.allowEmptyValue).toBeUndefined();
  });

  it('removes cookie parameters', () => {
    const getParams = cleaned.paths['/items']?.get?.parameters ?? [];
    expect(getParams.every((p: any) => p.in !== 'cookie')).toBe(true);
  });

  it('wraps primitive response type in schema ref', () => {
    const resp204 = cleaned.paths['/items']?.get?.responses?.['204'];
    expect(resp204.content['application/json'].schema.$ref).toBe('#/components/schemas/StringResponse');
    expect(cleaned.components.schemas.StringResponse).toEqual({ type: 'string' });
  });

  it('inlines $ref response (500 InternalError)', () => {
    const resp500 = cleaned.paths['/items']?.post?.responses?.['500'];
    expect(resp500.$ref).toBeUndefined();
    expect(resp500.description).toBe('Internal Server Error');
  });

  it('converts x-namespaced-enum to standard enum', () => {
    const status = cleaned.components.schemas.PaymentStatus.properties.status;
    expect(status.enum).toEqual(['pending', 'completed', 'failed']);
    expect(status['x-namespaced-enum']).toBeUndefined();
  });

  it('does not overwrite existing enum with x-* conversion', () => {
    const channel = cleaned.components.schemas.PaymentStatus.properties.channel;
    expect(channel.enum).toEqual(['web', 'mobile', 'api']);
    expect(channel['x-custom-values']).toBeUndefined();
  });

  it('removes x-* extensions from schemas', () => {
    const ext = cleaned.components.schemas.VendorExtended;
    expect(ext['x-internal']).toBeUndefined();
    expect(ext['x-deprecated-since']).toBeUndefined();
    expect(ext.properties.value['x-field-level-ext']).toBeUndefined();
  });

  it('preserves x-* response headers', () => {
    const resp200 = cleaned.paths['/items']?.get?.responses?.['200'];
    expect(resp200.headers['x-request-id']).toBeDefined();
    expect(resp200.headers['x-rate-limit']).toBeDefined();
  });

  it('logs diagnostics for every removal/conversion', () => {
    expect(diagsByFeature(diag.entries, 'readOnly').length).toBeGreaterThan(0);
    expect(diagsByFeature(diag.entries, 'discriminator').length).toBeGreaterThan(0);
    expect(diagsByFeature(diag.entries, 'nullable').length).toBeGreaterThan(0);
    expect(diagsByFeature(diag.entries, 'format:decimal').length).toBeGreaterThan(0);
    expect(diagsByRule(diag.entries, 'parameter-cleanup').length).toBeGreaterThan(0);
    expect(diagsByRule(diag.entries, 'extension-cleanup').length).toBeGreaterThan(0);
  });
});

// ─── Webhook Notifications (URN Schema Names) ──────────────────────────────
describe('Webhook Notifications (URN schema names)', () => {
  const spec = parseSpec(fixture('openapi30-urn-schemas.yaml'));
  const analysis = analyzeSpec(spec, fixture('openapi30-urn-schemas.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);
  const validation = validate(cleaned, analysis, diag);

  it('passes validation', () => {
    expect(validation.pass).toBe(true);
  });

  it('sanitizes URN-style schema names (colons, dots, slashes)', () => {
    for (const name of schemaNames(cleaned)) {
      expect(name).toMatch(/^[a-zA-Z0-9]+$/);
    }
    // The URN name should be gone
    expect(cleaned.components.schemas['urn:example:org:webhooks:events:resource-update']).toBeUndefined();
  });

  it('sanitizes nested schema names with http:// prefix', () => {
    // http://webhooks.example.org/rid → httpwebhooksexampleorgrid
    const names = schemaNames(cleaned);
    expect(names.every(n => !n.includes('/'))).toBe(true);
    expect(names.every(n => !n.includes(':'))).toBe(true);
  });

  it('removes unsupported fields (readOnly, example, default)', () => {
    const sub = cleaned.components.schemas.EventSubscriptionResponse1;
    expect(sub.properties.EventSubscriptionId.readOnly).toBeUndefined();
    expect(sub.properties.CallbackUrl.example).toBeUndefined();

    const poll = cleaned.components.schemas.EventPolling1;
    expect(poll.properties.maxEvents.default).toBeUndefined();
    expect(poll.properties.returnImmediately.default).toBeUndefined();
  });

  it('prepends server base path /api/v4.0', () => {
    expect(cleaned.paths['/api/v4.0/event-subscriptions']).toBeDefined();
    expect(cleaned.paths['/api/v4.0/events']).toBeDefined();
  });
});

// ─── SAM Template & Deploy Script Generation ─────────────────────────────────
describe('Output Generation', () => {
  const spec = parseSpec(fixture('openapi30-complex-schemas.yaml'));
  const analysis = analyzeSpec(spec, fixture('openapi30-complex-schemas.yaml'));
  const diag = createDiagnostics();
  runPipeline(spec, diag);

  it('generates SAM template with DefinitionUri (unified strategy)', () => {
    const sam = generateSamTemplate(analysis, { region: 'us-east-1', stage: 'test' });
    expect(sam).toContain('AWSTemplateFormatVersion');
    expect(sam).toContain('AWS::Serverless-2016-10-31');
    expect(sam).toContain('AWS::Serverless::Api');
    expect(sam).toContain('DefinitionUri');
    expect(sam).not.toContain('DefinitionBody');
    expect(sam).toContain('FailOnWarnings: false');
    expect(sam).toContain('OpenApiVersion');
    // Has authorizers → Lambda + Permission embedded in same template
    expect(sam).toContain('AuthorizerFunctionArn');
    expect(sam).toContain('AuthorizerPermission');
    expect(sam).toContain('AWS::Lambda::Permission');
    expect(sam).toContain('AWS::Serverless::Function');
    expect(sam).toContain('AuthorizerFunction');
    // No SAM Auth overlay — authorizer config is in the spec itself
    expect(sam).not.toContain('Authorizers');
    expect(sam).not.toContain('TOKEN');
    // SAM auto-creates role, deployment, and stage
    expect(sam).not.toContain('AuthorizerLambdaRole');
    expect(sam).not.toContain('AWS::ApiGateway::Deployment');
    expect(sam).not.toContain('AWS::ApiGateway::Stage');
    // Outputs
    expect(sam).toContain('RestApiId');
    expect(sam).toContain('InvokeURL');
  });

  it('generates authorizer template for specs with OAuth2', () => {
    const auth = generateAuthorizerTemplate(analysis, { region: 'us-east-1' });
    expect(auth).not.toBeNull();
    expect(auth!).toContain('AuthorizerFunction');
    expect(auth!).toContain('AWS::Serverless::Function');
    expect(auth!).toContain('AuthorizerFunctionArn');
    expect(auth!).toContain('phase 1');
  });

  it('generates deploy script with S3 upload and authorizer resolution', () => {
    const specs: SpecDeployInfo[] = [{
      apiTemplate: 'openapi30-complex-schemas.sam.yaml',
      cleanedSpec: 'openapi30-complex-schemas-cleaned.yaml',
      authorizerTemplate: 'openapi30-complex-schemas-auth.sam.yaml',
    }];
    const script = generateDeployScript(specs, { region: 'us-east-1', stage: 'test' });
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('command -v sam');
    expect(script).toContain('sam deploy');
    expect(script).toContain('--resolve-s3');
    expect(script).toContain('CAPABILITY_IAM');
    expect(script).toContain('--no-fail-on-empty-changeset');
    expect(script).toContain('--no-confirm-changeset');
    // S3 upload for cleaned spec
    expect(script).toContain('aws s3 cp');
    // Authorizer two-phase deploy
    expect(script).toContain('Phase 1');
    expect(script).toContain('Phase 2');
    expect(script).toContain('AUTHORIZER_FUNCTION_ARN');
    expect(script).toContain('AWS_REGION');
    expect(script).toContain('AuthorizerFunctionArn');
  });

  it('generates deploy script without authorizer phases for specs without security', () => {
    const specs: SpecDeployInfo[] = [{
      apiTemplate: 'openapi30-binary-content.sam.yaml',
      cleanedSpec: 'openapi30-binary-content-cleaned.yaml',
      authorizerTemplate: null,
    }];
    const script = generateDeployScript(specs, { region: 'us-east-1', stage: 'test' });
    expect(script).toContain('sam deploy');
    expect(script).toContain('aws s3 cp');
    expect(script).not.toContain('Phase 1');
    expect(script).not.toContain('Phase 2');
    expect(script).not.toContain('AUTHORIZER_FUNCTION_ARN');
  });

  it('does not generate authorizer template or resources for specs without security', () => {
    const noSecSpec = parseSpec(fixture('openapi30-binary-content.yaml'));
    const noSecAnalysis = analyzeSpec(noSecSpec, fixture('openapi30-binary-content.yaml'));
    const sam = generateSamTemplate(noSecAnalysis, {});
    expect(sam).not.toContain('AuthorizerFunction');
    expect(sam).not.toContain('AuthorizerFunctionArn');
    expect(sam).not.toContain('AuthorizerPermission');
    expect(sam).toContain('DefinitionUri');
    expect(sam).not.toContain('DefinitionBody');

    const auth = generateAuthorizerTemplate(noSecAnalysis, {});
    expect(auth).toBeNull();
  });
});

// ─── Resource Limit Advisory Check ───────────────────────────────────────────
describe('Resource Limit Advisory Check', () => {
  const spec = parseSpec(fixture('openapi30-complex-schemas.yaml'));
  const analysis = analyzeSpec(spec, fixture('openapi30-complex-schemas.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);

  it('includes api-gateway-resource-limit advisory check', () => {
    const result = validate(cleaned, analysis, createDiagnostics());
    const check = result.checks.find(c => c.name === 'api-gateway-resource-limit');
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });
});

// ─── Multi-rule fixture (v4 gap-scan follow-ups) ────────────────────────────
describe('Multi-rule fixture', () => {
  const spec = parseSpec(fixture('multi-rule.yaml'));
  const analysis = analyzeSpec(spec, fixture('multi-rule.yaml'));
  const diag = createDiagnostics();
  const cleaned = runPipeline(spec, diag);
  const serialized = serializeSpec(cleaned, 'yaml');

  it('cleaned YAML contains no anchors', () => {
    expect(serialized).not.toMatch(/&[a-zA-Z_]\w*\s/);
    expect(serialized).not.toMatch(/\*[a-zA-Z_]\w*\s/);
  });

  it('bracket query params are renamed', () => {
    const params = cleaned.paths['/items'].get.parameters.map((p: any) => p.name);
    expect(params).toContain('_tag');
    expect(params).toContain('_$gte');
    expect(params).not.toContain('filter[tag]');
    expect(params).not.toContain('createdAt[$gte]');
  });

  it('query-suffix path with sibling is dropped', () => {
    expect(cleaned.paths['/widgets?kind=special']).toBeUndefined();
    expect(cleaned.paths['/widgets']).toBeDefined();
    const removed = diag.entries.find(e => e.feature === 'query-in-path-key' && e.action === 'removed');
    expect(removed).toBeDefined();
  });

  it('query-suffix path without sibling is renamed', () => {
    expect(cleaned.paths['/orphan?tag=x']).toBeUndefined();
    expect(cleaned.paths['/orphan']).toBeDefined();
    const converted = diag.entries.find(e => e.feature === 'query-in-path-key' && e.action === 'converted');
    expect(converted).toBeDefined();
  });

  it('pipeline emits warning + breaking per bracket-param rename', () => {
    const warnings = diag.entries.filter(e => e.feature === 'bracket-query-param');
    expect(warnings.length).toBe(2);
    const breaking = diag.entries.filter(e => e.feature === 'query-param-renamed');
    expect(breaking.length).toBe(2);
  });
});
