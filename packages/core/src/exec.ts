import { spawn, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { StepResult } from './types.js';

/** Cap captured output so a pathological build log cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface ExecOptions {
  cwd: string;
  name?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Package managers are .cmd shims on Windows, which only cmd.exe can run, so
 * there every command goes through it. cmd.exe parses the line, and a shim
 * parses its arguments again through %*; rather than escape correctly for both
 * passes, arguments are limited to characters neither treats specially. Every
 * argv Texugo builds (flags, script names, name@version specs) fits.
 */
const CMD_SAFE_ARG = /^[\w@+=:.~/\\-]+$/;

/** Env lookup that ignores case, as Windows does: PATH is often spelled "Path". */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const match = Object.keys(env).find((candidate) => candidate.toUpperCase() === key);
  return match === undefined ? undefined : env[match];
}

/**
 * Whether cmd.exe would find `command`: in the working directory first, then
 * on PATH, with or without a PATHEXT extension. Checked up front because
 * cmd.exe reports a missing command as exit 1 with a localised message, which
 * is indistinguishable from a command that ran and failed. Texugo only runs
 * programs, never cmd.exe built-ins, so a file must exist.
 */
function findsOnWindows(command: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  const extensions = ['', ...(envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')];
  const dirs = /[\\/]/.test(command)
    ? ['']
    : [cwd, ...(envValue(env, 'PATH') ?? '').split(';')].filter(Boolean);
  return dirs.some((dir) =>
    extensions.some((ext) => statSync(join(dir, command + ext), { throwIfNoEntry: false })?.isFile()),
  );
}

function append(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return (current + chunk).slice(0, MAX_OUTPUT_BYTES);
}

/**
 * Run a command and capture its result. Never rejects — a failure to spawn is
 * reported as a StepResult with exitCode -1, so callers can treat "the command
 * does not exist" and "the command failed" the same way.
 */
export function exec(argv: string[], options: ExecOptions): Promise<StepResult> {
  const [command, ...args] = argv;
  const name = options.name ?? command ?? 'exec';
  const display = argv.join(' ');
  const started = Date.now();

  const notRun = (reason: string): Promise<StepResult> =>
    Promise.resolve({
      name,
      command: display,
      exitCode: -1,
      signal: null,
      stdout: '',
      stderr: reason,
      durationMs: 0,
      timedOut: false,
      ok: false,
    });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    // Keep package managers terse and non-interactive inside probes.
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ADBLOCK: '1',
    ...options.env,
  };

  if (!command) return notRun('empty command');
  if (IS_WINDOWS) {
    const unsafe = argv.find((arg) => !CMD_SAFE_ARG.test(arg));
    if (unsafe !== undefined) return notRun(`refusing to pass this argument through cmd.exe: ${unsafe}`);
    if (!findsOnWindows(command, options.cwd, env)) return notRun(`spawn ${command} ENOENT`);
  }

  return new Promise<StepResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    // One command string, not an args array: Node joins args unescaped under
    // shell: true and deprecates doing so (DEP0190).
    const child = IS_WINDOWS
      ? spawn(display, { ...spawnOptions, shell: true })
      : spawn(command, args, { ...spawnOptions, shell: false });

    // On Windows the child is cmd.exe; killing only it orphans the real process,
    // which keeps the pipes open, so the step would never settle.
    const kill = (): void => {
      if (IS_WINDOWS && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
          'error',
          () => undefined,
        );
      } else {
        child.kill('SIGKILL');
      }
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : null;

    child.stdout?.on('data', (buf: Buffer) => {
      stdout = append(stdout, buf.toString('utf8'));
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr = append(stderr, buf.toString('utf8'));
    });

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        name,
        command: display,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        ok: !timedOut && exitCode === 0,
      });
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      stderr = append(stderr, `\n${err.message}`);
      settle(-1, null);
    });
    child.on('close', (code, signal) => settle(code, signal));
  });
}
