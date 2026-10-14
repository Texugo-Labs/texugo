import { BASELINE_ID, type ProbeResult } from '@texugolabs/core';
import type { RaidPlan } from './plan.js';

const SYMBOL: Record<ProbeResult['status'], string> = {
  passed: 'ok',
  failed: 'BREAKS',
  errored: 'error',
};

/**
 * Every CSI sequence, not only colours: spinners also emit erase-line, cursor
 * and visibility codes, which would move the cursor if they reached the matrix.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Lines that are never the reason, however error-adjacent they look: stack
 * frames, the caret under a source line, Node's version trailer, a passing
 * test's tick, the package manager's banner and its echo of the script it is
 * about to run (`> pkg@1.0.0 test` from npm and pnpm, `$ node test.js` from
 * yarn and bun), and its "the script you ran failed" epilogue, which restates
 * the failure without naming it. yarn and bun spell that epilogue as an error,
 * so without these it wins every bare non-zero exit. npm prefixes its lines
 * `npm ERR!` in older releases and `npm error` in current ones (10.9, bundled
 * with Node 22).
 */
const NOISE: RegExp[] = [
  /^Node\.js v\d/,
  /^at\s/,
  /^\^+$/,
  /^(✔|✓|√)\s/,
  /^> /,
  /^\$ /,
  /^(yarn|bun) \w+ v\d/,
  /^info Visit https:\/\/yarnpkg\.com\//,
  /^npm (notice|warn)/i,
  /^npm (ERR!|error) (code |errno |path |command |A complete log)/i,
  /^(ELIFECYCLE|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL)/,
  /^(error )?Command failed with exit code/i,
  /^error: script ".*" exited with code/,
  /^\s*$/,
];

/**
 * Ordered by how specific the signal is. The first pattern that matches a
 * non-noise line wins, so a concrete `TypeError: x is not a function` beats a
 * generic line containing the word "failed" further up the log.
 */
const SIGNALS: RegExp[] = [
  /\b\w*Error\b.*:/,
  /\bERR_[A-Z0-9_]+\b/,
  /\berror\s+TS\d{4}\b/i,
  /cannot find (module|package|name)/i,
  /is not a function|is not assignable|has no exported member/i,
  /\bnpm ERR!/,
  /^(✖|×|FAIL\b)/,
  /\berror\b/i,
  /\bfailed\b/i,
];

/**
 * Pull a one-line reason out of a failed step. Build tools scatter the useful
 * line across streams and depths, so this scores lines by signal strength
 * rather than taking the first or last thing printed.
 */
export function failureReason(result: ProbeResult): string {
  if (result.error) return clip(result.error.split('\n', 1)[0] ?? '');
  // An optional step can fail without failing the probe; the reason belongs to
  // the step that did.
  const step =
    result.steps.find((candidate) => !candidate.ok && candidate.name === result.failedStep) ??
    result.steps.find((candidate) => !candidate.ok);
  if (!step) return 'unknown';
  if (step.timedOut) return `${step.name} timed out`;

  const lines = `${step.stderr}\n${step.stdout}`
    .split(/\r?\n/)
    // A bare carriage return redraws the line: keep what the terminal last showed.
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(ANSI, '').trim())
    .filter((line) => line.length > 0 && !NOISE.some((pattern) => pattern.test(line)));

  let chosen: string | undefined;
  for (const signal of SIGNALS) {
    chosen = lines.find((line) => signal.test(line));
    if (chosen) break;
  }

  // Nothing looked like an error: the last surviving line is the best guess.
  const ended = step.signal ? `killed by ${step.signal}` : `exited ${step.exitCode ?? 'abnormally'}`;
  chosen ??= lines.at(-1) ?? `${step.name} ${ended}`;

  return clip(chosen);
}

function clip(line: string): string {
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** Render the result matrix as an aligned plain-text table. */
export function renderMatrix(results: ProbeResult[]): string {
  const rows = results.filter((result) => result.mutationId !== BASELINE_ID);
  if (rows.length === 0) return 'No upgrade candidates were probed.';

  const table = rows.map((result) => {
    const meta = (result.meta ?? {}) as Record<string, unknown>;
    return {
      dependency: String(meta.name ?? result.group ?? result.mutationId),
      from: String(meta.currentMajor ?? '?'),
      to: String(meta.targetVersion ?? meta.targetMajor ?? '?'),
      status: SYMBOL[result.status],
      detail:
        result.status === 'passed'
          ? ''
          : `${result.failedStep ? `${result.failedStep}: ` : ''}${failureReason(result)}`,
    };
  });

  const widths = {
    dependency: Math.max(10, ...table.map((row) => row.dependency.length)),
    from: Math.max(4, ...table.map((row) => row.from.length)),
    to: Math.max(2, ...table.map((row) => row.to.length)),
    status: Math.max(6, ...table.map((row) => row.status.length)),
  };

  const lines: string[] = [];
  lines.push(
    [
      pad('DEPENDENCY', widths.dependency),
      pad('FROM', widths.from),
      pad('TO', widths.to),
      pad('RESULT', widths.status),
    ].join('  '),
  );

  for (const row of table) {
    const line = [
      pad(row.dependency, widths.dependency),
      pad(row.from, widths.from),
      pad(row.to, widths.to),
      pad(row.status, widths.status),
    ].join('  ');
    lines.push(row.detail ? `${line}  ${row.detail}` : line);
  }

  return lines.join('\n');
}

/** Short summary line: how many majors are safe to take today. */
export function renderSummary(results: ProbeResult[]): string {
  const rows = results.filter((result) => result.mutationId !== BASELINE_ID);
  const passed = rows.filter((result) => result.status === 'passed').length;
  const failed = rows.filter((result) => result.status === 'failed').length;
  const errored = rows.filter((result) => result.status === 'errored').length;

  const parts = [`${passed} safe`, `${failed} breaking`];
  if (errored > 0) parts.push(`${errored} could not be probed`);
  const noun = rows.length === 1 ? 'major bump' : 'major bumps';
  return `${rows.length} ${noun} probed: ${parts.join(', ')}.`;
}

export interface RaidReport {
  tool: 'raid';
  version: 1;
  generatedAt: string;
  project: { name: string; packageManager: string };
  baseline: ProbeResult | null;
  skipped: RaidPlan['skipped'];
  results: ProbeResult[];
}

/**
 * Build the machine-readable report. Step output is dropped for passing probes
 * and truncated for failing ones — the file is meant to be committed or posted
 * to a PR, not to carry a megabyte of install chatter.
 */
export function buildReport(
  project: { name: string; packageManager: string },
  results: ProbeResult[],
  skipped: RaidPlan['skipped'],
): RaidReport {
  const trim = (result: ProbeResult): ProbeResult => ({
    ...result,
    steps: result.steps.map((step) => ({
      ...step,
      stdout: step.ok ? '' : step.stdout.slice(-4000),
      stderr: step.ok ? '' : step.stderr.slice(-4000),
    })),
  });

  return {
    tool: 'raid',
    version: 1,
    generatedAt: new Date().toISOString(),
    project,
    baseline: results.find((result) => result.mutationId === BASELINE_ID)
      ? trim(results.find((result) => result.mutationId === BASELINE_ID)!)
      : null,
    skipped,
    results: results
      .filter((result) => result.mutationId !== BASELINE_ID)
      .map(trim),
  };
}
