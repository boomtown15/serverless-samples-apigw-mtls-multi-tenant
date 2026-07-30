#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
set -euo pipefail

# Usage: ./generate-unsupported-report.sh <diagnostics.json> [output-file]

DIAGNOSTICS="${1:?Usage: ./generate-unsupported-report.sh <diagnostics.json> [output-file]}"
OUTPUT="${2:-}"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed" >&2
  exit 1
fi

if [[ ! -f "$DIAGNOSTICS" ]]; then
  echo "Error: Diagnostics file not found: $DIAGNOSTICS" >&2
  exit 1
fi

generate_report() {
  local diag="$1"
  local content
  content=$(<"$diag")

  if [[ -z "$content" ]]; then
    echo "Error: Diagnostics file is empty: $diag" >&2
    return 1
  fi

  # Validate JSON structure
  if ! echo "$content" | jq empty 2>/dev/null; then
    echo "Error: Diagnostics file is not valid JSON: $diag" >&2
    return 1
  fi

  echo "# Unsupported / Unknown OpenAPI Features Report"
  echo ""
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Source: $diag"
  echo ""

  # Single jq pass for all summary counts
  local summary_line
  summary_line=$(echo "$content" | jq -r '
    [length,
     ([.[] | select(.action == "removed")] | length),
     ([.[] | select(.action == "converted")] | length),
     ([.[] | select(.action == "renamed")] | length),
     ([.[] | select(.action == "skipped")] | length),
     ([.[] | select(.action == "flagged")] | length)
    ] | @tsv') || {
    echo "Error: Failed to compute summary counts from diagnostics file" >&2
    return 1
  }

  local total removed converted renamed skipped flagged
  read -r total removed converted renamed skipped flagged <<< "$summary_line"

  echo "## Summary"
  echo ""
  echo "| Action | Count |"
  echo "|--------|-------|"
  echo "| Removed | $removed |"
  echo "| Converted | $converted |"
  echo "| Renamed | $renamed |"
  echo "| Skipped | $skipped |"
  echo "| Flagged (manual action needed) | $flagged |"
  echo "| **Total** | **$total** |"
  echo ""

  echo "## Removed Features (Unsupported by API Gateway)"
  echo ""
  local removed_features
  removed_features=$(echo "$content" | jq -r '[.[] | select(.action == "removed")] | group_by(.feature) | .[] | {feature: .[0].feature, rule: .[0].rule, count: length, paths: [.[].path] | unique | .[0:5]} | "\(.feature)|\(.rule)|\(.count)|\(.paths | join(", "))"') || true

  if [[ -z "$removed_features" ]]; then
    echo "None."
  else
    echo "| Feature | Transform Rule | Count | Example Paths |"
    echo "|---------|---------------|-------|---------------|"
    while IFS='|' read -r feature rule count paths; do
      echo "| $feature | $rule | $count | $paths |"
    done <<< "$removed_features"
  fi
  echo ""

  echo "## Converted Features"
  echo ""
  local converted_features
  converted_features=$(echo "$content" | jq -r '[.[] | select(.action == "converted")] | group_by(.feature) | .[] | {feature: .[0].feature, rule: .[0].rule, count: length, message: .[0].message} | "\(.feature)|\(.rule)|\(.count)|\(.message)"') || true

  if [[ -z "$converted_features" ]]; then
    echo "None."
  else
    echo "| Feature | Transform Rule | Count | Detail |"
    echo "|---------|---------------|-------|--------|"
    while IFS='|' read -r feature rule count message; do
      echo "| $feature | $rule | $count | $message |"
    done <<< "$converted_features"
  fi
  echo ""

  echo "## Flagged Items (Require Manual Action)"
  echo ""
  local flagged_items
  flagged_items=$(echo "$content" | jq -r '[.[] | select(.action == "flagged")] | .[] | "\(.feature)|\(.rule)|\(.path)|\(.message)"') || true

  if [[ -z "$flagged_items" ]]; then
    echo "None."
  else
    echo "| Feature | Rule | Path | Message |"
    echo "|---------|------|------|---------|"
    while IFS='|' read -r feature rule path message; do
      echo "| $feature | $rule | $path | $message |"
    done <<< "$flagged_items"
  fi
  echo ""

  echo "## Warnings"
  echo ""
  local warnings
  warnings=$(echo "$content" | jq -r '[.[] | select(.level == "warning")] | group_by(.feature) | .[] | {feature: .[0].feature, count: length, message: .[0].message} | "\(.feature)|\(.count)|\(.message)"') || true

  if [[ -z "$warnings" ]]; then
    echo "None."
  else
    echo "| Feature | Count | Message |"
    echo "|---------|-------|---------|"
    while IFS='|' read -r feature count message; do
      echo "| $feature | $count | $message |"
    done <<< "$warnings"
  fi
  echo ""

  # Single pass for errors
  local error_output
  error_output=$(echo "$content" | jq -r '[.[] | select(.level == "error")] | if length > 0 then .[] | "- **\(.feature)** (\(.rule)): \(.message) [path: \(.path)]" else empty end') || true
  if [[ -n "$error_output" ]]; then
    echo "## Errors"
    echo ""
    echo "$error_output"
    echo ""
  fi
}

if [[ -n "$OUTPUT" ]]; then
  tmp_output=$(mktemp)
  trap 'rm -f "$tmp_output"' EXIT INT TERM
  generate_report "$DIAGNOSTICS" > "$tmp_output"
  mv "$tmp_output" "$OUTPUT"
  echo "Report written to: $OUTPUT"
else
  generate_report "$DIAGNOSTICS"
fi
