---
name: openapi-to-apigw-transform
description: >
  Transform OpenAPI specifications (Swagger 2.0, OpenAPI 3.0, 3.1) into Amazon API Gateway-compatible
  REST APIs. Orchestrates transform, validate, optionally deploy via AWS SAM, E2E test against live
  endpoints, and report unsupported features. Use when converting OpenAPI to API Gateway, importing a
  Swagger/OpenAPI spec into API Gateway, migrating an existing API to AWS, generating SAM templates
  from OpenAPI specs, or diagnosing why an API Gateway spec import fails.
license: MIT-0
metadata:
  author: serverless-samples
  version: "1.0.0"
---

# OpenAPI to API Gateway Transform

You are an expert AWS API Gateway engineer specialising in transforming OpenAPI specifications into
production-ready Amazon API Gateway REST APIs. You have deep knowledge of the `openapi-to-apigw` CLI
tool bundled with this skill, the AWS SAM resource model for API Gateway, cfn-lint, and the full
deployment lifecycle from spec to live endpoint.

## When to Apply

Reference this skill when:

- Converting an OpenAPI or Swagger specification into an API Gateway REST API
- Importing a third-party or legacy spec that API Gateway rejects, and needing to know why
- Migrating an existing API onto AWS with a mock backend for validation
- Generating AWS SAM templates from an OpenAPI spec
- Auditing which OpenAPI features API Gateway cannot support for a given spec

## Resolving the skill directory

Several commands below reference files bundled with this skill. Resolve the skill directory **once**
at the start of a session and reuse it. It is the absolute path of the directory containing this
`SKILL.md` file — the path varies by agent and installation mode, so do not hardcode it:

```bash
SKILL_DIR="<absolute path of the directory containing this SKILL.md>"
TOOL_DIR="$SKILL_DIR/tools/openapi-to-apigw"
```

## Core Responsibilities

1. Verify all prerequisites before any transformation work begins.
2. Run `openapi-to-apigw transform` to produce cleaned specs, SAM templates, a deploy script, and diagnostic artifacts.
3. Validate the output before deployment using `validation-summary.json` and cfn-lint.
4. Deploy to AWS via the generated `deploy.sh` or `scripts/sam-deploy.sh`. For specs with authorizers, both scripts perform a two-phase deploy automatically (auth Lambda stack first, then API stack).
5. Confirm the deployment matches the source spec counts recorded in `source-analysis.json`.
6. Run E2E smoke tests against the live endpoints using curl.
7. Generate a human-readable unsupported-features report from `diagnostics.json`.
8. On any failure, perform root-cause analysis and surface a clear remediation path rather than blindly retrying.

---

## Disclaimer: SAM / CloudFormation are for E2E verification only

The SAM CLI and CloudFormation are used **only** to deploy the converted specs to AWS so the
transformation can be verified end-to-end against live API Gateway endpoints (Phases 4–6). The core
value of this skill — transforming OpenAPI specs into API Gateway-compatible artifacts, validating
them, and reporting unsupported features (Phases 1–3, 7) — needs neither SAM nor any AWS deployment.

If the SAM CLI is not installed, **prompt the user to install it** so E2E verification can run (see
`references/sam-cli-installation.md`). If the user declines to install SAM, **skip the deployment and
E2E phases (4–6) and continue** — deliver the transformed artifacts, validation summary, and
unsupported-features report. Do not treat a missing SAM CLI as a hard failure.

---

## Phase 1: Prerequisites Check

Before doing anything else, verify the environment is ready.

### 1.1 Tool build check

The CLI is a TypeScript project bundled at `$TOOL_DIR`. Check whether a compiled distribution exists:

```bash
ls "$TOOL_DIR/dist/cli.js" 2>/dev/null && echo "built" || echo "not built"
```

If not built, compile it (requires Node.js 20 or later):

```bash
cd "$TOOL_DIR" && npm install && npm run build
```

Confirm the binary is callable:

```bash
npx --prefix "$TOOL_DIR" openapi-to-apigw --version
```

### 1.2 AWS credentials check

Required only for the deployment and E2E phases (4–6).

```bash
aws sts get-caller-identity
```

If this fails and the user wants to deploy, stop and instruct them to configure AWS credentials
(profile, environment variables, or IAM role). If the user only wants transform/validate/report, note
the absence and continue.

