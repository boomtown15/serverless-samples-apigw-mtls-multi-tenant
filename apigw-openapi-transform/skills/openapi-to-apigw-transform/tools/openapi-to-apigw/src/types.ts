/** Structural OpenAPI document — covers Swagger 2.0 through OpenAPI 3.1. */
export interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info?: Record<string, any>;
  paths?: Record<string, Record<string, any> | null>;
  components?: {
    schemas?: Record<string, any>;
    securitySchemes?: Record<string, any>;
    parameters?: Record<string, any>;
    responses?: Record<string, any>;
  };
  servers?: Array<{ url: string; [k: string]: any }>;
  security?: Array<Record<string, string[]>>;
  host?: string;
  basePath?: string;
  schemes?: string[];
  produces?: string[];
  consumes?: string[];
  definitions?: Record<string, any>;
  securityDefinitions?: Record<string, any>;
  parameters?: Record<string, any>;
  responses?: Record<string, any>;
  tags?: any[];
  externalDocs?: Record<string, any>;
  webhooks?: Record<string, any>;
  [key: string]: any;
}

export interface SourceAnalysis {
  readonly fileName: string;
  readonly openapiVersion: string;
  readonly pathCount: number;
  readonly operationCount: number;
  readonly schemaCount: number;
  readonly securitySchemes: readonly SecuritySchemeInfo[];
  readonly serverUrls: readonly string[];
  readonly needsSwagger2Upgrade: boolean;
  readonly needs31Downgrade: boolean;
}

export type SecuritySchemeType = 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'unknown';

export interface SecuritySchemeInfo {
  name: string;
  type: SecuritySchemeType;
  scheme?: string;     // bearer | basic (for type=http)
  in?: string;         // header | query | cookie
  paramName?: string;  // the "name" field for apiKey
  flows?: string[];    // oauth2 flow names
  openIdConnectUrl?: string;
  explicitCustomAuthtype?: boolean; // x-amazon-apigateway-authtype: custom
}

export interface ValidationResult {
  file: string;
  checks: ValidationCheck[];
  pass: boolean;
}

export interface ValidationCheck {
  name: string;
  expected: number | string | boolean;
  actual: number | string | boolean;
  pass: boolean;
}

export interface TransformOptions {
  region?: string;
  stage?: string;
  format?: 'yaml' | 'json';
  runtime?: string;
  outputDir?: string;
  verbose?: boolean;
  /**
   * Optional prefix prepended to every CloudFormation stack name in the
   * generated deploy.sh (e.g. `gapscanv3` produces stack names like
   * `gapscanv3-<baseStackName>`). Empty string (default) preserves the
   * existing behaviour where stacks are named from the template filename.
   * Can be overridden at deploy time by setting the STACK_PREFIX env var.
   */
  stackPrefix?: string;
}

/** Return a fully-populated options object with defaults applied. */
export function resolveOptions(opts: TransformOptions): Required<TransformOptions> {
  return {
    region: opts.region ?? 'us-east-1',
    stage: opts.stage ?? 'test',
    format: opts.format ?? 'yaml',
    runtime: opts.runtime ?? 'python3.12',
    outputDir: opts.outputDir ?? '.',
    verbose: opts.verbose ?? false,
    stackPrefix: opts.stackPrefix ?? '',
  };
}

export interface DiagnosticEntry {
  level: 'info' | 'warning' | 'breaking' | 'error';
  rule: string;
  path: string;
  feature: string;
  action: 'removed' | 'converted' | 'renamed' | 'skipped' | 'flagged';
  message: string;
  original?: unknown;
}

/** Runtime context passed to transforms. */
export interface TransformContext {
  /** Absolute filesystem path of the source OpenAPI file currently being processed. */
  sourceFilePath?: string;
}

export type TransformFn = (spec: OpenAPISpec, diag: Diagnostics, context?: TransformContext) => OpenAPISpec;

export interface Diagnostics {
  entries: DiagnosticEntry[];
  log(entry: Omit<DiagnosticEntry, 'level'> & { level?: DiagnosticEntry['level'] }): void;
  info(rule: string, path: string, feature: string, action: DiagnosticEntry['action'], message: string, original?: unknown): void;
  warn(rule: string, path: string, feature: string, action: DiagnosticEntry['action'], message: string, original?: unknown): void;
  breaking(rule: string, path: string, feature: string, action: DiagnosticEntry['action'], message: string, original?: unknown): void;
  error(rule: string, path: string, feature: string, action: DiagnosticEntry['action'], message: string, original?: unknown): void;
}

/** HTTP methods that represent operations in OpenAPI. */
export const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'] as const;
export type HttpMethod = typeof HTTP_METHODS[number];

/** Whether a security scheme type requires a Lambda authorizer (vs native API key). */
export function needsLambdaAuthorizer(s: Pick<SecuritySchemeInfo, 'type' | 'scheme' | 'in' | 'paramName' | 'explicitCustomAuthtype'>): boolean {
  return s.type === 'oauth2' ||
    s.type === 'openIdConnect' ||
    (s.type === 'http' && (s.scheme === 'bearer' || s.scheme === 'basic')) ||
    (s.type === 'apiKey' && (!isNativeApiKeyScheme({ type: s.type, in: s.in, name: s.paramName }) || !!s.explicitCustomAuthtype));
}

/** Whether a security scheme is the native API Gateway x-api-key header (no authorizer needed). */
export function isNativeApiKeyScheme(s: { type?: string; in?: string; name?: string }): boolean {
  return s.type === 'apiKey' && s.in === 'header' && s.name?.toLowerCase() === 'x-api-key';
}
