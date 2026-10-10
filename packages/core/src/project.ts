import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { PackageManager, ProjectInfo } from './types.js';

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Inspect a project directory. Throws if there is no package.json — every
 * Texugo tool needs one, and failing here produces a much clearer message
 * than failing three steps later inside a sandbox.
 */
export async function detectProject(root = process.cwd()): Promise<ProjectInfo> {
  const dir = resolvePath(root);
  const pkgPath = join(dir, 'package.json');

  if (!existsSync(pkgPath)) {
    throw new Error(`no package.json in ${dir} — run this from a project root`);
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`could not parse ${pkgPath}: ${(err as Error).message}`);
  }

  let lockfile: string | null = null;
  let packageManager: PackageManager | null = null;
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(join(dir, file))) {
      lockfile = file;
      packageManager = pm;
      break;
    }
  }

  // Fall back to the corepack `packageManager` field, then to npm.
  if (!packageManager) {
    const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
    const name = declared.split('@')[0];
    packageManager =
      name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm' ? name : 'npm';
  }

  const isMonorepo =
    existsSync(join(dir, 'pnpm-workspace.yaml')) || Array.isArray(pkg.workspaces);

  return {
    root: dir,
    name: typeof pkg.name === 'string' ? pkg.name : '(unnamed)',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    packageManager,
    lockfile,
    isGitRepo: existsSync(join(dir, '.git')),
    isMonorepo,
    scripts: asRecord(pkg.scripts),
    dependencies: asRecord(pkg.dependencies),
    devDependencies: asRecord(pkg.devDependencies),
  };
}

/** Argv for a fresh install that is allowed to update the lockfile. */
export function installArgv(pm: PackageManager): string[] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'install', '--no-frozen-lockfile', '--reporter=append-only'];
    case 'yarn':
      return ['yarn', 'install'];
    case 'bun':
      return ['bun', 'install'];
    case 'npm':
    default:
      return ['npm', 'install', '--no-audit', '--no-fund'];
  }
}

/** Argv for installing one specific version of a dependency. */
export function addDependencyArgv(
  pm: PackageManager,
  spec: string,
  dev: boolean,
): string[] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'add', dev ? '--save-dev' : '--save-prod', spec, '--reporter=append-only'];
    case 'yarn':
      return dev ? ['yarn', 'add', '--dev', spec] : ['yarn', 'add', spec];
    case 'bun':
      return dev ? ['bun', 'add', '--dev', spec] : ['bun', 'add', spec];
    case 'npm':
    default:
      return ['npm', 'install', dev ? '--save-dev' : '--save-prod', spec, '--no-audit', '--no-fund'];
  }
}

/** Argv for running a package.json script. */
export function runScriptArgv(pm: PackageManager, script: string): string[] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'run', script];
    case 'yarn':
      return ['yarn', 'run', script];
    case 'bun':
      return ['bun', 'run', script];
    case 'npm':
    default:
      return ['npm', 'run', script, '--silent'];
  }
}
