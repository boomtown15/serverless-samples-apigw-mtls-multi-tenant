import type { TransformOptions } from '../types.js';
import { resolveOptions } from '../types.js';

/** Metadata about a single spec for deploy script generation. */
export interface SpecDeployInfo {
  /** SAM template filename for the API stack (e.g. "petstore.sam.yaml") */
  apiTemplate: string;
  /** Cleaned spec filename (e.g. "petstore-cleaned.yaml") */
  cleanedSpec: string;
  /** SAM template filename for the authorizer-only phase, or null if no authorizers */
  authorizerTemplate: string | null;
}

function sanitizeStackName(filename: string): string {
  return filename
    .replace(/\.sam\.yaml$/, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate a deploy.sh script that deploys each spec as a single CloudFormation stack.
 *
 * For specs with authorizers, uses a two-phase approach on the SAME stack:
 * 1. Phase 1: Deploy the authorizer-only template (creates the Lambda function)
 * 2. Retrieve the Lambda ARN from stack outputs
 * 3. Resolve placeholders in the cleaned spec with the real ARN
 * 4. Phase 2: Update the same stack with the full template (Lambda + API)
 *
 * This ensures all resources live in one stack — no ordering issues, and
 * `aws cloudformation delete-stack` cleans up everything.
 */
export function generateDeployScript(
  specs: SpecDeployInfo[],
  options: TransformOptions,
): string {
  const resolved = resolveOptions(options);
  const region = resolved.region;
  const stage = resolved.stage;
  // stackPrefix: compile-time default; adds trailing '-' when non-empty so
  // stacks are "<prefix>-<base>". Empty string preserves prior behaviour.
  const stackPrefixDefault = resolved.stackPrefix ? `${resolved.stackPrefix}-` : '';

  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Auto-generated SAM deploy script',
    '# Uploads cleaned specs to S3, then deploys via SAM CLI.',
    '',
    `REGION="\${AWS_DEFAULT_REGION:-${region}}"`,
    `STAGE="${stage}"`,
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    '# S3_PREFIX: unique per output directory so parallel deploys do not collide on the same S3 key.',
    '# When a custom --output-dir is used, basename($SCRIPT_DIR) captures it automatically.',
    'S3_PREFIX="$(basename "$SCRIPT_DIR")"',
    '# STACK_PREFIX: prepended to every stack name (including trailing dash if non-empty).',
    '# Runtime env var overrides the compile-time default baked in at --stack-prefix time.',
    `STACK_PREFIX="\${STACK_PREFIX:-${stackPrefixDefault}}"`,
    '',
    '# Check SAM CLI availability',
    'if ! command -v sam &>/dev/null; then',
    '  echo "ERROR: SAM CLI not found. Install from https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html"',
    '  exit 1',
    'fi',
    '',
    '# Get or create S3 bucket for spec uploads',
    'AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)',
    'SAM_BUCKET="aws-sam-cli-managed-default-samclisourcebucket-${AWS_ACCOUNT}-${REGION}"',
    'aws s3api head-bucket --bucket "$SAM_BUCKET" 2>/dev/null || aws s3 mb "s3://$SAM_BUCKET" --region "$REGION"',
    'echo "S3 bucket: $SAM_BUCKET"',
    '',
    '# Deploy stacks',
  ];

  for (const spec of specs) {
    const stackName = sanitizeStackName(spec.apiTemplate);

    if (spec.authorizerTemplate) {
      // ── Two-phase single-stack deploy ──
      // Phase 1: deploy Lambda only, Phase 2: update to add API
      lines.push(
        '',
        `echo ""`,
        `echo "=== Phase 1: Deploy authorizer Lambda (stack: \${STACK_PREFIX}${stackName}) ==="`,
        `sam deploy \\`,
        `  --template-file "$SCRIPT_DIR/${spec.authorizerTemplate}" \\`,
        `  --stack-name "\${STACK_PREFIX}${stackName}" \\`,
        `  --capabilities CAPABILITY_IAM \\`,
        `  --region "$REGION" \\`,
        `  --resolve-s3 \\`,
        `  --no-fail-on-empty-changeset \\`,
        `  --no-confirm-changeset`,
        '',
        `# Get the Lambda authorizer ARN from stack outputs`,
        `AUTH_FUNCTION_ARN=$(aws cloudformation describe-stacks \\`,
        `  --stack-name "\${STACK_PREFIX}${stackName}" \\`,
        `  --region "$REGION" \\`,
        `  --query "Stacks[0].Outputs[?OutputKey=='AuthorizerFunctionArn'].OutputValue" \\`,
        `  --output text)`,
        `echo "Authorizer function ARN: $AUTH_FUNCTION_ARN"`,
        '',
        `if [[ -z "$AUTH_FUNCTION_ARN" || "$AUTH_FUNCTION_ARN" == "None" ]]; then`,
        `  echo "ERROR: Could not retrieve AuthorizerFunctionArn from stack '\${STACK_PREFIX}${stackName}'." >&2`,
        `  exit 1`,
        `fi`,
        '',
        `# Resolve placeholders in the cleaned spec`,
        `echo "Resolving authorizer placeholders in ${spec.cleanedSpec}..."`,
        `sed \\`,
        `  -e "s|{{AUTHORIZER_FUNCTION_ARN}}|$AUTH_FUNCTION_ARN|g" \\`,
        `  -e "s|{{AWS_REGION}}|$REGION|g" \\`,
        `  "$SCRIPT_DIR/${spec.cleanedSpec}" > "$SCRIPT_DIR/${spec.cleanedSpec}.resolved"`,
        '',
        `# Upload resolved spec to S3 using unique per-directory prefix to prevent parallel-deploy collisions`,
        `S3_SPEC_KEY="$S3_PREFIX/${spec.cleanedSpec}"`,
        `aws s3 cp "$SCRIPT_DIR/${spec.cleanedSpec}.resolved" "s3://$SAM_BUCKET/$S3_SPEC_KEY" --region "$REGION"`,
        `echo "Uploaded resolved spec to s3://$SAM_BUCKET/$S3_SPEC_KEY"`,
        '',
        `# Rewrite DefinitionUri in SAM template to point to S3`,
        `sed "s|DefinitionUri:.*|DefinitionUri: s3://$SAM_BUCKET/$S3_SPEC_KEY|" \\`,
        `  "$SCRIPT_DIR/${spec.apiTemplate}" > "$SCRIPT_DIR/${spec.apiTemplate}.resolved"`,
        '',
        `echo ""`,
        `echo "=== Phase 2: Update stack with API (stack: \${STACK_PREFIX}${stackName}) ==="`,
        `sam deploy \\`,
        `  --template-file "$SCRIPT_DIR/${spec.apiTemplate}.resolved" \\`,
        `  --stack-name "\${STACK_PREFIX}${stackName}" \\`,
        `  --parameter-overrides "StageName=$STAGE" \\`,
        `  --capabilities CAPABILITY_IAM \\`,
        `  --region "$REGION" \\`,
        `  --resolve-s3 \\`,
        `  --no-fail-on-empty-changeset \\`,
        `  --no-confirm-changeset`,
        '',
        `# Clean up temporary files`,
        `rm -f "$SCRIPT_DIR/${spec.cleanedSpec}.resolved" "$SCRIPT_DIR/${spec.apiTemplate}.resolved"`,
      );
    } else {
      // ── Single-phase deploy: upload spec to S3 + deploy ──
      lines.push(
        '',
        `echo ""`,
        `echo "=== Deploying stack: \${STACK_PREFIX}${stackName} ==="`,
        '',
        `# Upload cleaned spec to S3 using unique per-directory prefix to prevent parallel-deploy collisions`,
        `S3_SPEC_KEY="$S3_PREFIX/${spec.cleanedSpec}"`,
        `aws s3 cp "$SCRIPT_DIR/${spec.cleanedSpec}" "s3://$SAM_BUCKET/$S3_SPEC_KEY" --region "$REGION"`,
        `echo "Uploaded spec to s3://$SAM_BUCKET/$S3_SPEC_KEY"`,
        '',
        `# Rewrite DefinitionUri in SAM template to point to S3`,
        `sed "s|DefinitionUri:.*|DefinitionUri: s3://$SAM_BUCKET/$S3_SPEC_KEY|" \\`,
        `  "$SCRIPT_DIR/${spec.apiTemplate}" > "$SCRIPT_DIR/${spec.apiTemplate}.resolved"`,
        '',
        `sam deploy \\`,
        `  --template-file "$SCRIPT_DIR/${spec.apiTemplate}.resolved" \\`,
        `  --stack-name "\${STACK_PREFIX}${stackName}" \\`,
        `  --parameter-overrides StageName="$STAGE" \\`,
        `  --capabilities CAPABILITY_IAM \\`,
        `  --region "$REGION" \\`,
        `  --resolve-s3 \\`,
        `  --no-fail-on-empty-changeset \\`,
        `  --no-confirm-changeset`,
        '',
        `# Clean up temporary file`,
        `rm -f "$SCRIPT_DIR/${spec.apiTemplate}.resolved"`,
      );
    }

    lines.push(
      '',
      `# Show stack outputs`,
      `aws cloudformation describe-stacks \\`,
      `  --stack-name "\${STACK_PREFIX}${stackName}" \\`,
      `  --region "$REGION" \\`,
      `  --query "Stacks[0].Outputs" \\`,
      `  --output table`,
    );
  }

  lines.push('', 'echo ""', 'echo "Deployment complete."', '');

  return lines.join('\n');
}
