import type { OpenAPISpec, Diagnostics } from '../types.js';
import { HTTP_METHODS } from '../types.js';

const RULE = 'mock-integrations';

/** HTTP_METHODS plus API Gateway's catch-all pseudo-method. */
const METHODS_TO_PROCESS = [...HTTP_METHODS, 'x-amazon-apigateway-any-method'] as const;

const BINARY_MEDIA_PATTERNS = [
  'multipart/form-data', 'application/octet-stream',
  'image/', 'audio/', 'video/', 'application/pdf',
  'application/zip', 'application/gzip',
];

// Convert wildcard status codes to specific codes (API Gateway rejects 5XX, 2XX, etc.)
const WILDCARD_STATUS_MAP: Record<string, string> = {
  '1XX': '100',
  '2XX': '200',
  '3XX': '300',
  '4XX': '400',
  '5XX': '500',
};

/**
 * Add x-amazon-apigateway-integration MOCK integrations to every operation.
 * - Sets type:mock with matching status code
 * - Adds requestTemplates/responseTemplates for each content type
 * - Detects binary content types and adds x-amazon-apigateway-binary-media-types
 */
export function mockIntegrations(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);
  const binaryTypes = new Set<string>();

  const paths = result.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of METHODS_TO_PROCESS) {
      const op = (pathItem as Record<string, any>)[method];
      if (!op) continue;

      // Convert wildcard status codes to specific codes (API Gateway requires specific codes)
      if (op.responses) {
        for (const [code, resp] of Object.entries(op.responses)) {
          const mapped = WILDCARD_STATUS_MAP[code];
          if (mapped && !op.responses[mapped]) {
            op.responses[mapped] = resp;
            delete op.responses[code];
            diag.info(RULE, `#/paths/${path}/${method}/responses/${code}`, 'wildcard-status-code', 'converted',
              `Converted wildcard status code '${code}' to '${mapped}' (API Gateway requires specific codes)`);
          }
        }
      }

      // Convert 'default' method response to a proper status code
      if (op.responses?.default && typeof op.responses.default === 'object') {
        const hasNumericCode = Object.keys(op.responses).some(k => /^\d{3}$/.test(k));
        if (!hasNumericCode) {
          op.responses['200'] = op.responses.default;
        }
        delete op.responses.default;
      }

      // Clean invalid content types from responses and requestBody
      for (const [code, resp] of Object.entries(op.responses ?? {})) {
        if ((resp as any)?.content) {
          (resp as any).content = cleanContentMap((resp as any).content, diag, `#/paths/${path}/${method}/responses/${code}/content`);
        }
      }
      if (op.requestBody?.content) {
        op.requestBody.content = cleanContentMap(op.requestBody.content, diag, `#/paths/${path}/${method}/requestBody/content`);
      }

      // Ensure operation has at least one method response — API Gateway requires
      // a method response definition to match each integration response status code.
      if (!op.responses || Object.keys(op.responses).length === 0) {
        op.responses = { '200': { description: 'Mock response' } };
        diag.info(RULE, `#/paths/${path}/${method}`, 'default-method-response', 'converted',
          'Added default 200 method response (operation had no responses defined)');
      }

      // Skip if already has integration
      if (op['x-amazon-apigateway-integration']) continue;

      const statusCode = getPrimarySuccessCode(op.responses);
      const contentTypes = collectContentTypes(op);

      // Check for binary content types
      for (const ct of contentTypes) {
        if (isBinaryContentType(ct)) {
          binaryTypes.add(ct);
        }
      }

      // Build requestTemplates
      const requestTemplates: Record<string, string> = {};
      const requestContentTypes = collectRequestContentTypes(op);
      if (requestContentTypes.length > 0) {
        for (const ct of requestContentTypes) {
          requestTemplates[ct] = `{"statusCode": ${statusCode}}`;
        }
      } else {
        requestTemplates['application/json'] = `{"statusCode": ${statusCode}}`;
      }

      // Build integration responses
      const responseTemplates: Record<string, string> = {};
      const responseContentTypes = collectResponseContentTypes(op, statusCode);
      if (responseContentTypes.length > 0) {
        for (const ct of responseContentTypes) {
          responseTemplates[ct] = '';
        }
      }

      const integration: Record<string, any> = {
        type: 'mock',
        passthroughBehavior: 'when_no_templates',
        requestTemplates,
        responses: {
          default: {
            statusCode: String(statusCode),
            ...(Object.keys(responseTemplates).length > 0
              ? { responseTemplates }
              : {}),
          },
        },
      };

      op['x-amazon-apigateway-integration'] = integration;
    }
  }

  // Add binary media types at API level
  if (binaryTypes.size > 0) {
    result['x-amazon-apigateway-binary-media-types'] = [...binaryTypes].sort();
    diag.info(RULE, '#', 'binary-media-types', 'converted',
      `Added ${binaryTypes.size} binary media types: ${[...binaryTypes].join(', ')}`);
  }

  return result;
}

