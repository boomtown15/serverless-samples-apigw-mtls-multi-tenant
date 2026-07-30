import type { OpenAPISpec, Diagnostics } from '../types.js';

const RULE = 'openapi31-downgrade';

/**
 * JSON Schema 2020-12 / OpenAPI 3.1-only keywords that API Gateway cannot parse.
 * These must be removed when downgrading to OpenAPI 3.0.0.
 */
const SCHEMA_31_ONLY_KEYWORDS = [
  'propertyNames',    // JSON Schema: constrains property key names
  'prefixItems',      // JSON Schema 2020-12: replaces 'items' as tuple
  '$vocabulary',      // JSON Schema 2020-12: meta-schema vocabulary
  '$comment',         // JSON Schema 2019-09+: annotation keyword
  'unevaluatedProperties',  // JSON Schema 2019-09+
  'unevaluatedItems',       // JSON Schema 2019-09+
  'dependentRequired',      // JSON Schema 2019-09+ (replaces 'dependencies')
  'dependentSchemas',       // JSON Schema 2019-09+
] as const;

/**
 * Downgrade OpenAPI 3.1.x to 3.0.0.
 * If the spec is not 3.1.x, return it unchanged.
 */
export function openapi31Downgrade(spec: OpenAPISpec, diag: Diagnostics): OpenAPISpec {
  const version = spec.openapi ?? '';
  if (!version.startsWith('3.1')) {
    return spec;
  }

  diag.info(RULE, '#/openapi', 'openapi-3.1', 'converted',
    `Downgrading OpenAPI ${version} to 3.0.0`);

  const result = structuredClone(spec);
  result.openapi = '3.0.0';

  // Detect webhooks-only specs before stripping: if paths is empty/absent AND
  // webhooks is present, the deployed API will have zero operations — emit a
  // breaking diagnostic so `--fail-on breaking` stops the deploy with a clear
  // message instead of CloudFormation's opaque "REST API doesn't contain any
  // methods" failure.
  const pathCount = result.paths ? Object.keys(result.paths).length : 0;
  if (pathCount === 0 && result.webhooks !== undefined) {
    diag.breaking(RULE, '#/webhooks', 'no-deployable-paths-webhooks-only', 'flagged',
      `API Gateway does not support OpenAPI 3.1 webhooks; source spec has no deployable paths.`);
  }

  // Remove 3.1-only root fields
  for (const field of ['webhooks', 'jsonSchemaDialect']) {
    if (result[field] !== undefined) {
      diag.info(RULE, `#/${field}`, field, 'removed',
        `Removed 3.1-only field '${field}'`, result[field]);
      delete result[field];
    }
  }

  // Promote nested definitions to top-level schemas BEFORE walking
  // (walkAndDowngrade deletes inline definitions blocks)
  promoteNestedDefinitions(result, diag);

  // Walk entire spec and downgrade schema-level constructs
  walkAndDowngrade(result, '#', diag);

  return result;
}

function walkAndDowngrade(obj: any, path: string, diag: Diagnostics): void {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkAndDowngrade(obj[i], `${path}/${i}`, diag);
    }
    return;
  }

  // $dynamicRef → $ref
  if (obj.$dynamicRef) {
    diag.info(RULE, path, '$dynamicRef', 'converted',
      `Converted $dynamicRef to $ref`, obj.$dynamicRef);
    obj.$ref = obj.$dynamicRef;
    delete obj.$dynamicRef;
  }
  if (obj.$dynamicAnchor !== undefined) {
    diag.info(RULE, path, '$dynamicAnchor', 'removed',
      `Removed $dynamicAnchor`, obj.$dynamicAnchor);
    delete obj.$dynamicAnchor;
  }

  // Type arrays → single type + nullable
  if (Array.isArray(obj.type)) {
    const types = obj.type as string[];
    const hasNull = types.includes('null');
    const nonNull = types.filter((t: string) => t !== 'null');

    if (nonNull.length === 1) {
      obj.type = nonNull[0];
      if (hasNull) {
        obj.nullable = true;
      }
      diag.info(RULE, path, 'type-array', 'converted',
        `Converted type array ${JSON.stringify(types)} to type="${obj.type}"${hasNull ? ' + nullable' : ''}`);
    } else if (nonNull.length > 1) {
      // Multiple non-null types → use oneOf
      obj.oneOf = nonNull.map((t: string) => ({ type: t }));
      if (hasNull) obj.nullable = true;
      delete obj.type;
      diag.info(RULE, path, 'type-array', 'converted',
        `Converted multi-type array to oneOf`, types);
    }
  }

  // Fix oneOf/anyOf with sibling type: "null" — move null into nullable
  if ((obj.oneOf || obj.anyOf) && obj.type === 'null') {
    obj.nullable = true;
    delete obj.type;
    diag.info(RULE, path, 'null-type-sibling', 'converted',
      `Moved sibling type:"null" to nullable:true (invalid as sibling of oneOf/anyOf)`);
  }

  // const → single-value enum
  if (obj.const !== undefined) {
    diag.info(RULE, path, 'const', 'converted',
      `Converted const to single-value enum`, obj.const);
    obj.enum = [obj.const];
    delete obj.const;
  }

  // Remove 3.1-only schema fields that API Gateway / OpenAPI 3.0 do not support
  for (const field of ['contentEncoding', 'contentMediaType']) {
    if (obj[field] !== undefined) {
      diag.info(RULE, path, field, 'removed',
        `Removed 3.1-only schema field '${field}'`, obj[field]);
      delete obj[field];
    }
  }

  // Remove 3.1-only JSON Schema keywords that cause API Gateway import errors.
  // These keywords are valid in JSON Schema 2020-12 (used by OAS 3.1) but not
  // in the JSON Schema draft-07 subset (used by OAS 3.0 / API Gateway).
  for (const field of SCHEMA_31_ONLY_KEYWORDS) {
    if (obj[field] !== undefined) {
      diag.warn(RULE, path, field, 'removed',
        `Removed OpenAPI 3.1-only keyword '${field}' (not supported by API Gateway / OpenAPI 3.0)`, obj[field]);
      delete obj[field];
    }
  }

  // Remove inline 'definitions' inside schemas (3.1 / JSON Schema 2020-12 feature,
  // not supported at schema level in OAS 3.0)
  if (obj.definitions !== undefined && path.includes('/schemas/')) {
    diag.warn(RULE, path, 'definitions', 'removed',
      `Removed inline 'definitions' block (JSON Schema 2020-12 feature, not supported in OAS 3.0 schemas)`, obj.definitions);
    delete obj.definitions;
  }

  // Strip null from enum arrays (CloudFormation/API Gateway reject null values)
  if (Array.isArray(obj.enum)) {
    const hasNull = obj.enum.some((v: unknown) => v === null);
    if (hasNull) {
      obj.enum = obj.enum.filter((v: unknown) => v !== null);
      obj.nullable = true;
      diag.info(RULE, path, 'enum-null', 'converted',
        `Stripped null from enum and set nullable (CloudFormation rejects null in templates)`);
      if (obj.enum.length === 0) delete obj.enum;
    }
  }

  // Recurse into sub-objects
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref') continue;
    walkAndDowngrade(value, `${path}/${key}`, diag);
  }
}

