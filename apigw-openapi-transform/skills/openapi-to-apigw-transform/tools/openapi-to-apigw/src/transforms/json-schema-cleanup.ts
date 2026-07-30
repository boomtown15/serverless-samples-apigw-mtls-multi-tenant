import type { OpenAPISpec, Diagnostics } from '../types.js';

const RULE = 'json-schema-cleanup';

/** Fields that API Gateway does not support in schemas. */
const UNSUPPORTED_SCHEMA_FIELDS = [
  'discriminator', 'nullable', 'example', 'examples',
  'deprecated', 'readOnly', 'default', 'exclusiveMinimum',
] as const;

/** Composition keywords whose $ref entries must be inlined for API Gateway. */
const COMPOSITION_KEYWORDS = ['oneOf', 'anyOf', 'allOf'] as const;

/** Standard JSON Schema format values accepted by API Gateway. */
const STANDARD_FORMATS = new Set([
  'int32', 'int64', 'float', 'double', 'byte', 'binary',
  'date', 'date-time', 'password', 'email', 'uri', 'uuid', 'hostname',
  'ipv4', 'ipv6',
]);

/**
 * Clean JSON Schema constructs that API Gateway does not support.
 * - Remove unsupported fields (discriminator, nullable, example, etc.)
 * - Fix number formats (Int32/Int64 → integer, decimal → remove)
 * - Inline $ref inside oneOf/anyOf/allOf (API Gateway rejects ComposedSchema with $ref)
 * - Wrap primitive response schema types in object refs
 */
export function jsonSchemaCleanup(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const result = structuredClone(spec);
  const schemas = result.components?.schemas ?? result.definitions ?? {};

  // Collect wrapper schemas we need to create
  const wrapperSchemas = new Map<string, string>(); // type → wrapperName

  // Walk all schemas and clean
  walkAndClean(result, '#', diag, false, schemas);

  // Walk responses specifically to fix primitive types
  fixPrimitiveResponses(result, diag, wrapperSchemas);

  // Add any wrapper schemas to components
  if (wrapperSchemas.size > 0) {
    if (!result.components) result.components = {};
    if (!result.components.schemas) result.components.schemas = {};
    for (const [type, name] of wrapperSchemas) {
      result.components.schemas[name] = { type };
      diag.info(RULE, `#/components/schemas/${name}`, 'primitive-response-type', 'converted',
        `Created wrapper schema '${name}' for primitive type '${type}'`);
    }
  }

  return result;
}

function walkAndClean(
  obj: any, path: string, diag: Diagnostics, inIntegration: boolean,
  schemas: Record<string, any>,
): void {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkAndClean(obj[i], `${path}/${i}`, diag, inIntegration, schemas);
    }
    return;
  }

  // Detect if we're inside an x-amazon-apigateway-integration block
  const isIntegration = inIntegration || path.includes('x-amazon-apigateway-integration');

  // Skip stripping at the schema container level where keys are schema names, not keywords
  const isSchemaContainer = path === '#/components/schemas' || path === '#/definitions';
  if (!isSchemaContainer) {
    for (const field of UNSUPPORTED_SCHEMA_FIELDS) {
      if (obj[field] === undefined) continue;
      if (field === 'default' && (isIntegration || path.endsWith('/responses'))) continue;

      diag.info(RULE, path, field, 'removed',
        `Removed unsupported field '${field}'`, obj[field]);
      delete obj[field];
    }
  }

  // Flatten oneOf/anyOf/allOf in top-level response schemas only.
  // API Gateway rejects ComposedSchema (with $ref) in response models but allows
  // them in components/schemas definitions. The $ anchor ensures we only match the
  // schema node itself, not nested properties within it.
  const isTopLevelResponseSchema = /\/responses\/[^/]+\/content\/[^/]+\/[^/]+\/schema$/.test(path);
  if (isTopLevelResponseSchema) {
    for (const kw of COMPOSITION_KEYWORDS) {
      if (!Array.isArray(obj[kw])) continue;

      obj[kw] = obj[kw].map((entry: any) => {
        if (!entry?.$ref || typeof entry.$ref !== 'string') return entry;
        const resolved = resolveSchemaRef(entry.$ref, schemas);
        if (!resolved) {
          diag.warn(RULE, path, `unresolved-${kw}-ref`, 'flagged',
            `Could not resolve $ref '${entry.$ref}' in ${kw}; keeping as-is`);
          return entry;
        }
        try {
          return structuredClone(resolved);
        } catch {
          diag.warn(RULE, path, `composed-schema-clone`, 'flagged',
            `Could not clone $ref '${entry.$ref}' (possible circular reference); keeping $ref`);
          return entry;
        }
      });

      if (kw === 'allOf') {
        flattenAllOf(obj);
      } else {
        flattenFirstSchema(obj, kw);
      }

      diag.info(RULE, path, `composed-schema-${kw}`, 'converted',
        `Flattened ${kw} in response model (API Gateway does not support ComposedSchema with $ref in responses)`);
    }
  }

  // Fix format: decimal
  if (obj.format === 'decimal') {
    diag.info(RULE, path, 'format:decimal', 'removed',
      'Removed unsupported format "decimal"', 'decimal');
    delete obj.format;
  }

  // Remove non-standard format values (API Gateway only accepts standard JSON Schema formats)
  if (obj.format && typeof obj.format === 'string' && !STANDARD_FORMATS.has(obj.format)) {
    diag.info(RULE, path, `format:${obj.format}`, 'removed',
      `Removed non-standard format '${obj.format}' (not supported by API Gateway)`);
    delete obj.format;
  }

  // Deduplicate enum values (API Gateway rejects duplicate enum entries)
  if (Array.isArray(obj.enum) && obj.enum.length > 0) {
    const seen = new Set<string>();
    const unique = obj.enum.filter((v: unknown) => {
      const key = JSON.stringify(v);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length < obj.enum.length) {
      const removed = obj.enum.length - unique.length;
      diag.info(RULE, path, 'duplicate-enum', 'removed',
        `Removed ${removed} duplicate enum value(s)`);
      obj.enum = unique;
    }
  }

  // Fix Int32/Int64 on type:number → type:integer
  if (obj.type === 'number' && (obj.format === 'int32' || obj.format === 'int64')) {
    diag.info(RULE, path, `format:${obj.format}`, 'converted',
      `Converted type:number with format:${obj.format} to type:integer`);
    obj.type = 'integer';
  }

  // Sanitise '*/' in description / title (APIGW rejects it in description fields).
  for (const key of ['description', 'title'] as const) {
    if (typeof obj[key] === 'string' && obj[key].includes('*/')) {
      const before = obj[key];
      obj[key] = before.replace(/\*\//g, '* /');
      diag.info(RULE, `${path}/${key}`, `literal-comment-end-in-${key}`, 'converted',
        `Rewrote '*/' to '* /' in '${key}' field (API Gateway rejects '*/' in descriptions)`, before);
    }
  }

  // Warn on '*/' in other string fields (pattern, example, etc.) without modifying them.
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'description' || k === 'title') continue;
    if (typeof v !== 'string') continue;
    if (!v.includes('*/')) continue;
    diag.warn(RULE, `${path}/${k}`, 'literal-comment-end-in-other-field', 'flagged',
      `String field '${k}' contains '*/' which may be rejected by API Gateway; not auto-rewritten`, v);
  }

  // Recurse
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref') continue;
    walkAndClean(value, `${path}/${key}`, diag,
      isIntegration || key === 'x-amazon-apigateway-integration', schemas);
  }
}

