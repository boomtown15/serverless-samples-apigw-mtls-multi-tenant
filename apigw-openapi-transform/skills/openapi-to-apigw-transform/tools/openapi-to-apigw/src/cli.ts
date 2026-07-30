#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { resolve, basename, join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { parseSpec, discoverSpecs, serializeSpec } from './parser.js';
import { analyzeSpec } from './analyzer.js';
import { createDiagnostics, formatDiagnosticsSummary, formatWarningsAndErrors } from './diagnostics.js';
import { runPipeline } from './pipeline.js';
import { validate } from './validator.js';
import { generateSamTemplate, generateAuthorizerTemplate } from './generators/sam-template.js';
import { generateDeployScript } from './generators/deploy-script.js';
import type { SpecDeployInfo } from './generators/deploy-script.js';
import { buildBreakingChanges } from './generators/breaking-changes.js';
import type { TransformOptions } from './types.js';

const program = new Command();

program
  .name('openapi-to-apigw')
  .description('Convert OpenAPI specs to Amazon API Gateway-compatible specs with SAM templates')
  .version('1.0.0');

program
  .command('transform')
  .description('Transform OpenAPI spec(s) for API Gateway compatibility')
  .argument('<input>', 'Path to an OpenAPI spec file or directory of specs')
  .option('--output-dir <dir>', 'Output directory')
  .option('--region <region>', 'AWS region for deploy.sh', 'us-east-1')
  .option('--stage <name>', 'Stage name', 'test')
  .option('--format <format>', 'Output format (yaml|json)', 'yaml')
  .option('--runtime <runtime>', 'Lambda runtime', 'python3.12')
  .option('--verbose', 'Print diagnostics to stdout', false)
  .option('--json', 'Output diagnostics as JSON to stdout', false)
  .option('--fail-on <level>', 'Exit 2 if diagnostics at or above <level> are emitted. Values: never | breaking | warning', 'breaking')
  .option('--resources-per-api-limit <n>', 'Configured APIGW \'Resources per API\' quota (min 300). Values < 300 are clamped to 300.', parseIntegerOption, 300)
  .option('--stack-prefix <prefix>', 'Prefix to prepend to CloudFormation stack names in deploy.sh (e.g. "gapscanv3"). Can also be set/overridden at deploy time via the STACK_PREFIX env var.', '')
  .action(async (input: string, opts: Record<string, any>) => {
    try {
      const failOn = String(opts.failOn).toLowerCase();
      if (!['never', 'breaking', 'warning'].includes(failOn)) {
        console.error(`--fail-on must be one of: never, breaking, warning (got '${opts.failOn}')`);
        process.exit(1);
      }

      const inputPath = resolve(input);
      const specFiles = discoverSpecs(inputPath);

      if (specFiles.length === 0) {
        console.error(`No OpenAPI spec files found at: ${inputPath}`);
        process.exit(1);
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const outputDir = resolve(opts.outputDir ?? `atx-gen-templates-${timestamp}`);
      mkdirSync(outputDir, { recursive: true });

      const options: TransformOptions = {
        region: opts.region,
        stage: opts.stage,
        format: opts.format,
        runtime: opts.runtime,
        outputDir,
        verbose: opts.verbose,
        stackPrefix: opts.stackPrefix ?? '',
      };

      console.log(`Processing ${specFiles.length} spec file(s)...`);

      const requestedLimit = Number(opts.resourcesPerApiLimit ?? 300);
      const configuredLimit = Math.max(300, requestedLimit);
      const limitWasClamped = requestedLimit < 300;

      const specDeployInfos: SpecDeployInfo[] = [];
      let allPassed = true;

      // Accumulators for batch mode
      const allDiagnostics: any[] = [];
      const allAnalyses: any[] = [];
      const allValidations: any[] = [];

      for (const specFile of specFiles) {
        const specName = basename(specFile).replace(/\.(yaml|yml|json)$/i, '');
        console.log(`\n--- ${specName} ---`);

        // Parse
        const spec = parseSpec(specFile);

        // Analyze
        const analysis = analyzeSpec(spec, specFile);
        allAnalyses.push(analysis);
        console.log(`  Source: ${analysis.pathCount} paths, ${analysis.operationCount} ops, ${analysis.schemaCount} schemas`);

        // Transform
        const diag = createDiagnostics();
        if (limitWasClamped) {
          diag.info('cli', '#/options/resources-per-api-limit', 'resources-per-api-limit-clamped', 'flagged',
            `--resources-per-api-limit value ${requestedLimit} is below the AWS default quota of 300; clamped to 300.`);
        }
        const cleaned = runPipeline(spec, diag, undefined, { sourceFilePath: specFile });

        // Validate
        const validationResult = validate(cleaned, analysis, diag, { resourcesPerApiLimit: configuredLimit });
        allValidations.push(validationResult);

        if (!validationResult.pass) {
          console.error(`  VALIDATION FAILED:`);
          for (const check of validationResult.checks.filter(c => !c.pass)) {
            console.error(`    ${check.name}: expected=${check.expected}, actual=${check.actual}`);
          }
          allPassed = false;
        } else {
          console.log(`  Validation: PASSED`);
        }

        // Write cleaned spec
        const format = options.format ?? 'yaml';
        const ext = format === 'json' ? 'json' : 'yaml';
        const cleanedFileName = `${specName}-cleaned.${ext}`;
        const cleanedFilePath = join(outputDir, cleanedFileName);
        writeFileSync(cleanedFilePath, serializeSpec(cleaned, format));
        console.log(`  Output: ${cleanedFileName}`);

        // Generate SAM template (always uses DefinitionUri)
        const samContent = generateSamTemplate(analysis, options);
        const samFileName = `${specName}.sam.yaml`;
        const samFilePath = join(outputDir, samFileName);
        writeFileSync(samFilePath, samContent);
        console.log(`  Template: ${samFileName}`);

        // Generate authorizer template if needed
        const authContent = generateAuthorizerTemplate(analysis, options);
        let authFileName: string | null = null;
        if (authContent) {
          authFileName = `${specName}-auth.sam.yaml`;
          const authFilePath = join(outputDir, authFileName);
          writeFileSync(authFilePath, authContent);
          console.log(`  Authorizer template: ${authFileName}`);
        }

        specDeployInfos.push({
          apiTemplate: samFileName,
          cleanedSpec: cleanedFileName,
          authorizerTemplate: authFileName,
        });

        // Accumulate diagnostics with file context
        for (const entry of diag.entries) {
          allDiagnostics.push({ ...entry, file: specName });
        }

        if (opts.verbose) {
          console.log('\n' + formatDiagnosticsSummary(diag.entries));
        } else {
          const warnings = formatWarningsAndErrors(diag.entries);
          if (warnings) console.log('\n' + warnings);
        }

        if (opts.json) {
          console.log(JSON.stringify(diag.entries));
        }
      }

      // Write accumulated artifacts
      writeFileSync(join(outputDir, 'diagnostics.json'), JSON.stringify(allDiagnostics, null, 2));
      writeFileSync(join(outputDir, 'source-analysis.json'), JSON.stringify(
        allAnalyses.length === 1 ? allAnalyses[0] : allAnalyses, null, 2));
      writeFileSync(join(outputDir, 'validation-summary.json'), JSON.stringify(
        allValidations.length === 1 ? allValidations[0] : allValidations, null, 2));

      // Generate deploy.sh
      const deployScript = generateDeployScript(specDeployInfos, options);
      const deployPath = join(outputDir, 'deploy.sh');
      writeFileSync(deployPath, deployScript);
      chmodSync(deployPath, 0o755);
      console.log(`\nDeploy script: ${deployPath}`);

      console.log(`\nOutput directory: ${outputDir}`);

      const breakingChanges = buildBreakingChanges(allDiagnostics, { configuredLimit });
      writeFileSync(join(outputDir, 'breaking-changes.json'), JSON.stringify(breakingChanges, null, 2));

      printTriageSummary(allDiagnostics);

      const hasBreaking = allDiagnostics.some((e: any) => e.level === 'breaking');
      const hasWarning = allDiagnostics.some((e: any) => e.level === 'warning');
      const shouldFailOnBreaking = failOn === 'breaking' && hasBreaking;
      const shouldFailOnWarning = failOn === 'warning' && (hasBreaking || hasWarning);
      if (shouldFailOnBreaking || shouldFailOnWarning) {
        process.exit(2);
      }

      // Validation failure is treated as exit 1 only when not already explained by
      // breaking diagnostics. When breaking diagnostics are present the validation
      // mismatches (e.g. path-count) are downstream effects — the breaking diagnostic
      // is the operator-actionable signal and --fail-on governs the exit code.
      if (!allPassed && !hasBreaking) {
        console.error('\nSome validations FAILED. Review diagnostics.json for details.');
        process.exit(1);
      }

      console.log('\nDone.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nERROR processing spec "${input}": ${msg}`);
      process.exit(1);
    }
  });

function parseIntegerOption(raw: string): number {
  // Reject non-integer and negative values. AWS quota values are non-negative;
  // negative input is nonsensical and should fail at parse time rather than
  // silently getting clamped to the 300 floor.
  if (!/^\d+$/.test(raw)) {
    throw new InvalidArgumentError(`must be a non-negative integer, got '${raw}'`);
  }
  return Number(raw);
}

function printTriageSummary(allEntries: any[]): void {
  const byLevelAndFeature = (level: string) => {
    const counts = new Map<string, number>();
    for (const e of allEntries) {
      if (e.level !== level) continue;
      counts.set(e.feature, (counts.get(e.feature) ?? 0) + 1);
    }
    return counts;
  };

  const breaking = byLevelAndFeature('breaking');
  const warnings = byLevelAndFeature('warning');
  const breakingTotal = [...breaking.values()].reduce((a, b) => a + b, 0);
  const warningTotal = [...warnings.values()].reduce((a, b) => a + b, 0);

  if (breaking.size > 0) {
    console.log(`\nBREAKING CHANGES (${breaking.size} groups, ${breakingTotal} entries):`);
    for (const [feature, count] of breaking) {
      console.log(`  [${feature}] ${count} entries`);
    }
  }
  if (warnings.size > 0) {
    console.log(`\nWARNINGS (${warnings.size} groups, ${warningTotal} entries):`);
    for (const [feature, count] of warnings) {
      console.log(`  [${feature}] ${count} entries`);
    }
  }
  if (breaking.size > 0) {
    console.log(`\nSee breaking-changes.json for remediation details.`);
  }
}

program.parse();
