import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { exec } from './exec.js';

const onWindows = process.platform === 'win32';

describe('exec', () => {
  let cwd = '';

  // Scripts live in files and are passed by relative name: inline `node -e`
  // code and absolute temp paths can hold characters exec refuses on Windows.
  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'texugo-exec-test-'));
    await writeFile(join(cwd, 'exit-3.js'), 'process.exit(3);\n');
    await writeFile(join(cwd, 'echo-args.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    await writeFile(join(cwd, 'hang.js'), 'setTimeout(() => {}, 120000);\n');
  });

  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test('reports the exit code of a command that ran', async () => {
    const result = await exec(['node', 'exit-3.js'], { cwd, name: 'test' });
    assert.equal(result.exitCode, 3);
    assert.equal(result.ok, false);
    assert.equal(result.name, 'test');
  });

  test('runs a package manager, which is a .cmd shim on Windows', async () => {
    const result = await exec(['npm', '--version'], { cwd });
    assert.equal(result.ok, true, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  test('passes the arguments raid builds through unchanged', async () => {
    const args = ['@scope/pkg@1.2.3', '--save-prod', '--reporter=append-only', 'C:\\dir\\file', 'a/b'];
    const result = await exec(['node', 'echo-args.js', ...args], { cwd });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  });

  test('resolves a command that does not exist with exitCode -1', async () => {
    const result = await exec(['texugo-no-such-command'], { cwd });
    assert.equal(result.exitCode, -1);
    assert.equal(result.ok, false);
  });

  test('kills a step that outlives its timeout', { timeout: 30_000 }, async () => {
    const result = await exec(['node', 'hang.js'], { cwd, timeoutMs: 500 });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.ok(result.durationMs < 15_000, `settled after ${result.durationMs}ms`);
  });

  describe('on Windows, where commands run through cmd.exe', { skip: !onWindows }, () => {
    for (const arg of ['x&echo injected', 'a|b', '%PATH%', 'two words', '"quoted"', 'a^b', 'a>out.txt', 'a(b)']) {
      test(`refuses ${JSON.stringify(arg)} instead of letting cmd.exe interpret it`, async () => {
        const result = await exec(['node', 'echo-args.js', arg], { cwd });
        assert.equal(result.exitCode, -1);
        assert.equal(result.ok, false);
        assert.ok(result.stderr.includes(arg), result.stderr);
        assert.doesNotMatch(result.stdout, /injected/);
      });
    }
  });
});
