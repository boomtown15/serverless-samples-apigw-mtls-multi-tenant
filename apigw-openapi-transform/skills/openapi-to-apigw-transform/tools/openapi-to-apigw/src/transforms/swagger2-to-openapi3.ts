import type { OpenAPISpec, Diagnostics } from '../types.js';

const RULE = 'swagger2-to-openapi3';

/**
 * Convert a Swagger 2.0 spec to OpenAPI 3.0.0 structure.
 * If the spec is already 3.x, return it unchanged.
 */
export function swagger2ToOpenapi3(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  if (!spec.swagger || !String(spec.swagger).startsWith('2.')) {
    return spec;
  }

  diag.info(RULE, '#', 'swagger2.0', 'converted', `Converting Swagger ${spec.swagger} to OpenAPI 3.0.0`);

  const result: OpenAPISpec = {
    openapi: '3.0.0',
    info: spec.info ?? { title: 'Untitled', version: '1.0.0' },
  };

  // servers from host/basePath/schemes
  if (spec.host) {
    const scheme = spec.schemes?.[0] ?? 'https';
    const basePath = spec.basePath ?? '/';
    result.servers = [{ url: `${scheme}://${spec.host}${basePath}` }];
    diag.info(RULE, '#/servers', 'host+basePath+schemes', 'converted',
      `Converted host=${spec.host}, basePath=${basePath} to servers`);
  }

  // tags, externalDocs
  if (spec.tags) result.tags = spec.tags;
  if (spec.externalDocs) result.externalDocs = spec.externalDocs;

  // security (root-level)
  if (spec.security) result.security = spec.security;

  // components
  result.components = {};

  // definitions → components/schemas
  if (spec.definitions) {
    result.components.schemas = { ...spec.definitions };
    diag.info(RULE, '#/definitions', 'definitions', 'converted',
      `Moved ${Object.keys(spec.definitions).length} definitions to components/schemas`);
  }

  // securityDefinitions → components/securitySchemes
  if (spec.securityDefinitions) {
    result.components.securitySchemes = convertSecurityDefs(spec.securityDefinitions, diag);
  }

  // parameters → components/parameters (for reusable params)
  if (spec.parameters) {
    result.components.parameters = convertReusableParams(spec.parameters, spec, diag);
  }

  // responses → components/responses
  if (spec.responses) {
    result.components.responses = convertReusableResponses(spec.responses, spec, diag);
  }

  // paths
  result.paths = convertPaths(spec.paths ?? {}, spec, diag);

  // Copy any x-amazon-apigateway-* extensions at root level
  for (const [key, value] of Object.entries(spec)) {
    if (key.startsWith('x-amazon-apigateway-')) {
      result[key] = value;
    }
  }

  // Rewrite all #/definitions/ $refs to #/components/schemas/
  rewriteDefinitionRefs(result);

  return result;
}

/**
 * Recursively rewrite all $ref values from #/definitions/X to #/components/schemas/X.
 */
function rewriteDefinitionRefs(obj: any): void {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      rewriteDefinitionRefs(item);
    }
    return;
  }

  if (typeof obj.$ref === 'string' && obj.$ref.startsWith('#/definitions/')) {
    obj.$ref = obj.$ref.replace('#/definitions/', '#/components/schemas/');
  }

  for (const value of Object.values(obj)) {
    rewriteDefinitionRefs(value);
  }
}

function convertSecurityDefs(
  defs: Record<string, any>,
  diag: Diagnostics,
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [name, def] of Object.entries(defs)) {
    if (def.type === 'oauth2') {
      result[name] = convertOAuth2Scheme(name, def, diag);
    } else if (def.type === 'basic') {
      result[name] = { type: 'http', scheme: 'basic' };
      diag.info(RULE, `#/securityDefinitions/${name}`, 'basic-auth', 'converted',
        'Converted basic auth to http/basic scheme');
    } else if (def.type === 'apiKey') {
      result[name] = { type: 'apiKey', name: def.name, in: def.in };
      if (def.description) result[name].description = def.description;
    } else {
      result[name] = { ...def };
    }
  }

  return result;
}

function convertOAuth2Scheme(
  name: string,
  def: Record<string, any>,
  diag: Diagnostics,
): Record<string, any> {
  const scheme: Record<string, any> = { type: 'oauth2', flows: {} };

  const flowMap: Record<string, string> = {
    implicit: 'implicit',
    password: 'password',
    application: 'clientCredentials',
    accessCode: 'authorizationCode',
  };

  const flowName = flowMap[def.flow] ?? def.flow;
  const flow: Record<string, any> = {};

  if (def.authorizationUrl) flow.authorizationUrl = def.authorizationUrl;
  if (def.tokenUrl) flow.tokenUrl = def.tokenUrl;
  flow.scopes = def.scopes ?? {};

  scheme.flows[flowName] = flow;
  if (def.description) scheme.description = def.description;

  diag.info(RULE, `#/securityDefinitions/${name}`, 'oauth2', 'converted',
    `Converted OAuth2 flow '${def.flow}' to '${flowName}'`);

  return scheme;
}

function convertReusableParams(
  params: Record<string, any>,
  rootSpec: OpenAPISpec,
  diag: Diagnostics,
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [name, param] of Object.entries(params)) {
    result[name] = convertParameter(param, rootSpec);
  }
  return result;
}

function convertReusableResponses(
  responses: Record<string, any>,
  rootSpec: OpenAPISpec,
  diag: Diagnostics,
): Record<string, any> {
  const result: Record<string, any> = {};
  const produces = rootSpec.produces ?? ['application/json'];

  for (const [code, resp] of Object.entries(responses)) {
    result[code] = convertResponse(resp, produces);
  }
  return result;
}

