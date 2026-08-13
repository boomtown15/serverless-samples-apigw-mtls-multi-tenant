#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
set -euo pipefail

# Usage: ./validate-deployment.sh <stack-name> <region> <source-analysis.json> [cleaned-spec.yaml]

STACK_NAME="${1:?Usage: ./validate-deployment.sh <stack-name> <region> <source-analysis.json> [cleaned-spec.yaml]}"
REGION="${2:?Missing region}"
SOURCE_ANALYSIS="${3:?Missing source-analysis.json path}"
CLEANED_SPEC="${4:-}"

PASS=0
FAIL=0
RESULTS=()

check() {
  local name="$1" expected="$2" actual="$3" op="${4:-eq}"
  local result="PASS"
  if ! [[ "$expected" =~ ^-?[0-9]+$ && "$actual" =~ ^-?[0-9]+$ ]]; then
    result="FAIL"
    echo "  [ERROR] Non-numeric values for $name: expected='$expected' actual='$actual'"
  else
    case "$op" in
      eq)  [[ "$actual" == "$expected" ]] || result="FAIL" ;;
      gte) [[ "$actual" -ge "$expected" ]] || result="FAIL" ;;
    esac
  fi
  if [[ "$result" == "PASS" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
  RESULTS+=("$result | $name | expected=$expected | actual=$actual")
  echo "  [$result] $name: expected=$expected actual=$actual"
}

echo "=== Post-Deployment Validation ==="
echo "Stack: $STACK_NAME | Region: $REGION"
echo ""

# Validate source analysis file
if [[ ! -f "$SOURCE_ANALYSIS" ]]; then
  echo "FATAL: Source analysis file not found: $SOURCE_ANALYSIS"
  exit 1
fi

echo "--- Stack Outputs ---"
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output json) || { echo "FATAL: Stack $STACK_NAME not found or not accessible"; exit 1; }

