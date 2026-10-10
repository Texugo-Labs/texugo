import { spawn } from 'node:child_process';
import type { StepResult } from './types.js';

/** Cap captured output so a pathological build log cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface ExecOptions {
  cwd: string;
  name?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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

  if (!command) {
    return Promise.resolve({
      name,
      command: display,
      exitCode: -1,
      signal: null,
      stdout: '',
      stderr: 'empty command',
      durationMs: 0,
      timedOut: false,
      ok: false,
    });
  }

  return new Promise<StepResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        CI: '1',
        // Keep package managers terse and non-interactive inside probes.
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        ADBLOCK: '1',
        ...options.env,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
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