function resolveSchemaRef(ref: string, schemas: Record<string, any>): Record<string, any> | null {
  const match = ref.match(/^#\/(?:components\/schemas|definitions)\/([^/]+)$/);
  if (match) {
    return schemas[match[1]] ?? null;
  }
  return null;
}

/** Merge allOf sub-schemas into a single schema, then remove the allOf keyword. */
function flattenAllOf(obj: Record<string, any>): void {
  const merged: Record<string, any> = {};
  const mergedProps: Record<string, any> = {};
  const mergedRequired: string[] = [];
  for (const sub of obj.allOf) {
    if (sub.type && !merged.type) merged.type = sub.type;
    if (sub.properties) Object.assign(mergedProps, sub.properties);
    if (sub.items && !merged.items) merged.items = sub.items;
    if (Array.isArray(sub.required)) mergedRequired.push(...sub.required);
    if (sub.description && !merged.description) merged.description = sub.description;
    if (sub.title && !merged.title) merged.title = sub.title;
    if (sub.additionalProperties !== undefined) {
      if (merged.additionalProperties === undefined || sub.additionalProperties === false) {
        merged.additionalProperties = sub.additionalProperties;
      }
    }
  }
  if (!merged.type) merged.type = 'object';
  if (Object.keys(mergedProps).length > 0) merged.properties = mergedProps;
  if (mergedRequired.length > 0) merged.required = [...new Set(mergedRequired)];
  delete obj.allOf;
  Object.assign(obj, merged);
}

/** Replace a oneOf/anyOf keyword with its first sub-schema. */
function flattenFirstSchema(obj: Record<string, any>, keyword: string): void {
  const first = obj[keyword]?.[0];
  if (first && typeof first === 'object') {
    delete obj[keyword];
    Object.assign(obj, first);
  }
}

function fixPrimitiveResponses(
  spec: OpenAPISpec,
  diag: Diagnostics,
  wrapperSchemas: Map<string, string>,
): void {
  const paths = spec.paths ?? {};
  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, op] of Object.entries(pathItem as Record<string, any>)) {
      if (!op?.responses || typeof op.responses !== 'object') continue;
      for (const [code, resp] of Object.entries(op.responses as Record<string, any>)) {
        if (!resp?.content) continue;
        for (const [mediaType, content] of Object.entries(resp.content as Record<string, any>)) {
          if (!content?.schema) continue;
          const schema = content.schema;
          const primitiveType = schema.type;
          if (primitiveType && typeof primitiveType === 'string' &&
              ['string', 'integer', 'number', 'boolean'].includes(primitiveType) &&
              !schema.$ref) {
            // Wrap in a ref
            const wrapperName = `${capitalize(primitiveType)}Response`;
            wrapperSchemas.set(primitiveType, wrapperName);
            content.schema = { $ref: `#/components/schemas/${wrapperName}` };
            diag.info(RULE, `${pathStr}/${method}/responses/${code}/content/${mediaType}/schema`,
              'primitive-response-type', 'converted',
              `Wrapped primitive response type '${primitiveType}' with $ref to '${wrapperName}'`);
          }
        }
      }
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
