#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
set -euo pipefail

# Usage: ./sam-deploy.sh <output-dir> [--region <region>] [--stage <stage>] [--stack-name <name>]
#
# Deploys all SAM templates (*.sam.yaml) found in <output-dir>.
#
# For each API spec:
#   - If an authorizer template exists (*-auth.sam.yaml), deploys it first,
#     retrieves the Lambda ARN, resolves {{AUTHORIZER_FUNCTION_ARN}} and
#     {{AWS_REGION}} placeholders in the cleaned spec, then uploads the
#     resolved spec to S3 before deploying the API stack.
#   - Otherwise, uploads the cleaned spec to S3 and deploys the API stack.

OUTPUT_DIR="${1:?Usage: ./sam-deploy.sh <output-dir> [--region <region>] [--stage <stage>] [--stack-name <name>]}"
shift

# Defaults
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
STAGE="test"
STACK_NAME=""

# Parse optional arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)   REGION="$2"; shift 2 ;;
    --stage)    STAGE="$2"; shift 2 ;;
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Validate output directory
if [[ ! -d "$OUTPUT_DIR" ]]; then
  echo "ERROR: Output directory not found: $OUTPUT_DIR" >&2
  exit 1
fi

# Check SAM CLI
if ! command -v sam &>/dev/null; then
  echo "ERROR: SAM CLI not found." >&2
  echo "Install from: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html" >&2
  exit 1
fi
echo "SAM CLI: $(sam --version)"

# Check AWS credentials and get account ID (single STS call)
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text) || {
  echo "ERROR: AWS credentials not configured. Run 'aws configure' or set environment variables." >&2
  exit 1
}
echo "AWS Account: $AWS_ACCOUNT"
echo ""

# Get or create an S3 bucket for spec uploads
SAM_BUCKET="sam-deploy-specs-${AWS_ACCOUNT}-${REGION}"
aws s3api head-bucket --bucket "$SAM_BUCKET" 2>/dev/null || aws s3 mb "s3://$SAM_BUCKET" --region "$REGION"
echo "S3 bucket: $SAM_BUCKET"
echo ""

