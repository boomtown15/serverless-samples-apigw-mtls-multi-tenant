import type { OpenAPISpec, Diagnostics } from '../types.js';
import { HTTP_METHODS } from '../types.js';

const RULE = 'parameter-cleanup';

/** Fields API Gateway supports on parameters. */
const ALLOWED_PARAM_FIELDS = new Set([
  'name', 'in', 'required', 'type', 'description', 'schema', '$ref',
]);

/** API Gateway parameter name regex. */
const VALID_PARAM_NAME = /^[a-zA-Z0-9:._$\-]+$/;

/**
 * Clean up parameters for API Gateway compatibility.
 * - Keep only: name, in, required, type, description, schema
 * - Remove: style, explode, allowReserved, allowEmptyValue, content, etc.
 * - Remove cookie parameters entirely
 */
export function parameterCleanup(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);

  // Clean reusable parameters
  if (result.components?.parameters) {
    for (const [name, param] of Object.entries(result.components.parameters)) {
      cleanParam(param as Record<string, any>, `#/components/parameters/${name}`, diag, result);
    }
  }

  // Clean inline parameters on paths and operations
  const paths = result.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pi = pathItem as Record<string, any>;

    // Path-level params
    if (Array.isArray(pi.parameters)) {
      pi.parameters = cleanParamList(pi.parameters, `#/paths/${path}/parameters`, diag, result);
    }

    for (const method of HTTP_METHODS) {
      const op = pi[method];
      if (!op?.parameters) continue;
      op.parameters = cleanParamList(
        op.parameters,
        `#/paths/${path}/${method}/parameters`,
        diag,
        result,
      );
    }
  }

  return result;
}

function cleanParamList(
  params: any[],
  basePath: string,
  diag: Diagnostics,
  spec: OpenAPISpec,
): any[] {
  const result: any[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < params.length; i++) {
    const param = params[i];

    // Skip $ref params
    if (param.$ref) {
      const refName = param.$ref.split('/').pop();
      const refParam = spec.components?.parameters?.[refName];
      if (refParam?.in === 'cookie') {
        diag.warn(RULE, `${basePath}/${i}`, 'cookie-parameter', 'removed',
          `Removed cookie parameter ref '${refName}' (API Gateway does not support cookie parameters)`);
        continue;
      }
      result.push(param);
      continue;
    }

    // Remove cookie parameters
    if (param.in === 'cookie') {
      diag.warn(RULE, `${basePath}/${i}`, 'cookie-parameter', 'removed',
        `Removed cookie parameter '${param.name}' (API Gateway does not support cookie parameters)`);
      continue;
    }

    // Sanitize parameter name: remove invalid characters
    if (param.name && !VALID_PARAM_NAME.test(param.name)) {
      const original = param.name;
      param.name = original.replace(/[^a-zA-Z0-9:._$\-]/g, '');
      diag.info(RULE, `${basePath}/${i}`, 'param-name-sanitized', 'renamed',
        `Sanitized parameter name '${original}' → '${param.name}'`);
    }

    // Deduplicate: API Gateway requires unique param names across query/header/path
    const nameKey = param.name;
    if (seenNames.has(nameKey)) {
      // Rename the duplicate by prefixing with location
      const original = param.name;
      param.name = `${param.in}-${param.name}`;
      diag.info(RULE, `${basePath}/${i}`, 'duplicate-param-name', 'renamed',
        `Renamed duplicate parameter '${original}' (${param.in}) → '${param.name}'`);
    }
    seenNames.add(param.name);

    cleanParam(param, `${basePath}/${i}`, diag, spec);
    result.push(param);
  }

  return result;
}

function cleanParam(
  param: Record<string, any>,
  path: string,
  diag: Diagnostics,
  spec: OpenAPISpec,
): void {
  for (const key of Object.keys(param)) {
    if (!ALLOWED_PARAM_FIELDS.has(key) && !key.startsWith('x-amazon-apigateway-')) {
      diag.info(RULE, `${path}/${key}`, key, 'removed',
        `Removed unsupported parameter field '${key}'`, param[key]);
      delete param[key];
    }
  }
}
