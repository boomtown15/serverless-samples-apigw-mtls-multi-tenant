# Learnings — OpenAPI to API Gateway Migration

Accumulated across multiple transformation runs against public OpenAPI examples. This file records
*why* the transformation works the way it does, so the design isn't re-litigated and the same dead
ends aren't retried.

## Architecture Decision: BodyS3Location vs Discrete CFN Resources

The first approach generated individual CloudFormation resources (AWS::ApiGateway::Resource, Method, Model) for every path, operation, and schema. This caused:

- 17,000+ line templates for large APIs (account-info with 242 schemas)
- API Gateway control plane rate limiting (HTTP 429) during stack creation when many models were created concurrently
- Required synthetic DependsOn chains to batch model creation into groups of 5
- Canonical model $ref format (`https://apigateway.amazonaws.com/restapis/{id}/models/{name}`) was fragile — one wrong reference and the whole stack failed
- The agent silently dropped schemas when it hit context limits — 96.3% of schemas were lost in one run (341 of 354)

Switching to BodyS3Location eliminated all of these. The cleaned spec is uploaded to S3 as a single file and API Gateway creates all resources internally in one API call. Templates went from 17K lines to ~100 lines. Zero rate limiting. Zero schema loss.

A further simplification was made by migrating from raw CloudFormation with BodyS3Location to AWS SAM with `DefinitionUri`. SAM packages the local cleaned spec to S3 automatically via `--resolve-s3`, eliminating manual S3 bucket creation and upload. `AWS::Serverless::Api` also auto-creates Deployment and Stage resources, and `AWS::Serverless::Function` auto-creates the Lambda execution role.

## Agent Behavioral Patterns

### Retry loops without fixing the root cause
The agent deployed the same failing template 5 times for a large API with 50 models, escalating sleep timers (60s → 120s → 180s) but never modifying the template. It had already solved the same problem (DependsOn batching) for a different stack one step earlier but didn't apply the lesson. Fix: the skill now requires root-cause analysis before any retry (see the Failure Handling section of `SKILL.md`).

### Validation phase expanding indefinitely
The agent would re-run validation checks that already passed, spending 20-40 minutes on validation after a 15-minute deployment. Root causes: inline Python in shell commands causing IndentationErrors (triggering retry loops), and no clear "stop checking" signal. Fixes: added "NEVER write Python as inline shell commands" rule and a 5-minute validation time cap.

### Conversation history overriding instructions
When resuming a conversation, the agent's 80K+ lines of history about discrete CFN resources overwhelmed the updated instructions for BodyS3Location — it kept regenerating the old plan from memory even after the stale plan file was deleted. Fix: start a fresh session for fundamental architecture changes rather than trying to correct an existing one.

### Analysis phase over-reading source specs
The agent would read every spec line-by-line during planning, spending 30+ minutes before generating a plan. Fix: added "Do NOT read source spec files line-by-line during planning. Use a single Python script to extract metadata programmatically. Spend no more than 5 minutes on analysis." This cut planning from 30+ minutes to 5-7 minutes.

## API Gateway Import Limitations Discovered

### Schema names must be alphanumeric
Some public APIs use underscored schema names (e.g., `Status_Detail_0`, `CurrencyAmount_Type_1`). API Gateway rejects these outright — the entire import fails, not just the offending schema. The CLI renames them and updates all $ref references in a single pass with collision detection.

### OAuth2/JWT security silently dropped on native import
Native `import-rest-api` prints "Unsupported security definition type 'oauth2'. Ignoring." as a warning and deploys the API with zero authentication. For APIs relying on OAuth2, this means unauthenticated access to protected endpoints. The CLI converts these to Lambda authorizers that default to deny-all.

### Lambda authorizer wiring requires SAM Auth + DefinitionBody
`DefinitionUri` uploads the spec to S3 as a static file. CloudFormation does NOT resolve `Fn::Sub` or any intrinsic functions inside it, so `${AuthorizerFunctionArn}` placeholders remain literal strings and API Gateway gets a broken authorizer URI. `AWS::Include` with `DefinitionBody` was tried but fails because (1) `Fn::Sub` nested inside the included content isn't resolved by API Gateway's import, and (2) explicit `AWS::ApiGateway::Authorizer` resources create authorizers but don't bind them to methods. The working solution is: SAM's `Auth.Authorizers` property on `AWS::Serverless::Api` with `DefinitionBody` (inline spec). SAM Auth requires `DefinitionBody`, so `$ref` to `components/parameters` must be inlined beforehand (via `inline-parameter-refs` transform). OAuth2 scopes must also be stripped from security requirements since API Gateway only supports scopes with Cognito authorizers, not Lambda authorizers. For specs without security schemes, `DefinitionUri` is used for simplicity.

### Unified DefinitionUri with two-phase deploy (replaces SAM Auth approach)
DefinitionBody (inline spec) hits CloudFormation's 460KB template size limit for large specs (vercel.com at 800KB, payment-initiation-openapi at 700KB). SAM Auth requires DefinitionBody, creating an inherent conflict. The solution is to always use DefinitionUri with authorizer extensions embedded directly in the spec via x-amazon-apigateway-authorizer. The deploy script uses a two-phase approach: (1) deploy the authorizer Lambda stack, (2) resolve placeholder URIs in the spec with the real Lambda ARN, upload to S3, then deploy the API stack. This single strategy handles all spec sizes and security configurations without hitting CFN limits.

