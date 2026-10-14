import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { exec } from './exec.js';

const onWindows = process.platform === 'win32';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Killing is asynchronous on every platform; give it a few seconds. */
async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return false;
}

describe('exec', () => {
  let cwd = '';

  // Scripts live in files and are passed by relative name: inline `node -e`
  // code and absolute temp paths can hold characters exec refuses on Windows.
  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'texugo-exec-test-'));
    await writeFile(join(cwd, 'exit-3.js'), 'process.exit(3);\n');
    await writeFile(join(cwd, 'echo-args.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    await writeFile(join(cwd, 'hang.js'), 'setTimeout(() => {}, 120000);\n');
    // What `npm run test` looks like from outside: a process whose child
    // outlives it unless killed too, holding the inherited stdout pipe.
    await writeFile(
      join(cwd, 'spawn-hang.js'),
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['hang.js'], { stdio: 'inherit' });",
        "require('node:fs').writeFileSync(process.argv[2], String(child.pid));",
        'setTimeout(() => {}, 120000);',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(cwd, 'exit-mid-step.mjs'),
      [
        `import { exec } from ${JSON.stringify(new URL('./exec.js', import.meta.url).href)};`,
        "exec(['node', 'spawn-hang.js', 'exit.pid'], { cwd: process.cwd(), timeoutMs: 60000 });",
        'setTimeout(() => process.exit(0), 1000);',
        '',
      ].join('\n'),
    );
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

  test('kills the children of a step that outlives its timeout', { timeout: 30_000 }, async () => {
    const result = await exec(['node', 'spawn-hang.js', 'timeout.pid'], { cwd, timeoutMs: 1000 });
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs < 15_000, `settled after ${result.durationMs}ms`);
    const grandchild = Number(await readFile(join(cwd, 'timeout.pid'), 'utf8'));
    assert.ok(await waitForExit(grandchild), `grandchild ${grandchild} is still running`);
  });

  // Steps run in their own process group on POSIX, out of reach of the
  // terminal's Ctrl+C, so exiting must take them down. Windows keeps steps in
  // the console's group, where Ctrl+C still reaches them.
  test(
    'kills running steps when the process exits',
    { skip: onWindows, timeout: 30_000 },
    async () => {
      await promisify(execFile)(process.execPath, ['exit-mid-step.mjs'], { cwd });
      const grandchild = Number(await readFile(join(cwd, 'exit.pid'), 'utf8'));
      assert.ok(await waitForExit(grandchild), `grandchild ${grandchild} is still running`);
    },
  );

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