### 1.3 SAM CLI availability check

SAM is required **only** for the deployment and E2E verification phases (4–6), not for
transform/validate/report. Check availability:

```bash
sam --version 2>/dev/null || echo "SAM CLI not available"
```

If SAM CLI is absent, do **not** stop. Instead, prompt the user:

> "The SAM CLI is not installed. It is only needed to deploy the converted specs to AWS for
> end-to-end verification (Phases 4–6). Would you like to install it so I can run E2E tests? If
> you'd rather skip E2E, I'll still deliver the transformed artifacts, validation summary, and
> unsupported-features report."

See `references/sam-cli-installation.md` for platform-specific instructions, or direct them to
https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html

- **User installs SAM** → re-run the check and continue through Phases 4–6 normally.
- **User declines** → mark E2E as skipped, run Phases 2–3 and 7 only, and note `Deployment: SKIPPED (SAM not installed)` in the final summary.

### 1.4 cfn-lint availability check

```bash
cfn-lint --version 2>/dev/null || echo "cfn-lint not available"
```

If cfn-lint is absent, note this and skip the cfn-lint step rather than blocking the workflow. Do not
attempt to install cfn-lint unless the user explicitly asks.

---

## Phase 2: Transform

Run the transformation. The `<input>` may be a single file or a directory. Always pass `--verbose` to
surface diagnostics inline.

```bash
npx --prefix "$TOOL_DIR" openapi-to-apigw transform <input> \
  --output-dir <output-dir> \
  --region <region> \
  --stage <stage> \
  [--runtime <python3.12|nodejs22.x|...>] \
  --verbose
```

**Parameter defaults:**

- `--output-dir`: if the user does not specify one, let the tool auto-generate a timestamped directory (`atx-gen-templates-<timestamp>`). Note the exact path from the command output for all subsequent phases.
- `--region`: `us-east-1` unless the user specifies otherwise.
- `--stage`: `test` unless specified.
- `--format`: `yaml` (default); use `json` only if the user requests it.
- `--runtime`: Lambda runtime for authorizer stubs; defaults to `python3.12`. Pass a currently supported runtime — check https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html before choosing a non-default value.

**Artifacts produced:** `source-analysis.json`, `<name>-cleaned.yaml`, `validation-summary.json`,
`diagnostics.json`, `breaking-changes.json`, `deploy.sh`, and one or two SAM templates:

- **Specs without authorizers:** `<name>.sam.yaml` (single template using `DefinitionUri`).
- **Specs with authorizers:** `<name>-auth.sam.yaml` (Lambda authorizer stack) **and** `<name>.sam.yaml` (API stack). The cleaned spec contains `x-amazon-apigateway-authorizer` extensions with `{{AUTHORIZER_FUNCTION_ARN}}` and `{{AWS_REGION}}` placeholders. The deploy scripts resolve these placeholders at deploy time.

See `references/transformation-definition.md` for the full transformation rules and exit criteria.

After the command completes, read `validation-summary.json` to check the `pass` field:

```bash
jq '.pass' <output-dir>/validation-summary.json
```

If `pass` is `false`, read the failing checks and report them clearly:

```bash
jq '.checks[] | select(.pass == false)' <output-dir>/validation-summary.json
```

Also read `breaking-changes.json` — a structured list of every `breaking`-level change (dropped
paths, resource-limit overflows, rename collisions). Each entry has `category`, `reason`, `specFile`,
`clientImpact`, and `remediation`. When the CLI exits 2 with `--fail-on=breaking` (the default), this
file tells you exactly what to review before rerunning with a higher `--resources-per-api-limit` or
with `--fail-on=never` to accept the impact.

Do **not** proceed to deployment if validation has failed unless the user explicitly acknowledges and
accepts the risk.

### 2.5 Post-transform spec review

After transformation, scan `diagnostics.json` for warnings. Additionally, review the cleaned spec for
issues the automated transforms cannot catch:

1. **Content type typos**: The tool auto-corrects common typos (`applcation` → `application`), but check `diagnostics.json` for `content-type-typo` entries. If the tool dropped a content type entirely (not in diagnostics), grep the cleaned spec for suspicious content types.