# Single jq pass for both output keys
output_line=$(echo "$OUTPUTS" | jq -r '
  (map({(.OutputKey): .OutputValue}) | add // {}) as $m |
  [($m.RestApiId // ""), ($m.InvokeURL // "")] | @tsv') || {
  echo "FATAL: Failed to parse stack outputs"
  exit 1
}
read -r REST_API_ID INVOKE_URL <<< "$output_line"

if [[ -z "$REST_API_ID" ]]; then
  echo "FATAL: RestApiId not found in stack outputs"
  exit 1
fi
echo "RestApiId: $REST_API_ID"
echo "InvokeURL: $INVOKE_URL"
echo ""

# Single jq pass for expected counts
analysis_line=$(jq -r '[.pathCount, .schemaCount] | @tsv' "$SOURCE_ANALYSIS") || {
  echo "FATAL: Failed to parse $SOURCE_ANALYSIS"
  exit 1
}
read -r EXPECTED_PATHS EXPECTED_SCHEMAS <<< "$analysis_line"

if [[ -z "$EXPECTED_PATHS" || -z "$EXPECTED_SCHEMAS" ]]; then
  echo "FATAL: Missing pathCount or schemaCount in $SOURCE_ANALYSIS"
  exit 1
fi

echo "--- Resource Count Verification ---"

# Run independent AWS API calls in parallel with proper error handling
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

aws apigateway get-resources \
  --rest-api-id "$REST_API_ID" \
  --region "$REGION" \
  --no-paginate \
  --query "items" \
  --output json > "$tmp_dir/resources.json" 2>"$tmp_dir/resources.err" &
pid_resources=$!

aws apigateway get-models \
  --rest-api-id "$REST_API_ID" \
  --region "$REGION" \
  --no-paginate \
  --query "items" \
  --output json > "$tmp_dir/models.json" 2>"$tmp_dir/models.err" &
pid_models=$!

aws apigateway get-rest-api \
  --rest-api-id "$REST_API_ID" \
  --region "$REGION" \
  --output json > "$tmp_dir/api.json" 2>"$tmp_dir/api.err" &
pid_api=$!

api_fail=0
for label_pid in "resources:$pid_resources" "models:$pid_models" "api:$pid_api"; do
  label="${label_pid%%:*}"
  pid="${label_pid##*:}"
  if ! wait "$pid"; then
    echo "  [ERROR] aws apigateway get-${label} failed:"
    cat "$tmp_dir/${label}.err" 2>/dev/null
    api_fail=1
  fi
done
if [[ "$api_fail" -ne 0 ]]; then
  echo "FATAL: One or more API Gateway calls failed"
  exit 1
fi

# Subtract 1 for the root resource /
ACTUAL_RESOURCES=$(jq 'length - 1' "$tmp_dir/resources.json")
check "path-count" "$EXPECTED_PATHS" "$ACTUAL_RESOURCES"

# >= expected because APIGW auto-creates Empty and Error models
ACTUAL_MODELS=$(jq 'length' "$tmp_dir/models.json")
check "model-count (>= expected)" "$EXPECTED_SCHEMAS" "$ACTUAL_MODELS" "gte"

API_TYPE=$(jq -r '.endpointConfiguration.types[0] // "EDGE"' "$tmp_dir/api.json")
echo "  [INFO] API endpoint type: $API_TYPE (REST API confirmed)"

echo ""
echo "--- E2E Mock Integration Tests ---"

if [[ -z "$INVOKE_URL" ]]; then
  echo "  [SKIP] No InvokeURL found, skipping E2E tests"
else
  if [[ -n "$CLEANED_SPEC" && -f "$CLEANED_SPEC" ]]; then
    # Check python3+pyyaml availability separately from YAML parsing
    if ! python3 -c "import yaml" 2>/dev/null; then
      echo "  [WARN] python3 or pyyaml not available, skipping E2E tests"
      PATHS='[]'
    else
      PATHS=$(python3 -c "
import yaml, sys, json
with open(sys.argv[1]) as f:
    spec = yaml.safe_load(f)
print(json.dumps(list(spec.get('paths', {}).keys())))
" "$CLEANED_SPEC") || {
        echo "  [ERROR] Failed to parse YAML spec: $CLEANED_SPEC"
        PATHS='[]'
      }
    fi
  else
    PATHS='[]'
  fi

  PATH_COUNT=$(echo "$PATHS" | jq 'length')

  if [[ "$PATH_COUNT" -eq 0 ]]; then
    echo "  [SKIP] No paths found for E2E testing"
  else
    E2E_PASS=0
    E2E_FAIL=0
    MAX_TESTS=20
    TESTED=0

    for path in $(echo "$PATHS" | jq -r '.[]'); do
      [[ "$TESTED" -ge "$MAX_TESTS" ]] && break

      # Skip paths with path parameters
      if [[ "$path" == *"{"* ]]; then
        continue
      fi

      URL="${INVOKE_URL%/}${path}"
      curl_err="$tmp_dir/curl_err"
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$URL" 2>"$curl_err" || echo "000")

      if [[ "$HTTP_CODE" == "000" ]]; then
        E2E_FAIL=$((E2E_FAIL + 1))
        CURL_REASON=$(head -1 "$curl_err" 2>/dev/null || echo "unknown")
        echo "  [FAIL] GET $path -> connection error: $CURL_REASON"
      # 200=mock responded, 403=authorizer enforced (expected for secured endpoints)
      elif [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "403" ]]; then
        E2E_PASS=$((E2E_PASS + 1))
        echo "  [PASS] GET $path -> $HTTP_CODE"
      else
        E2E_FAIL=$((E2E_FAIL + 1))
        echo "  [FAIL] GET $path -> $HTTP_CODE (expected 200 or 403)"
      fi
      TESTED=$((TESTED + 1))
    done

    echo ""
    echo "  E2E Results: $E2E_PASS passed, $E2E_FAIL failed out of $TESTED tested"
    FAIL=$((FAIL + E2E_FAIL))
    PASS=$((PASS + E2E_PASS))
  fi
fi

echo ""
echo "=== Validation Summary ==="
echo "Passed: $PASS | Failed: $FAIL"
echo ""
for r in "${RESULTS[@]}"; do
  echo "  $r"
done

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "RESULT: FAIL"
  exit 1
else
  echo ""
  echo "RESULT: PASS"
  exit 0
fi
