# OpenAPI to API Gateway Transform

Importing an existing OpenAPI specification into Amazon API Gateway rarely works on the first try.
API Gateway supports most of OpenAPI 2.0 and 3.0, but not all of it — model names must be
alphanumeric, `discriminator` / `nullable` / `readOnly` / `example` are unsupported, wildcard status
codes such as `5XX` are rejected, path segments may not contain arbitrary characters, and OAuth2
security definitions are **silently dropped** with a warning, leaving a protected API deployed with no
authentication at all. A single unsupported construct fails the whole import, and the error messages
rarely point at the offending line.

This sample packages that migration work as an [Agent Skill](https://agentskills.io): an AI coding agent
loads it on demand and drives a deterministic CLI that rewrites the spec into an API Gateway-compatible
form, generates AWS SAM templates, deploys them for end-to-end verification, and reports every feature
it had to change or drop.

The transformation logic lives in a tested TypeScript CLI rather than in the prompt, so the results are
reproducible run to run; the agent orchestrates the workflow, interprets diagnostics, and handles
failures.

## Why an Agent Skill

[Agent Skills](https://agentskills.io) are a lightweight open format for extending an agent with
specialized knowledge and workflows: a folder containing a `SKILL.md` plus optional `scripts/`,
`references/`, and other resources. Agents load them through progressive disclosure — only the skill's
name and description at startup, then the full instructions when a task actually matches — so this
capability costs almost nothing in context until it is used.

The format was originally developed by Anthropic and released as an open standard. It is
vendor-neutral and supported across a wide range of agents, including Claude Code, Cursor, GitHub
Copilot, VS Code, OpenAI Codex, Gemini CLI, Kiro, Goose, and OpenHands. See the
[specification](https://agentskills.io/specification) for the full format.

## Features

- **Broad input support** — Swagger 2.0, OpenAPI 3.0.x, and 3.1.x, in YAML or JSON, as a single file or a whole directory
- **Deterministic transformation** — 18 transform rules covering Swagger 2.0 up-conversion, OpenAPI 3.1 down-conversion, JSON Schema Draft 4 cleanup, name sanitization with collision detection, and path/parameter normalization
- **Security preserved, never downgraded** — OAuth2, OIDC, and HTTP bearer schemes become deny-by-default Lambda authorizers instead of being silently dropped; `x-api-key` maps to native API Gateway keys. The tool never quietly weakens authentication
- **Generated AWS SAM templates** — `DefinitionUri`-based templates plus a ready-to-run deploy script, with automatic two-phase deploy (authorizer stack first, then API stack) for specs that need authorizers
- **Mock integrations** — every operation gets a content-type-aware mock integration, so a converted API is deployable and testable without any backend
- **Completeness verification** — path, operation, and schema counts are compared before and after transformation, and again against the deployed API. Silent data loss is treated as a failure, not a warning
- **Breaking-change reporting** — `breaking-changes.json` lists every breaking change with its client impact and a remediation hint; the CLI exits non-zero on breaking changes by default
- **Unsupported-features report** — a readable Markdown summary of everything removed, converted, or flagged for manual action
- **No AWS account required for the core workflow** — transform, validate, and report all run locally

## Prerequisites

| Requirement | Needed for |
|-------------|-----------|
| Node.js 20 or later | The bundled CLI (required) |
| An agent supporting the [Agent Skills](https://agentskills.io) format | Loading the skill (required) |
| [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) | Deployment and E2E verification only (optional) |
| AWS CLI v2 with credentials | Deployment and E2E verification only (optional) |
| `cfn-lint` | Extra template linting (optional) |

SAM, the AWS CLI, and an AWS account are needed **only** to deploy the converted spec for end-to-end
verification against live endpoints. Transformation, validation, and reporting run entirely locally. If
SAM is absent the skill offers to help install it, and skips the deployment phases if you decline
rather than failing.

## Installation

The skill is a plain directory, so you can copy it into your agent's skills directory by hand. The
[`skills`](https://skills.sh/) CLI automates that across agents:

```bash
# Install just this skill from the serverless-samples repository
npx skills add https://github.com/aws-samples/serverless-samples --skill openapi-to-apigw-transform
```

You can also point the installer directly at this sample's directory:

```bash
npx skills add https://github.com/aws-samples/serverless-samples/tree/main/apigw-openapi-transform
```

Add `-g` to install for your user account instead of the current project, and `-a <agent>` to target a
specific agent (for example `-a claude-code`). See the [skills CLI docs](https://skills.sh/docs) for
the full set of options.

The bundled CLI is built on first use. To build it ahead of time:

```bash
cd skills/openapi-to-apigw-transform/tools/openapi-to-apigw
npm install && npm run build
```

## Usage

Once installed, describe the task in natural language and the agent loads the skill:

```
Convert ./specs/petstore.yaml into an API Gateway REST API
Transform this OpenAPI spec but don't deploy it
Why does API Gateway reject this Swagger file?
Deploy the converted spec and run E2E tests, then tear the stack down
```

The skill runs an eight-phase workflow — prerequisites, transform, pre-deploy validation, deploy,
post-deploy validation, E2E testing, unsupported-features report, and cleanup — and skips the
AWS-dependent phases when SAM is unavailable or you asked it not to deploy.

### Running the CLI directly

The CLI is usable on its own, without an agent:

```bash
cd skills/openapi-to-apigw-transform/tools/openapi-to-apigw
npm install && npm run build

node dist/cli.js transform ./path/to/spec.yaml \
  --output-dir ./out \
  --region us-east-1 \
  --stage test \
  --verbose
```

Key options (`node dist/cli.js transform --help` lists them all):

| Option | Description |
|--------|-------------|
| `--output-dir <dir>` | Output directory; defaults to a timestamped directory |
| `--region <region>` | AWS region written into the generated deploy script (default `us-east-1`) |
| `--stage <name>` | API Gateway stage name (default `test`) |
| `--format <yaml\|json>` | Output format for generated specs and templates (default `yaml`) |
| `--runtime <runtime>` | Lambda runtime for authorizer stubs (default `python3.12`) |
| `--fail-on <never\|breaking\|warning>` | Exit code 2 threshold (default `breaking`) |
| `--resources-per-api-limit <n>` | Your account's API Gateway "Resources per API" quota (default `300`) |
| `--verbose` / `--json` | Print diagnostics as text / as JSON |

### Generated artifacts

| Artifact | Contents |
|----------|----------|
| `<name>-cleaned.yaml` | The API Gateway-compatible spec |
| `<name>.sam.yaml` | SAM template for the API stack |
| `<name>-auth.sam.yaml` | SAM template for the Lambda authorizer stack (only when the spec has authorizers) |
| `deploy.sh` | Deploy script handling the two-phase deploy and placeholder resolution |
| `source-analysis.json` | Pre-transform metadata: version, path/operation/schema counts, security schemes |
| `validation-summary.json` | Pre-deployment completeness checks with a pass/fail verdict |
| `diagnostics.json` | Every transformation, by level, rule, path, feature, and action |
| `breaking-changes.json` | Breaking changes with client impact and remediation |

## Testing

The CLI has 395 unit and integration tests, including fixtures for Swagger 2.0, OpenAPI 3.0, and 3.1:

```bash
cd skills/openapi-to-apigw-transform/tools/openapi-to-apigw
npm install
npm test
```

## Project structure

```
apigw-openapi-transform/
└── skills/
    └── openapi-to-apigw-transform/
        ├── SKILL.md                     # Skill definition and the 8-phase workflow
        ├── references/                  # Loaded on demand by the agent
        │   ├── transformation-definition.md
        │   ├── apigw-import-limitations.md
        │   ├── learnings.md
        │   ├── manual-deploy.md
        │   └── sam-cli-installation.md
        ├── scripts/
        │   ├── sam-deploy.sh
        │   ├── validate-deployment.sh
        │   └── generate-unsupported-report.sh
        └── tools/openapi-to-apigw/      # The bundled TypeScript CLI
            ├── src/
            └── tests/
```

## Costs and cleanup

Transformation, validation, and reporting are local and cost nothing. Deploying a converted spec
creates an API Gateway REST API, an S3 object for the spec, a CloudWatch log group, and — for specs
with authorizers — a Lambda function. These fall largely within the AWS Free Tier for smoke testing,
but you are responsible for any charges incurred.

The skill asks whether to keep or delete the stack at the end of a run. To clean up manually:

```bash
sam delete --stack-name <stack-name> --region <region> --no-prompts
# and, if a two-phase deploy was used:
sam delete --stack-name <stack-name>-auth --region <region> --no-prompts
```

## Contributing

All contributions are welcome. Please create an issue before you submit a contribution. See
[CONTRIBUTING](../CONTRIBUTING.md).

## Disclaimer

The mock integrations generated by this tool are intended for verifying that a converted spec imports
and deploys correctly — they return canned responses and are not a backend implementation. Lambda
authorizer stubs are generated **deny-by-default** and must be implemented before they will authorize
any real request. Review the generated templates, the unsupported-features report, and
`breaking-changes.json` before using converted output for anything beyond validation.

**Important** Sample code, software libraries, command line tools, proofs of concept, templates, or
other related technology are provided as AWS Content or Third-Party Content under the AWS Customer
Agreement, or the relevant written agreement between you and AWS (whichever applies). You should not
use this AWS Content or Third-Party Content in your production accounts, or on production or other
critical data. You are responsible for testing, securing, and optimizing the AWS Content or Third-Party
Content, such as sample code, as appropriate for production grade use based on your specific quality
control practices and standards. Deploying AWS Content or Third-Party Content may incur AWS charges for
creating or using AWS chargeable resources, such as running Amazon EC2 instances or using Amazon S3
storage.