function convertPaths(
  paths: Record<string, any>,
  rootSpec: OpenAPISpec,
  diag: Diagnostics,
): Record<string, any> {
  const result: Record<string, any> = {};
  const globalProduces = rootSpec.produces ?? ['application/json'];
  const globalConsumes = rootSpec.consumes ?? ['application/json'];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const newPathItem: Record<string, any> = {};

    // path-level parameters
    if (pathItem.parameters) {
      newPathItem.parameters = pathItem.parameters.map(
        (p: any) => p.$ref ? p : convertParameter(p, rootSpec),
      );
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      if (method === 'parameters' || method.startsWith('x-')) {
        if (method.startsWith('x-')) newPathItem[method] = operation;
        continue;
      }
      if (typeof operation !== 'object' || !operation) continue;

      const op = operation as Record<string, any>;
      const produces = op.produces ?? globalProduces;
      const consumes = op.consumes ?? globalConsumes;

      const newOp: Record<string, any> = {};
      if (op.tags) newOp.tags = op.tags;
      if (op.summary) newOp.summary = op.summary;
      if (op.description) newOp.description = op.description;
      if (op.operationId) newOp.operationId = op.operationId;
      if (op.deprecated) newOp.deprecated = op.deprecated;
      if (op.security) newOp.security = op.security;
      if (op.externalDocs) newOp.externalDocs = op.externalDocs;

      // parameters (non-body)
      const params: any[] = [];
      const bodyParam = (op.parameters ?? []).find((p: any) => p.in === 'body');
      for (const p of op.parameters ?? []) {
        if (p.$ref) {
          params.push(p);
        } else if (p.in !== 'body' && p.in !== 'formData') {
          params.push(convertParameter(p, rootSpec));
        }
      }
      if (params.length > 0) newOp.parameters = params;

      // requestBody from body param or formData
      if (bodyParam) {
        newOp.requestBody = convertBodyParam(bodyParam, consumes);
      } else {
        const formParams = (op.parameters ?? []).filter((p: any) => p.in === 'formData');
        if (formParams.length > 0) {
          newOp.requestBody = convertFormDataParams(formParams, consumes);
        }
      }

      // responses
      newOp.responses = {};
      for (const [code, resp] of Object.entries(op.responses ?? {})) {
        if ((resp as any)?.$ref) {
          newOp.responses[code] = resp;
        } else {
          newOp.responses[code] = convertResponse(resp as Record<string, any>, produces);
        }
      }

      // x-* extensions on operation
      for (const [key, val] of Object.entries(op)) {
        if (key.startsWith('x-')) newOp[key] = val;
      }

      newPathItem[method] = newOp;
    }

    result[path] = newPathItem;
  }

  return result;
}

function convertParameter(param: Record<string, any>, rootSpec: OpenAPISpec): Record<string, any> {
  const result: Record<string, any> = {
    name: param.name,
    in: param.in,
  };
  if (param.description) result.description = param.description;
  if (param.required) result.required = param.required;

  // schema from type/format/items/enum
  if (param.type) {
    const schema: Record<string, any> = { type: param.type };
    if (param.format) schema.format = param.format;
    if (param.items) schema.items = param.items;
    if (param.enum) schema.enum = param.enum;
    if (param.default !== undefined) schema.default = param.default;
    if (param.minimum !== undefined) schema.minimum = param.minimum;
    if (param.maximum !== undefined) schema.maximum = param.maximum;
    if (param.pattern) schema.pattern = param.pattern;
    result.schema = schema;
  } else if (param.schema) {
    result.schema = param.schema;
  }

  return result;
}

function convertBodyParam(
  param: Record<string, any>,
  consumes: string[],
): Record<string, any> {
  const requestBody: Record<string, any> = {};
  if (param.description) requestBody.description = param.description;
  if (param.required) requestBody.required = param.required;

  requestBody.content = {};
  for (const mediaType of consumes) {
    requestBody.content[mediaType] = {
      schema: param.schema ?? {},
    };
  }

  return requestBody;
}

function convertFormDataParams(
  params: Record<string, any>[],
  consumes: string[],
): Record<string, any> {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const p of params) {
    const schema: Record<string, any> = {};
    if (p.type === 'file') {
      schema.type = 'string';
      schema.format = 'binary';
    } else {
      if (p.type) schema.type = p.type;
      if (p.format) schema.format = p.format;
    }
    properties[p.name] = schema;
    if (p.required) required.push(p.name);
  }

  const mediaTypes = consumes.some((c: string) =>
    c.includes('multipart') || c.includes('form-urlencoded'))
    ? consumes
    : ['multipart/form-data'];

  const content: Record<string, any> = {};
  for (const mt of mediaTypes) {
    content[mt] = {
      schema: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    };
  }

  return { content };
}

function convertResponse(
  resp: Record<string, any>,
  produces: string[],
): Record<string, any> {
  const result: Record<string, any> = {};
  if (resp.description) result.description = resp.description;

  if (resp.schema) {
    result.content = {};
    for (const mediaType of produces) {
      result.content[mediaType] = { schema: resp.schema };
    }
  }

  if (resp.headers) {
    result.headers = {};
    for (const [name, header] of Object.entries(resp.headers)) {
      const h = header as Record<string, any>;
      result.headers[name] = {
        ...(h.description ? { description: h.description } : {}),
        schema: {
          type: h.type ?? 'string',
          ...(h.format ? { format: h.format } : {}),
        },
      };
    }
  }

  return result;
}