function getPrimarySuccessCode(responses: Record<string, any> | undefined): number {
  if (!responses) return 200;

  // Prefer 200, then 201, 202, 204, then first 2xx
  for (const preferred of ['200', '201', '202', '204']) {
    if (responses[preferred]) return parseInt(preferred);
  }

  for (const code of Object.keys(responses)) {
    if (code.startsWith('2')) return parseInt(code);
  }

  return 200;
}

function collectContentTypes(op: Record<string, any>): string[] {
  const types = new Set<string>();

  if (op.requestBody?.content) {
    for (const ct of Object.keys(op.requestBody.content)) {
      if (isValidContentType(ct)) types.add(ct);
    }
  }

  for (const resp of Object.values(op.responses ?? {})) {
    if ((resp as any)?.content) {
      for (const ct of Object.keys((resp as any).content)) {
        if (isValidContentType(ct)) types.add(ct);
      }
    }
  }

  return [...types];
}

function collectRequestContentTypes(op: Record<string, any>): string[] {
  if (!op.requestBody?.content) return [];
  return Object.keys(op.requestBody.content).filter(isValidContentType);
}

function collectResponseContentTypes(op: Record<string, any>, statusCode: number): string[] {
  const resp = op.responses?.[String(statusCode)];
  if (!resp?.content) return [];
  return Object.keys(resp.content).filter(isValidContentType);
}

function isBinaryContentType(ct: string): boolean {
  return BINARY_MEDIA_PATTERNS.some(pattern => {
    if (pattern.endsWith('/')) {
      return ct.startsWith(pattern);
    }
    return ct === pattern;
  });
}

/** Valid content type: must match "type/subtype" pattern, no wildcards. */
const VALID_CONTENT_TYPE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-.^_+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-.^_+]*$/;

/** IANA top-level media types. Used to detect swapped type/subtype (e.g. "plain/text"). */
const IANA_TOP_LEVEL_TYPES = new Set([
  'application', 'audio', 'font', 'image', 'message', 'model', 'multipart', 'text', 'video',
]);

function isValidContentType(ct: string): boolean {
  if (!ct || ct === '*/*') return false;
  return VALID_CONTENT_TYPE.test(ct);
}

/** Common content-type typo corrections. */
const CONTENT_TYPE_TYPOS: Record<string, string> = {
  'applcation': 'application',
  'aplication': 'application',
  'applicaton': 'application',
  'applicaiton': 'application',
  'octet-steam': 'octet-stream',
};

/** Fix swapped type/subtype (e.g. "plain/text" becomes "text/plain") and common typos. */
function fixContentType(ct: string): string {
  // Strip parameters (e.g. "; charset=utf-8") before inspecting type/subtype
  const bare = ct.split(';')[0].trim();

  // Fix common typos in the type portion
  const slashIdx = bare.indexOf('/');
  if (slashIdx > 0) {
    const typePart = bare.substring(0, slashIdx);
    const subtype = bare.substring(slashIdx + 1);
    const fixedType = CONTENT_TYPE_TYPOS[typePart] ?? typePart;
    const fixedSubtype = CONTENT_TYPE_TYPOS[subtype] ?? subtype;
    if (fixedType !== typePart || fixedSubtype !== subtype) {
      return `${fixedType}/${fixedSubtype}`;
    }
  }

  // Fix swapped type/subtype
  const parts = bare.split('/');
  if (parts.length === 2 && !IANA_TOP_LEVEL_TYPES.has(parts[0]) && IANA_TOP_LEVEL_TYPES.has(parts[1])) {
    return `${parts[1]}/${parts[0]}`;
  }
  return ct;
}

/**
 * Remove invalid content type keys and null-valued entries from response/request content maps.
 */
function cleanContentMap(content: Record<string, any>, diag?: Diagnostics, path?: string): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [ct, val] of Object.entries(content)) {
    const fixed = fixContentType(ct);
    if (fixed !== ct && diag && path) {
      diag.info('mock-integrations', path, 'content-type-typo', 'converted',
        `Fixed content type typo: '${ct}' → '${fixed}'`);
    }
    if (isValidContentType(fixed) && val !== null) {
      cleaned[fixed] = val;
    }
  }
  return cleaned;
}
