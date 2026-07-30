import { basename } from 'node:path';
import type { OpenAPISpec, SourceAnalysis, SecuritySchemeInfo, SecuritySchemeType, HttpMethod, HTTP_METHODS } from './types.js';
import { HTTP_METHODS as METHODS } from './types.js';

const KNOWN_SCHEME_TYPES = new Set<string>(['apiKey', 'http', 'oauth2', 'openIdConnect']);
function toSchemeType(raw: unknown): SecuritySchemeType {
  return typeof raw === 'string' && KNOWN_SCHEME_TYPES.has(raw)
    ? raw as SecuritySchemeType
    : 'unknown';
}

export function analyzeSpec(spec: OpenAPISpec, filePath: string): SourceAnalysis {
  const version = spec.openapi ?? spec.swagger ?? 'unknown';
  const paths = spec.paths ?? {};
  const pathCount = Object.keys(paths).length;

  let operationCount = 0;
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of METHODS) {
      if ((pathItem as Record<string, any>)[method]) {
        operationCount++;
      }
    }
  }

  const schemas = spec.components?.schemas ?? spec.definitions ?? {};
  const schemaCount = Object.keys(schemas).length;

  const securitySchemes = extractSecuritySchemes(spec);
  const serverUrls = extractServerUrls(spec);

  return {
    fileName: basename(filePath),
    openapiVersion: version,
    pathCount,
    operationCount,
    schemaCount,
    securitySchemes,
    serverUrls,
    needsSwagger2Upgrade: version.startsWith('2.'),
    needs31Downgrade: version.startsWith('3.1'),
  };
}

function extractSecuritySchemes(spec: OpenAPISpec): SecuritySchemeInfo[] {
  const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  const result: SecuritySchemeInfo[] = [];

  for (const [name, def] of Object.entries(schemes)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, any>;

    const info: SecuritySchemeInfo = {
      name,
      type: toSchemeType(d.type),
    };

    // Swagger 2.0 'basic' auth — map to OpenAPI 3.0 equivalent so
    // needsLambdaAuthorizer (which checks http/basic) fires. This
    // ensures generateAuthorizerTemplate sees the scheme as needing
    // a Lambda authorizer, even though the pipeline transform hasn't
    // run yet at analysis time.
    if (d.type === 'basic') {
      info.type = 'http';
      info.scheme = 'basic';
    } else if (d.scheme) {
      info.scheme = d.scheme;
    }
    if (d.in) info.in = d.in;
    if (d.name) info.paramName = d.name;
    if (d.openIdConnectUrl) info.openIdConnectUrl = d.openIdConnectUrl;
    if (d['x-amazon-apigateway-authtype'] === 'custom') info.explicitCustomAuthtype = true;

    if (d.flows && typeof d.flows === 'object') {
      info.flows = Object.keys(d.flows);
    }
    // Swagger 2.0 flow field
    if (d.flow) {
      info.flows = [d.flow];
    }

    result.push(info);
  }

  return result;
}

function extractServerUrls(spec: OpenAPISpec): string[] {
  if (spec.servers) {
    return spec.servers
      .map((s: any) => s.url)
      .filter((u: any) => typeof u === 'string');
  }

  // Swagger 2.0
  if (spec.host) {
    const scheme = spec.schemes?.[0] ?? 'https';
    const basePath = spec.basePath ?? '/';
    return [`${scheme}://${spec.host}${basePath}`];
  }

  return [];
}