# Find API SAM templates (exclude *-auth.sam.yaml authorizer templates)
API_TEMPLATES=()
for f in "$OUTPUT_DIR"/*.sam.yaml; do
  [[ -f "$f" ]] || continue
  [[ "$f" == *-auth.sam.yaml ]] && continue
  API_TEMPLATES+=("$f")
done

if [[ ${#API_TEMPLATES[@]} -eq 0 ]]; then
  echo "ERROR: No .sam.yaml files found in $OUTPUT_DIR" >&2
  exit 1
fi

echo "Found ${#API_TEMPLATES[@]} API template(s) to deploy"
echo "Region: $REGION | Stage: $STAGE"
echo ""

DEPLOYED_STACKS=()

for template in "${API_TEMPLATES[@]}"; do
  template_basename=$(basename "$template")
  spec_base="${template_basename%.sam.yaml}"

  # Derive stack name
  if [[ -n "$STACK_NAME" ]]; then
    api_stack="$STACK_NAME"
  else
    api_stack=$(echo "$spec_base" | sed 's/[^a-zA-Z0-9-]/-/g; s/-\+/-/g; s/^-//; s/-$//')
  fi

  # Check for corresponding authorizer template
  auth_template="$OUTPUT_DIR/${spec_base}-auth.sam.yaml"
  cleaned_spec="$OUTPUT_DIR/${spec_base}-cleaned.yaml"
  # Fallback to json if yaml not present
  if [[ ! -f "$cleaned_spec" ]]; then
    cleaned_spec="$OUTPUT_DIR/${spec_base}-cleaned.json"
  fi

  if [[ -f "$auth_template" ]]; then
    # ─── Two-phase deploy: authorizer first, then API ───
    auth_stack="${api_stack}-auth"

    echo "=== Phase 1: Deploy authorizer stack: $auth_stack ==="
    echo "Template: $auth_template"

    sam deploy \
      --template-file "$auth_template" \
      --stack-name "$auth_stack" \
      --capabilities CAPABILITY_IAM \
      --region "$REGION" \
      --resolve-s3 \
      --no-fail-on-empty-changeset \
      --no-confirm-changeset

    # Get Lambda ARN from authorizer stack outputs
    AUTH_FUNCTION_ARN=$(aws cloudformation describe-stacks \
      --stack-name "$auth_stack" \
      --region "$REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='AuthorizerFunctionArn'].OutputValue" \
      --output text)
    echo "Authorizer function ARN: $AUTH_FUNCTION_ARN"

    if [[ -z "$AUTH_FUNCTION_ARN" || "$AUTH_FUNCTION_ARN" == "None" ]]; then
      echo "ERROR: Could not retrieve AuthorizerFunctionArn from stack '$auth_stack' outputs." >&2
      echo "Check that the authorizer stack deployed successfully and has the expected output." >&2
      exit 1
    fi

    DEPLOYED_STACKS+=("$auth_stack")

    # Resolve placeholders in the cleaned spec
    echo "Resolving authorizer placeholders in $(basename "$cleaned_spec")..."
    resolved_spec="${cleaned_spec}.resolved"
    sed \
      -e "s|{{AUTHORIZER_FUNCTION_ARN}}|$AUTH_FUNCTION_ARN|g" \
      -e "s|{{AWS_REGION}}|$REGION|g" \
      "$cleaned_spec" > "$resolved_spec"

    # Upload resolved spec to S3
    S3_SPEC_KEY="${api_stack}/$(basename "$cleaned_spec")"
    aws s3 cp "$resolved_spec" "s3://$SAM_BUCKET/$S3_SPEC_KEY" --region "$REGION"
    echo "Uploaded resolved spec to s3://$SAM_BUCKET/$S3_SPEC_KEY"

    # Rewrite DefinitionUri to point to S3
    resolved_template="${template}.resolved"
    sed "s|DefinitionUri:.*|DefinitionUri: s3://$SAM_BUCKET/$S3_SPEC_KEY|" \
      "$template" > "$resolved_template"

    echo ""
    echo "=== Phase 2: Deploy API stack: $api_stack ==="
    sam deploy \
      --template-file "$resolved_template" \
      --stack-name "$api_stack" \
      --parameter-overrides "StageName=$STAGE" "AuthorizerFunctionArn=$AUTH_FUNCTION_ARN" \
      --capabilities CAPABILITY_IAM \
      --region "$REGION" \
      --resolve-s3 \
      --no-fail-on-empty-changeset \
      --no-confirm-changeset

    # Clean up temporary files
    rm -f "$resolved_spec" "$resolved_template"
  else
    # ─── Single-phase deploy: upload spec to S3 + deploy ───
    echo "=== Deploying: $api_stack ==="
    echo "Template: $template"

    # Upload cleaned spec to S3
    S3_SPEC_KEY="${api_stack}/$(basename "$cleaned_spec")"
    aws s3 cp "$cleaned_spec" "s3://$SAM_BUCKET/$S3_SPEC_KEY" --region "$REGION"
    echo "Uploaded spec to s3://$SAM_BUCKET/$S3_SPEC_KEY"

    # Rewrite DefinitionUri to point to S3
    resolved_template="${template}.resolved"
    sed "s|DefinitionUri:.*|DefinitionUri: s3://$SAM_BUCKET/$S3_SPEC_KEY|" \
      "$template" > "$resolved_template"

    sam deploy \
      --template-file "$resolved_template" \
      --stack-name "$api_stack" \
      --parameter-overrides "StageName=$STAGE" \
      --capabilities CAPABILITY_IAM \
      --region "$REGION" \
      --resolve-s3 \
      --no-fail-on-empty-changeset \
      --no-confirm-changeset

    # Clean up temporary file
    rm -f "$resolved_template"
  fi

  echo ""
  echo "--- Stack Outputs ---"
  aws cloudformation describe-stacks \
    --stack-name "$api_stack" \
    --region "$REGION" \
    --query "Stacks[0].Outputs" \
    --output table

  DEPLOYED_STACKS+=("$api_stack")
  echo ""
done

echo "=== Deployment Complete ==="
echo "Deployed ${#DEPLOYED_STACKS[@]} stack(s): ${DEPLOYED_STACKS[*]}"
echo ""
echo "Next steps:"
echo "  1. Run validate-deployment.sh to verify resource counts"
echo "  2. Run E2E smoke tests against the InvokeURL"
echo "  3. Run generate-unsupported-report.sh for feature diagnostics"
