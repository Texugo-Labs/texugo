import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { exec } from './exec.js';
import type { ProjectInfo, Sandbox, StepResult } from './types.js';

/**
 * Directories never copied into a sandbox. node_modules is excluded because
 * every probe installs its own; the rest are build output that would mask a
 * genuine build failure by making a stale artifact look like a fresh one.
 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.texugo',
]);

function isExcluded(root: string, src: string): boolean {
  const rel = relative(root, src);
  if (!rel || rel.startsWith('..')) return false;
  return rel.split(sep).some((segment) => EXCLUDED_DIRS.has(segment));
}

export interface SandboxOptions {
  /** Where to create sandboxes. Defaults to the OS temp dir. */
  baseDir?: string;
  /** Default timeout applied to every command run in the sandbox. */
  timeoutMs?: number;
}

/**
 * Copy the project into an isolated directory. The copy includes uncommitted
 * work — a dev tool that only tested HEAD would answer a question nobody asked.
 */
export async function createSandbox(
  project: ProjectInfo,
  id: string,
  options: SandboxOptions = {},
): Promise<Sandbox> {
  const base = options.baseDir ?? tmpdir();
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48);
  const dir = await mkdtemp(join(base, `texugo-${safeId}-`));

  await cp(project.root, dir, {
    recursive: true,
    dereference: false,
    force: true,
    filter: (src) => !isExcluded(project.root, src),
  });

  let disposed = false;
  const pkgPath = join(dir, 'package.json');

  return {
    id,
    dir,
    project,

    exec(argv: string[], opts: { name?: string; timeoutMs?: number } = {}): Promise<StepResult> {
      return exec(argv, {
        cwd: dir,
        name: opts.name,
        timeoutMs: opts.timeoutMs ?? options.timeoutMs,
      });
    },

    async readPackageJson(): Promise<Record<string, unknown>> {
      return JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>;
    },

    async writePackageJson(pkg: Record<string, unknown>): Promise<void> {
      await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
