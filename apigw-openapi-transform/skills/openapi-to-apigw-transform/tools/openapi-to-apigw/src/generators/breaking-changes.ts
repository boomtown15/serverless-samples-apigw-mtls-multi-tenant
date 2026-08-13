import type { DiagnosticEntry } from '../types.js';

export interface BuildOptions {
  /** Configured APIGW resource limit used during validation, for remediation context. */
  configuredLimit?: number;
}

export interface BreakingChangeEntry {
  category: 'path-dropped' | 'resource-limit-exceeded' | 'auth-policy-merged' | 'auth-not-enforceable' | 'other-breaking';
  reason: string;
  specFile: string;
  path?: string;
  operations?: string[] | number;
  resourceCount?: number;
  configuredLimit?: number;
  defaultQuota?: number;
  limitType?: 'soft' | 'hard';
  quotaCode?: string;
  serviceQuotasUrl?: string;
  clientImpact: string;
  remediation: string;
}

const PATH_DROP_FEATURES = new Set([
  'embedded-path-param',
  'embedded-path-param-collision',
  'invalid-path-chars',
  'rpc-fragment-path-collision',
  'sibling-rename-collision',
]);

const CLIENT_IMPACT: Record<string, string> = {
  'embedded-path-param': 'Clients calling this URL will receive 404 after deployment.',
  'embedded-path-param-collision': 'Path removed due to collision with an existing sibling after auto-rewriting an embedded path param suffix. Clients calling this URL will receive 404 after deployment.',
  'invalid-path-chars': 'Clients calling this URL will receive 404 after deployment.',
  'rpc-fragment-path-collision': 'AWS JSON-RPC path dropped because the rewritten operation name collides with an existing REST-style path. Clients targeting this RPC operation will receive 404 after deployment.',
  'sibling-rename-collision': 'Clients calling this URL will receive 404 after deployment.',
};

const REMEDIATION: Record<string, string> = {
  'embedded-path-param': 'Split embedded params into separate path segments, e.g. /a/{x}/{y} rather than /a/{x}:{y}, and update client callers.',
  'embedded-path-param-collision': 'Rename the colliding sibling path in the source spec, or remove the suffixed variant, so the rewritten form does not conflict.',
  'invalid-path-chars': 'Rewrite the path to use only characters allowed by API Gateway (alphanumeric, underscores, hyphens, periods, commas, colons, curly braces). Client callers will need to be updated.',
  'rpc-fragment-path-collision': 'Rename or remove the conflicting REST-style sibling path in the source spec, or rename the RPC operation, so the rewritten /{Operation} form is unique.',
  'sibling-rename-collision': 'Rename or remove the conflicting sibling path in the source spec so the rename pass can produce a unique URL; alternatively drop the colliding operation from the source spec.',
};

/**
 * Build the structured `breaking-changes.json` payload from accumulated diagnostic entries.
 * Only `level === 'breaking'` entries contribute; warning-level entries are deliberately
 * excluded so agents can treat this file as "things that need operator review".
 */
export function buildBreakingChanges(
  entries: ReadonlyArray<DiagnosticEntry & { file?: string }>,
  options: BuildOptions = {},
): BreakingChangeEntry[] {
  const out: BreakingChangeEntry[] = [];

  for (const e of entries) {
    if (e.level !== 'breaking') continue;
    const specFile = e.file ?? 'unknown';

    if (PATH_DROP_FEATURES.has(e.feature)) {
      out.push({
        category: 'path-dropped',
        reason: e.feature,
        specFile,
        path: extractPathFromRef(e.path),
        clientImpact: CLIENT_IMPACT[e.feature] ?? 'Clients calling this URL will receive 404 after deployment.',
        remediation: REMEDIATION[e.feature] ?? 'Review the source spec and restore the path with an API Gateway-compatible form.',
      });
      continue;
    }

    if (e.rule === 'validator' && e.feature === 'resource-limit') {
      const orig = (e.original ?? {}) as { resourceCount?: number; configuredLimit?: number };
      const configuredLimit = orig.configuredLimit ?? options.configuredLimit ?? 300;
      const resourceCount = orig.resourceCount ?? parseResourceCount(e.message);
      out.push({
        category: 'resource-limit-exceeded',
        reason: 'resource-limit',
        specFile,
        resourceCount,
        configuredLimit,
        defaultQuota: 300,
        limitType: 'soft',
        quotaCode: 'L-01C8A9E0',
        serviceQuotasUrl: 'https://console.aws.amazon.com/servicequotas/home/services/apigateway/quotas/L-01C8A9E0',
        clientImpact: `Deployment will fail at the configured ${configuredLimit}-resource limit; CloudFormation import times out.`,
        remediation: 'Choose one (ordered by operator cost):\n'
          + '  1. Request a Service Quotas increase for \'Resources per API\' (code L-01C8A9E0). After the increase is granted, rerun with --resources-per-api-limit <new-value>; no spec change required.\n'
          + '  2. Consolidate similar paths under a `{proxy+}` resource and route requests inside a single Lambda. Reduces the resource count without a quota request.\n'
          + '  3. Split the spec into multiple APIs joined via a custom domain with base-path mappings. Most invasive; best when the API has natural domain boundaries.',
      });
      continue;
    }

    if (e.rule === 'security-schemes' && e.feature === 'apiKey/non-standard') {
      out.push({
        category: 'auth-not-enforceable',
        reason: e.feature,
        specFile,
        clientImpact: 'Operations using this scheme deploy with NO authentication — API Gateway cannot '
          + 'enforce the declared identity source, so requests are served without any credential check.',
        remediation: 'Attach a Lambda authorizer that reads the credential from a supported identity source '
          + '(a request header or query string) and update clients to send it there, or keep the API private '
          + 'until authentication is configured. Do not expose the deployed API as-is.',
      });
      continue;
    }

    if (e.rule === 'security-schemes' && (e.feature === 'multiple-authorizers' || e.feature === 'multiple-or-authorizers')) {
      // Reclassification currently leaves these at `warning`, so this branch is dormant
      // unless a future change upgrades them to breaking. Included per spec §6 for
      // forward compatibility.
      out.push({
        category: 'auth-policy-merged',
        reason: e.feature,
        specFile,
        clientImpact: 'None — HTTP auth surface unchanged.',
        remediation: 'Implement combined auth logic (all required schemes) within the single API Gateway authorizer.',
      });
      continue;
    }

    out.push({
      category: 'other-breaking',
      reason: e.feature,
      specFile,
      path: extractPathFromRef(e.path),
      clientImpact: 'See diagnostics.json for details.',
      remediation: e.message,
    });
  }

  return out;
}

function extractPathFromRef(path: string): string | undefined {
  const prefix = '#/paths/';
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function parseResourceCount(message: string): number | undefined {
  const m = message.match(/has (\d+) API Gateway resources/);
  return m ? Number(m[1]) : undefined;
}