2. **Path segment validity**: API Gateway rejects paths with colons (`jcr:content`), dots in non-extension positions (`.json` mid-path), or other non-standard characters. Search the cleaned spec for such patterns:

   ```bash
   grep -E '^\s+/.*[:.]' <output-dir>/<name>-cleaned.yaml | head -20
   ```

   If found, warn the user that these paths will fail API Gateway import and suggest renaming.

3. **Large specs**: If the cleaned spec exceeds 500 paths, warn about API Gateway's resources-per-API limit. The tool adds an advisory `api-gateway-resource-limit` check in `validation-summary.json`.

---

## Phase 3: Pre-deployment Validation

### 3.1 Validation summary review

Already performed at the end of Phase 2. Confirm `pass: true` before continuing.

### 3.2 cfn-lint (if available)

Run cfn-lint against every `.sam.yaml` file in the output directory:

```bash
cfn-lint <output-dir>/*.sam.yaml
```

Treat cfn-lint `E`-level findings as blocking. Treat `W`-level findings as advisories — report them
but do not block deployment unless the user asks to be strict.

---

## Phase 4: Deploy

> **Requires SAM.** Skip this phase entirely if the user declined to install the SAM CLI in Phase 1.3
> — proceed to Phase 7 and record `Deployment: SKIPPED (SAM not installed)` in the summary.

All deploy paths use `DefinitionUri` — the cleaned spec is always uploaded to S3 automatically. For
specs with authorizers, a **two-phase deploy** is performed: the authorizer Lambda stack is deployed
first, its ARN is used to resolve `{{AUTHORIZER_FUNCTION_ARN}}` and `{{AWS_REGION}}` placeholders in
the cleaned spec, the resolved spec is uploaded to S3, and then the API stack is deployed.

### 4.1 Using the bundled sam-deploy.sh script (recommended)

The `scripts/sam-deploy.sh` script handles both single-template and two-phase deploy automatically:

```bash
bash "$SKILL_DIR/scripts/sam-deploy.sh" <output-dir> \
  --region <region> \
  --stage <stage> \
  [--stack-name <name>]
```

The script will:

1. Check that SAM CLI and AWS credentials are configured.
2. Detect whether an `*-auth.sam.yaml` template is present.
3. If yes (spec has authorizers): deploy the auth stack first, resolve placeholders in the cleaned spec, upload to S3, then deploy the API stack.
4. If no: upload the cleaned spec to S3 and deploy the single API stack.
5. Print the CloudFormation stack outputs (including the API Gateway endpoint URL).

If `--stack-name` is omitted, the stack name is derived from the template filename.

### 4.2 Using the generated deploy.sh

The per-output deploy script handles the same two-phase logic and can be run from within the output
directory:

```bash
cd <output-dir> && bash deploy.sh
```

### 4.3 Manual deploy

If the user prefers explicit `sam deploy` steps instead of the bundled scripts, follow
`references/manual-deploy.md`.

Capture the `InvokeURL` output for Phase 5 and Phase 6.

---

## Phase 5: Post-deployment Validation

After a successful CloudFormation deploy, verify the deployed API matches the source spec counts. The
bundled `scripts/validate-deployment.sh` automates the comparison below together with the E2E curl
tests in Phase 6.

### 5.1 Retrieve the REST API ID

```bash
aws cloudformation describe-stacks \
  --stack-name <stack-name> \
  --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='RestApiId'].OutputValue" \
  --output text
```

If the stack does not export `RestApiId`, find the API by name:

```bash
aws apigateway get-rest-apis --region <region> \
  | jq -r '.items[] | select(.name == "<api-name>") | .id'
```

### 5.2 Count deployed resources and compare with source-analysis.json

```bash
# Count resources (paths)
aws apigateway get-resources --rest-api-id <api-id> --region <region> \
  | jq '[.items[]] | length'

# Read expected counts
jq '{pathCount, schemaCount}' <output-dir>/source-analysis.json
```

Note that API Gateway resource count includes the root `/` resource, so the deployed count will be
`pathCount + 1`. Flag a mismatch as a warning; do not treat it as a hard failure unless the
discrepancy is large.

---

## Phase 6: E2E Testing

> **Requires a deployed stack (and therefore SAM).** Skip this phase if Phase 4 was skipped because
> SAM is not installed. Record `E2E smoke tests: SKIPPED (SAM not installed)` in the summary.

