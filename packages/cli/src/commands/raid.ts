import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BASELINE_ID,
  defaultPipeline,
  detectProject,
  runProbe,
  runProbes,
  type ProbeResult,
} from '@texugolabs/core';
import {
  buildRaidPlan,
  buildReport,
  createUpgradeMutation,
  failureReason,
  renderMatrix,
  renderSummary,
} from '@texugolabs/raid';
import { bold, cyan, dim, green, paintMatrix, red, yellow } from '../ui.js';

export const RAID_HELP = `${bold('texugo raid')} — which major version bumps does this project survive?

Spawns an isolated sandbox per candidate major, installs it, and runs your own
build and test scripts. Nothing is written to your working tree.

${bold('Usage')}
  texugo raid [options]

${bold('Options')}
  --only <names>        Comma-separated dependencies to probe (default: all)
  --exclude <names>     Comma-separated dependencies to skip
  --prod-only           Ignore devDependencies
  --latest-only         Probe only the newest major, not every major in between
  --concurrency <n>     Sandboxes to run at once (default: 2)
  --timeout <seconds>   Per-step timeout (default: 600)
  --json <file>         Write the full machine-readable report
  --skip-baseline       Do not verify the project is green before probing
  --fail-on-break       Exit 1 if any probed major breaks
  --keep-sandboxes      Leave sandboxes on disk for inspection
  --cwd <dir>           Project root (default: current directory)
  -h, --help            Show this help

${bold('Examples')}
  texugo raid --only react,react-dom
  texugo raid --latest-only --concurrency 4 --json raid-report.json
`;

function plural(count: number, singular: string, pluralForm?: string): string {
  const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${count} ${word}`;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function raidCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      only: { type: 'string' },
      exclude: { type: 'string' },
      'prod-only': { type: 'boolean', default: false },
      'latest-only': { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      json: { type: 'string' },
      'skip-baseline': { type: 'boolean', default: false },
      'fail-on-break': { type: 'boolean', default: false },
      'keep-sandboxes': { type: 'boolean', default: false },
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${RAID_HELP}\n`);
    return 0;
  }

  const concurrency = Number(values.concurrency ?? 2);
  const stepTimeoutMs = Number(values.timeout ?? 600) * 1000;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    process.stderr.write(`${red('error')}: --concurrency must be a positive number\n`);
    return 2;
  }
  if (!Number.isFinite(stepTimeoutMs) || stepTimeoutMs <= 0) {
    process.stderr.write(`${red('error')}: --timeout must be a positive number of seconds\n`);
    return 2;
  }

  const project = await detectProject(values.cwd ?? process.cwd());
  const pipeline = defaultPipeline(project);

  process.stdout.write(
    `${bold(project.name)} ${dim(`(${project.packageManager})`)}\n` +
      `${dim(`verifying with: ${pipeline.steps.map((step) => step.name).join(', ') || 'install only'}`)}\n\n`,
  );

  if (pipeline.steps.length === 0) {
    process.stdout.write(
      `${yellow('note')}: no build or test script found — probes will only check that the install resolves.\n\n`,
    );
  }

  // 1. Plan.
  process.stdout.write(`${dim('Checking the registry for newer majors...')}\n`);
  const plan = await buildRaidPlan(project, {
    only: splitList(values.only),
    exclude: splitList(values.exclude),
    prodOnly: values['prod-only'] === true,
    latestOnly: values['latest-only'] === true,
  });

  if (plan.candidates.length === 0) {
    process.stdout.write(`\n${green('Nothing to raid')} — every dependency is on its newest major.\n`);
    return 0;
  }

  const dependencies = new Set(plan.candidates.map((candidate) => candidate.name));
  process.stdout.write(
    `${dim(
      `${plural(plan.candidates.length, 'major bump')} across ${plural(dependencies.size, 'dependency', 'dependencies')}\n`,
    )}\n`,
  );

  // 2. Baseline. Without a green baseline, every failure below is unattributable.
  const results: ProbeResult[] = [];
  if (!values['skip-baseline']) {
    process.stdout.write(`${cyan('baseline')} ${dim('installing and verifying unchanged project...')}\n`);
    const baseline = await runProbe(project, null, {
      pipeline,
      stepTimeoutMs,
      keepSandbox: values['keep-sandboxes'] === true,
    });
    results.push(baseline);

    if (baseline.status !== 'passed') {
      process.stdout.write(
        `\n${red('Baseline failed')} at ${bold(baseline.failedStep ?? 'setup')}: ${failureReason(baseline)}\n` +
          `${dim('The project does not pass its own checks unchanged, so upgrade failures could not be attributed.')}\n` +
          `${dim('Fix the baseline, or re-run with --skip-baseline to probe anyway.')}\n`,
      );
      return 2;
    }
    process.stdout.write(`${green('baseline ok')}\n\n`);
  }

  // 3. Raid.
  const mutations = plan.candidates.map((candidate) =>
    createUpgradeMutation(project, candidate),
  );

  let completed = 0;
  const probeResults = await runProbes(project, mutations, {
    pipeline,
    concurrency,
    stepTimeoutMs,
    keepSandbox: values['keep-sandboxes'] === true,
    onResult: (result) => {
      completed += 1;
      const mark =
        result.status === 'passed' ? green('ok') : result.status === 'failed' ? red('BREAKS') : yellow('error');
      process.stdout.write(
        `${dim(`[${completed}/${mutations.length}]`)} ${result.label} ${mark}\n`,
      );
    },
  });
  results.push(...probeResults);

  // 4. Report.
  process.stdout.write(`\n${paintMatrix(renderMatrix(results))}\n\n`);
  process.stdout.write(`${renderSummary(results)}\n`);

  if (plan.skipped.length > 0) {
    process.stdout.write(
      `${dim(`${plan.skipped.length} dependencies skipped (use --json to see why).`)}\n`,
    );
  }

  if (values.json) {
    const path = resolve(values.json);
    const report = buildReport(
      { name: project.name, packageManager: project.packageManager },
      results,
      plan.skipped,
    );
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${dim(`Report written to ${path}`)}\n`);
  }

  const broke = results.some(
    (result) => result.mutationId !== BASELINE_ID && result.status === 'failed',
  );
  return values['fail-on-break'] && broke ? 1 : 0;
}
