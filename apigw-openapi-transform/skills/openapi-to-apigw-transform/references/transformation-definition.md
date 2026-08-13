# OpenAPI to API Gateway Transformation Definition

> The transformation rules implemented by the `openapi-to-apigw` CLI tool bundled with this skill at `tools/openapi-to-apigw/`.

## Objective

Transform OpenAPI specification files into deployable AWS API Gateway REST APIs using AWS SAM with DefinitionUri. The bundled CLI tool handles spec cleaning, extension injection, SAM template generation, and validation. This skill orchestrates the end-to-end workflow: transform, deploy via SAM, verify, and E2E test.

## CLI Tool

The transformation is performed by the `openapi-to-apigw` TypeScript CLI bundled in `tools/openapi-to-apigw/`, relative to this skill's directory. Build and run:

```bash
TOOL_DIR="<skill-dir>/tools/openapi-to-apigw"
cd "$TOOL_DIR" && npm install && npm run build
npx --prefix "$TOOL_DIR" openapi-to-apigw transform <input> --output-dir <dir> --region <region> --verbose
```

### CLI Outputs

Per spec, the tool generates:
- `{name}-cleaned.yaml` — API Gateway-compatible OpenAPI spec
- `{name}.sam.yaml` — SAM template with DefinitionUri, Lambda authorizers (Deployment and Stage auto-created by SAM)
- `deploy.sh` — SAM deploy script (uses `sam deploy --resolve-s3`)
- `source-analysis.json` — Pre-transform metadata (fileName, openapiVersion, pathCount, operationCount, schemaCount, securitySchemes, serverUrls, needsSwagger2Upgrade, needs31Downgrade)
- `validation-summary.json` — Pre-deployment completeness checks
- `diagnostics.json` — Every transformation logged (level/rule/path/feature/action/message)

## Entry Criteria

1. Input files are valid OpenAPI/Swagger documents (Swagger 2.0, OpenAPI 3.0.x, or 3.1.x) in YAML or JSON.
2. Each file contains at least a paths or components field.
3. Files are parseable with a valid openapi or swagger version field.
4. Internal $ref references resolve within the file, or referenced files are provided.
5. Original input files are READ-ONLY — never delete, overwrite, or modify them.

## Transformation Pipeline (handled by CLI)

The CLI runs these transforms in order:

1. **Swagger 2.0 upconversion** — definitions→components/schemas, securityDefinitions→securitySchemes, host/basePath/schemes→servers
2. **OpenAPI 3.1 downgrade** — $dynamicRef→$ref, remove $dynamicAnchor; type arrays→nullable:true or oneOf; remove webhooks/jsonSchemaDialect/contentEncoding/contentMediaType; convert const to single-value enum
3. **JSON Schema Draft 4 cleanup** — remove discriminator, nullable, example, examples, deprecated, readOnly, default, exclusiveMinimum, format:decimal; convert Int32/Int64
4. **Sanitize names** — alphanumeric-only schema names with collision avoidance, update all $ref references
5. **Parameter cleanup** — keep name/in/required/type/description/schema/$ref; remove style/explode/allowReserved/allowEmptyValue/content; remove cookie params entirely
6. **Extension cleanup** — remove unsupported x-*; retain x-amazon-apigateway-*; convert x-* enum arrays to JSON Schema enum (within schema contexts, when no existing enum is defined)
7. **Server base paths** — extract path from servers[0].url, prepend to all paths
8. **Inline response refs** — resolve root-level $ref responses
9. **Security schemes** — http/bearer→Lambda token authorizer, oauth2→Lambda token authorizer, openIdConnect→token authorizer, apiKey with in:header/name:x-api-key→native API Gateway key (no authorizer needed), apiKey with non-standard location→flagged for manual config, http/basic→request authorizer. NEVER downgrades JWT/OAuth2/OIDC to API keys
10. **Mock integrations** — x-amazon-apigateway-integration (type:mock) on every operation with content-type-aware templates
11. **Request validation** — x-amazon-apigateway-request-validators at API level
12. **Response headers** — read-only verification pass logging that x-* named response headers survived previous transforms (does not modify the spec)

## Exit Criteria

All must pass before the transformation is considered complete:

1. SAM templates are valid YAML, pass cfn-lint with zero errors
2. All stacks reach CREATE_COMPLETE via real deployment
3. Path counts match: source paths == cleaned spec paths
4. Operation counts match exactly
5. Schema counts match exactly (zero models from a spec with schemas = FAIL)
6. Security schemes mapped to x-amazon-apigateway-authorizer; no downgrades to API keys
7. No unsupported OpenAPI features remain (no discriminator, nullable, example, readOnly, default, decimal, Int32/Int64 on numbers)
8. Path segments use only allowed characters; path params in separate segments
9. REST API type (not HTTP API, not WebSocket)
10. Every operation has x-amazon-apigateway-integration
11. Operation-level security defined where required; root-level security propagated
12. Output directory preserved; previous directories not overwritten
13. Original input files unmodified
14. Server base paths prepended to cleaned spec paths
15. Response headers preserved from source spec
16. Non-JSON content types preserved in cleaned spec and integration templates
17. Non-standard apiKey schemes flagged with warning in validation summary
18. Validation summary includes completeness table (file, expected/actual paths, ops, schemas, pass/fail)
19. Post-deployment resource/model counts match source (models >= schemas due to auto-created Empty/Error)