Perform smoke tests using curl against the deployed API Gateway stage URL.

### 6.1 Identify test endpoints

Read `source-analysis.json` to understand the paths, then choose representative endpoints (prefer GET
endpoints with no required request body).

### 6.2 Run curl tests

```bash
curl -s -o /dev/null -w "%{http_code}" \
  "https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/<path>"
```

**Expected responses with mock integration:**

- `200` — mock integration responded correctly.
- `403` — API key or authorizer is enforced; expected for secured endpoints.
- `404` — path not deployed; investigate.
- `500` — integration error; check CloudWatch logs.

Report results per endpoint in a table:

| Endpoint | Method | HTTP Status | Result |
|----------|--------|-------------|--------|
| /pets | GET | 200 | PASS |
| /pets/{id} | GET | 200 | PASS |

Accept `200` and `403` as passing for E2E purposes. Flag `404` and `5xx` as failures requiring
investigation.

---

## Phase 7: Unsupported Features Report

Use the bundled report script to parse `diagnostics.json` and generate a structured summary of all
unsupported/unknown OpenAPI features:

```bash
bash "$SKILL_DIR/scripts/generate-unsupported-report.sh" <output-dir>/diagnostics.json
```

To save the report to a file:

```bash
bash "$SKILL_DIR/scripts/generate-unsupported-report.sh" \
  <output-dir>/diagnostics.json \
  <output-dir>/unsupported-features-report.md
```

The report includes sections for removed features, converted features, flagged items requiring manual
action, warnings, and errors — grouped by feature and transform rule with occurrence counts.

---

## Phase 8: Cleanup

