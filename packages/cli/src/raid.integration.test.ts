import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { failureReason, type RaidReport } from '@texugolabs/raid';

const BIN = fileURLToPath(new URL('./bin.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/raid/', import.meta.url));

/** Every file under `root` by relative path and content hash, so a stray file fails too. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(root, path)] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  return files;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

let workDir = '';

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'texugo-integration-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// Hits the real registry and does a cold install per probe, so it is opt-in.
// Versions are not pinned: chalk and semver publish new majors, and every
// assertion holds for any that appear.
test(
  'raid reports chalk breaking and semver 7 passing, without touching the project',
  {
    skip: process.env.TEXUGO_INTEGRATION !== '1' && 'set TEXUGO_INTEGRATION=1 to run (needs network)',
    timeout: 20 * 60_000,
  },
  async () => {
    const original = await snapshot(FIXTURE);
    const reportPath = join(workDir, 'report.json');

    const run = await runCli(['raid', '--cwd', FIXTURE, '--json', reportPath]);
    const output = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
    assert.equal(run.code, 0, output);

    const report = JSON.parse(await readFile(reportPath, 'utf8')) as RaidReport;
    assert.equal(report.baseline?.status, 'passed', output);

    // An errored probe is the harness failing (usually the network), not a
    // verdict on the upgrade; name it rather than letting it read as BREAKS.
    const errored = report.results.filter((result) => result.status === 'errored');
    assert.deepEqual(
      errored.map((result) => `${result.label}: ${failureReason(result)}`),
      [],
    );

    const named = (name: string) =>
      report.results.filter((result) => (result.meta ?? {}).name === name);

    // chalk 5 and 6 both exist: fewer than two means a major went unprobed.
    const chalk = named('chalk');
    assert.ok(chalk.length >= 2, `expected every chalk major to be probed, got ${chalk.length}`);
    for (const result of chalk) {
      assert.equal(result.status, 'failed', result.label);
      assert.equal(result.failedStep, 'test', result.label);
      // Node 22.12+ can require() an ES module, so the call fails instead;
      // older 22.x refuses the require itself.
      assert.match(failureReason(result), /chalk\.green is not a function|ERR_REQUIRE_ESM/, result.label);
    }

    const semver7 = named('semver').find((result) => (result.meta ?? {}).targetMajor === 7);
    assert.ok(semver7, 'expected a semver 6 -> 7 probe');
    assert.equal(semver7.status, 'passed', failureReason(semver7));

    assert.deepEqual(await snapshot(FIXTURE), original, 'raid wrote to the project directory');
  },
);
