# Manual Deploy

Explicit `sam deploy` steps, for when you prefer not to use the bundled `scripts/sam-deploy.sh` or the
generated `deploy.sh`.

The `--resolve-s3` flag makes SAM automatically create and manage an S3 bucket for packaging
artifacts, so no manual S3 bucket setup is needed.

## Specs without authorizers — single deploy

```bash
sam deploy \
  --template-file <output-dir>/<name>.sam.yaml \
  --stack-name <stack-name> \
  --parameter-overrides StageName=<stage> \
  --capabilities CAPABILITY_IAM \
  --region <region> \
  --resolve-s3 \
  --no-fail-on-empty-changeset \
  --no-confirm-changeset
```

## Specs with authorizers — two-phase deploy

The cleaned spec contains `{{AUTHORIZER_FUNCTION_ARN}}` and `{{AWS_REGION}}` placeholders that must be
resolved with real values before the API stack is deployed. `DefinitionUri` uploads the spec to S3 as
a static file, and CloudFormation does **not** resolve intrinsic functions inside it — so the
substitution has to happen before the upload.

```bash
# Phase 1: deploy the authorizer Lambda stack
sam deploy \
  --template-file <output-dir>/<name>-auth.sam.yaml \
  --stack-name <stack-name>-auth \
  --capabilities CAPABILITY_IAM \
  --region <region> \
  --resolve-s3 \
  --no-fail-on-empty-changeset \
  --no-confirm-changeset

# Retrieve the Lambda ARN from the auth stack outputs
AUTHORIZER_ARN=$(aws cloudformation describe-stacks \
  --stack-name <stack-name>-auth \
  --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='AuthorizerFunctionArn'].OutputValue" \
  --output text)

# Resolve the placeholders in the cleaned spec
sed -e "s|{{AUTHORIZER_FUNCTION_ARN}}|${AUTHORIZER_ARN}|g" \
    -e "s|{{AWS_REGION}}|<region>|g" \
    <output-dir>/<name>-cleaned.yaml > <output-dir>/<name>-resolved.yaml

# Point the API template at the resolved spec, then deploy the API stack.
# (sam deploy --resolve-s3 uploads the DefinitionUri file referenced by the template.)
sam deploy \
  --template-file <output-dir>/<name>.sam.yaml \
  --stack-name <stack-name> \
  --parameter-overrides StageName=<stage> \
  --capabilities CAPABILITY_IAM \
  --region <region> \
  --resolve-s3 \
  --no-fail-on-empty-changeset \
  --no-confirm-changeset
```

Prefer `scripts/sam-deploy.sh` or the generated `deploy.sh` — both automate the placeholder
resolution, the S3 upload, and the stack ordering, which is easy to get wrong by hand.

## Retrieve stack outputs after deploy

```bash
aws cloudformation describe-stacks \
  --stack-name <stack-name> \
  --region <region> \
  --query "Stacks[0].Outputs" \
  --output table
```

Capture the `InvokeURL` output for post-deployment validation and E2E testing.