### apiKey in non-standard locations
API Gateway's native API key mechanism only supports the `x-api-key` header. Specs with apiKey in query params (Uber's `server_token`) or custom headers can't use native API keys. The CLI flags these with a warning and recommends manual Lambda authorizer setup post-deployment. Attempting to wire Lambda authorizers for these at deploy time caused circular dependency issues with BodyS3Location (the spec needs the Lambda ARN, but the Lambda doesn't exist until CloudFormation creates it).

### x-amazon-apigateway-authtype without x-amazon-apigateway-authorizer
Setting `x-amazon-apigateway-authtype: custom` on a security scheme without a corresponding `x-amazon-apigateway-authorizer` block causes API Gateway to expect an authorizer that doesn't exist, failing the import. Both must be present together, or both must be absent.

### Response headers in x-* namespace
Response headers named with `x-` prefix (like `x-request-id`, `x-next`) were being stripped by the extension cleanup logic, which treated them as unsupported OpenAPI extensions. Fix: the cleanup must distinguish between x-* extension fields on schema objects and x-* named response headers.

### `default` keyword in integration responses
API Gateway's mock integration uses `responses.default` as a response matcher key. The schema cleanup was flagging this as the unsupported OpenAPI `default` keyword. Fix: only remove `default` from schema contexts, not from integration response definitions.

### API Gateway auto-creates Empty and Error models
Post-deployment model counts are always >= source schema counts because API Gateway automatically creates `Empty` and `Error` models. Validation must use >= comparison, not exact match.

### Content type typos in source specs
Real-world specs contain typos like `applcation/json` (archive.org). API Gateway rejects these as invalid content types. The tool now auto-corrects common misspellings, but unknown typos may slip through. The LLM should review diagnostics for `content-type-typo` entries and grep cleaned specs for suspicious content types.

### Wildcard status codes (5XX, 2XX) rejected by API Gateway
API Gateway REST API import requires specific HTTP status codes — wildcards like `5XX` are not accepted. The tool converts these to specific codes (5XX→500, 4XX→400, etc.). Common in real-world APIs (e.g., listennotes.com uses 5XX on every endpoint).

### Non-standard JSON Schema formats rejected by API Gateway
Custom `format` values like `period`, `string`, `uri-template` cause "Invalid OAS input" errors. API Gateway only accepts standard formats: int32, int64, float, double, byte, binary, date, date-time, password, email, uri, uuid, hostname, ipv4, ipv6. The tool now strips non-standard formats automatically.

### Duplicate enum values rejected by API Gateway
Schemas with duplicate enum entries (e.g., `WEEK` appearing twice in OBFrequency6Code) fail strict validation. The tool now deduplicates enums automatically. This is common in large financial API specs (Open Banking).

### Path segments with special characters
API Gateway rejects paths containing colons (`jcr:content` in adobe.com) or `.json` as part of a path segment (discourse.local). These are spec-level incompatibilities that cannot be auto-fixed — the paths would lose meaning if renamed. The tool flags these in diagnostics.

### Server basepath double-prefixing
When `servers[0].url` is a relative path like `/1`, the basepath extraction must reset the URL to `/` after prepending paths. Otherwise paths get double-prefixed (e.g., `/1/` + `/1/account` = `/1/1/account`).

### oneOf/anyOf with sibling type:"null" (OpenAPI 3.1)
OpenAPI 3.1 allows `type: "null"` as a sibling of `oneOf`/`anyOf`. This is invalid in 3.0 and rejected by API Gateway. The 3.1→3.0 downgrade now converts this to `nullable: true`.

## Prompt Design Learnings

These apply to the instruction set in `SKILL.md` and `references/transformation-definition.md`.

### Conciseness matters
The transformation instructions grew from 14KB to 22KB through iterative improvements. At 22KB, the agent spent more time internalizing instructions than executing them. Rewriting to 9KB (same rules, tighter language) cut planning time from 30+ minutes to 5-7 minutes. This is also why the bulk of the logic lives in a deterministic CLI rather than in prose.

### Efficiency rules at the top
Placing mandatory efficiency rules before the implementation steps ensures the agent sees them first. Key rules: cap the analysis phase, reuse a single module, batch S3 uploads, deploy concurrently, and never write Python as inline shell commands (a frequent source of IndentationError retry loops).

### Generic over specific
Hardcoding vendor-specific extension names (`x-namespaced-enum`) made the instructions less portable. Generalizing to "any `x-*` extension containing an array of allowed values" covers all vendors without naming any.

### Completeness verification is non-negotiable
Without programmatic count verification (paths, operations, schemas), the agent silently dropped 96% of schemas in one run. The verification step must be blocking — no deployment until counts match.

### Swagger 2.0 upconversion simplifies everything
Converting Swagger 2.0 to OpenAPI 3.0 before cleaning means all downstream logic handles one format. Without this, every cleaning step needs dual-format handling (definitions vs components/schemas, produces/consumes vs content types, etc.).