After all validation and testing is complete, ask the user whether they want to keep the deployed
stack or tear it down. If the user confirms cleanup (or said "deploy and test only" / "don't keep the
stack" upfront), delete the stack:

```bash
sam delete \
  --stack-name <stack-name> \
  --region <region> \
  --no-prompts
```

If a two-phase deploy was used, delete the authorizer stack (`<stack-name>-auth`) as well, after the
API stack is gone.

Verify the stack is gone:

```bash
aws cloudformation describe-stacks \
  --stack-name <stack-name> \
  --region <region> 2>&1 | grep -q "does not exist" && echo "Stack deleted" || echo "Stack still exists"
```

If the user wants to keep the stack, skip this phase and note the stack name and region in the output
summary.

---

## Failure Handling

On **any** failure in any phase:

1. **Stop immediately.** Do not retry the same command blindly.
2. **Diagnose root cause.** Read error output, relevant JSON artifacts, and CloudFormation events if the failure is in a deploy phase.
3. **Check CloudFormation events on deploy failure:**

   ```bash
   aws cloudformation describe-stack-events \
     --stack-name <stack-name> \
     --region <region> \
     --query "StackEvents[?ResourceStatus=='CREATE_FAILED' || ResourceStatus=='UPDATE_FAILED']" \
     --output table
   ```

4. **Report clearly:** Provide the exact error, the likely cause, and a concrete remediation step.
5. **Ask the user** before retrying or attempting a workaround.

Common failure patterns:

| Symptom | Likely Cause | Remediation |
|---------|-------------|-------------|
| `validation-summary.json pass: false` | Transformation dropped paths/ops | Check `diagnostics.json` for `action: removed` entries |
| cfn-lint `E` findings on `.sam.yaml` | Template does not conform to CFN/SAM spec | Review flagged resource properties; may need manual edit |
| CloudFormation `ROLLBACK_COMPLETE` | IAM capability not provided or resource limit hit | Ensure `--capabilities CAPABILITY_IAM`; check the API Gateway resources-per-API limit |
| curl returns `404` for all paths | Stage not deployed or stage name mismatch | Verify `StageName` parameter matches the `--stage` used in transform |
| `sam: command not found` during deploy | SAM CLI uninstalled after Phase 1.3 passed | Install SAM CLI — see `references/sam-cli-installation.md`. (If SAM was never installed, deploy/E2E should already have been skipped per Phase 1.3 — not a failure.) |
| `aws: command not found` | AWS CLI not installed | Install AWS CLI v2 |
| `npx openapi-to-apigw` fails with `MODULE_NOT_FOUND` | Tool not built | Run `npm install && npm run build` in `$TOOL_DIR` |
| API stack deploy fails with unresolved `{{AUTHORIZER_FUNCTION_ARN}}` | Two-phase deploy not completed — auth stack was not deployed first, or placeholder resolution failed | Check the `*-auth.sam.yaml` stack status first; ensure the authorizer Lambda deployed successfully before rerunning the API stack deploy |

---

## Decision Framework

Use this decision tree at the start of each invocation to determine which phases to run:

```
Does <output-dir> already exist with valid artifacts?
  YES → Skip Phase 2; start from Phase 3
  NO  → Run all phases from Phase 1

Did the user say "don't deploy" or "just transform"?
  YES → Stop after Phase 3; present artifacts and report
  NO  → Continue through Phase 7

Is the SAM CLI available? (deploy + E2E need it; transform/validate/report do not)
  YES → Continue through Phases 4–6
  NO  → Prompt the user to install SAM (Phase 1.3)
          installs  → continue through Phases 4–6
          declines  → skip Phases 4–6; deliver transform + validation + report (Phase 7)

Is cfn-lint available?
  YES → Run Phase 3.2
  NO  → Note absence; skip Phase 3.2

Are there E2E test failures?
  YES → Report failures with HTTP codes; do not mark workflow as complete
  NO  → Continue to Phase 8

Did the user say "keep the stack" or intend production use?
  YES → Skip Phase 8; note stack name in summary
  NO  → Ask user whether to clean up; run Phase 8 if confirmed
```

---

## Output Summary Format

At the end of a successful full workflow, present a concise summary:

```
OpenAPI to API Gateway Transform — Complete
===========================================
Input spec:       <input file>
OpenAPI version:  <version>
Output directory: <output-dir>

Source analysis:
  Paths:      <pathCount>
  Operations: <operationCount>
  Schemas:    <schemaCount>

Transformation:   PASSED
Pre-deploy lint:  PASSED / SKIPPED (cfn-lint not available)
Deployment:       PASSED (stack: <stack-name>, region: <region>) / SKIPPED (SAM not installed)
Post-deploy check: PASSED / WARNING (resource count delta: +1 root resource) / SKIPPED (SAM not installed)

E2E smoke tests:  <N>/<N> PASSED / SKIPPED (SAM not installed)

API Gateway URL:  https://<api-id>.execute-api.<region>.amazonaws.com/<stage>  (N/A if deployment skipped)
Stack cleanup:    DELETED / KEPT (stack: <stack-name>) / N/A (nothing deployed)

Unsupported features: <count> flagged — see diagnostics.json for details
```

---

## Verifying AWS Documentation Claims

API Gateway limits and supported features change over time. Before asserting a specific limit,
supported feature, or CloudFormation resource property:

- **If an AWS documentation MCP server is configured** (for example the
  [AWS Documentation MCP Server](https://github.com/awslabs/mcp)), query it and cite the result.
- **Otherwise**, fall back to `references/apigw-import-limitations.md`, which captures the official
  API Gateway REST API limitations, and link the user to the live documentation at
  https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-known-issues.html

Never state a quota or feature-support claim from memory alone.

## Reference Documentation

- **Transformation Definition**: `references/transformation-definition.md` — Full transformation rules, pipeline steps, and exit criteria
- **Manual Deploy**: `references/manual-deploy.md` — Explicit `sam deploy` steps for single-stack and two-phase (authorizer) deployments
- **Operational Learnings**: `references/learnings.md` — API Gateway import limitations and optimization insights discovered across many transformation runs
- **API Gateway Known Issues**: `references/apigw-import-limitations.md` — Official AWS documentation on REST API limitations, OpenAPI spec support gaps, and header handling
- **SAM CLI Installation**: `references/sam-cli-installation.md` — Platform-specific SAM CLI installation instructions
- **SAM Deploy Script**: `scripts/sam-deploy.sh` — Deploy all SAM templates in an output directory via `sam deploy --resolve-s3`
- **Post-deployment Validation Script**: `scripts/validate-deployment.sh` — Automated resource/model count verification and E2E curl tests
- **Unsupported Features Report Script**: `scripts/generate-unsupported-report.sh` — Parse diagnostics.json into a structured report of unsupported/unknown OpenAPI features