/**
 * Promote nested `definitions` and `properties` sub-schema references to top-level schemas.
 *
 * JSON Schema 2020-12 allows inline `definitions` inside a schema (e.g.
 * `#/components/schemas/Parent/definitions/Child`). API Gateway requires all
 * `$ref` to point to canonical top-level locations (`#/components/schemas/X`).
 *
 * Also handles `$ref` pointing into `properties` of another schema (e.g.
 * `#/components/schemas/Parent/properties/fieldName`).
 */
function promoteNestedDefinitions(spec: OpenAPISpec, diag: Diagnostics): void {
  const schemas = spec.components?.schemas;
  if (!schemas) return;

  const promoted = new Map<string, { schema: any; oldRef: string }>();

  // Pass 1: collect nested definitions and property refs
  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== 'object') continue;
    const s = schema as Record<string, any>;

    // Promote inline definitions
    if (s.definitions && typeof s.definitions === 'object') {
      for (const [defName, defSchema] of Object.entries(s.definitions)) {
        const newName = `${schemaName}_${defName}`;
        const oldRef = `#/components/schemas/${schemaName}/definitions/${defName}`;
        promoted.set(newName, { schema: defSchema, oldRef });
      }
    }
  }

  // Also scan for $ref pointing to .../properties/... and promote those
  const propertyRefs = new Set<string>();
  walkRefs(spec, record => { propertyRefs.add(record.$ref); });
  for (const ref of propertyRefs) {
    const propsMatch = ref.match(/^#\/components\/schemas\/([^/]+)\/properties\/([^/]+)$/);
    if (!propsMatch) continue;
    const [, parentName, propName] = propsMatch;
    const parent = schemas[parentName] as Record<string, any> | undefined;
    if (!parent?.properties?.[propName]) continue;
    const newName = `${parentName}_${propName}`;
    if (!promoted.has(newName)) {
      promoted.set(newName, { schema: structuredClone(parent.properties[propName]), oldRef: ref });
    }
  }

  if (promoted.size === 0) return;

  // Build ref rewrite map and add promoted schemas to top level
  const refMap = new Map<string, string>();
  for (const [newName, { schema: promotedSchema, oldRef }] of promoted) {
    if (schemas[newName] !== undefined) {
      diag.warn(RULE, `#/components/schemas/${newName}`, 'promoted-definition', 'skipped',
        `Cannot promote '${oldRef}' — schema '${newName}' already exists`);
      continue;
    }
    schemas[newName] = promotedSchema;
    const newRef = `#/components/schemas/${newName}`;
    refMap.set(oldRef, newRef);
    diag.info(RULE, newRef, 'promoted-definition', 'converted',
      `Promoted nested schema '${oldRef}' to top-level '${newRef}'`);
  }

  // Single walk to rewrite matching $ref values + warn on remaining nested refs
  walkRefs(spec, record => {
    const mapped = refMap.get(record.$ref);
    if (mapped) {
      record.$ref = mapped;
    } else if (typeof record.$ref === 'string' && record.$ref.startsWith('#/components/schemas/')) {
      const segments = record.$ref.replace('#/components/schemas/', '').split('/');
      if (segments.length > 1) {
        diag.warn(RULE, record.$ref, 'unresolved-nested-ref', 'flagged',
          `$ref '${record.$ref}' points to a nested path that could not be promoted — manual remediation required`);
      }
    }
  });
}

/** Walk all objects in the tree, calling visitor on each object node that has a $ref. */
function walkRefs(obj: unknown, visitor: (record: Record<string, any>) => void, visited = new WeakSet<object>()): void {
  if (!obj || typeof obj !== 'object') return;
  if (visited.has(obj as object)) return;
  visited.add(obj as object);
  if (Array.isArray(obj)) {
    for (const item of obj) walkRefs(item, visitor, visited);
    return;
  }
  const record = obj as Record<string, any>;
  if (typeof record.$ref === 'string') visitor(record);
  for (const value of Object.values(record)) {
    walkRefs(value, visitor, visited);
  }
}
