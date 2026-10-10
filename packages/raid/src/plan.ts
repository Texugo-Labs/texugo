import {
  addDependencyArgv,
  majorFromRange,
  type Mutation,
  type ProjectInfo,
  type Sandbox,
} from '@texugolabs/core';
import { fetchPackageVersions, type RegistryOptions } from './registry.js';

export interface UpgradeCandidate {
  name: string;
  dev: boolean;
  currentRange: string;
  currentMajor: number;
  targetMajor: number;
  targetVersion: string;
}

export interface SkippedDependency {
  name: string;
  reason: string;
}

export interface RaidPlan {
  candidates: UpgradeCandidate[];
  skipped: SkippedDependency[];
}

export interface PlanOptions extends RegistryOptions {
  /** Only consider these dependency names. */
  only?: string[];
  /** Never consider these dependency names. */
  exclude?: string[];
  /** Skip devDependencies. */
  prodOnly?: boolean;
  /**
   * Test only the newest major rather than every major between current and
   * latest. Default is every major — the honest answer is often "you can get
   * to 6 but not 7", which a latest-only run would report as a flat failure.
   */
  latestOnly?: boolean;
  /** Parallel registry lookups. Defaults to 8. */
  concurrency?: number;
}

/**
 * Work out which major bumps are available. Dependencies pinned to something
 * Texugo cannot reason about (workspace:, git URLs, "*") are skipped with a
 * reason rather than guessed at.
 */
export async function buildRaidPlan(
  project: ProjectInfo,
  options: PlanOptions = {},
): Promise<RaidPlan> {
  const only = options.only?.length ? new Set(options.only) : null;
  const exclude = new Set(options.exclude ?? []);

  const entries: Array<{ name: string; range: string; dev: boolean }> = [];
  for (const [name, range] of Object.entries(project.dependencies)) {
    entries.push({ name, range, dev: false });
  }
  if (!options.prodOnly) {
    for (const [name, range] of Object.entries(project.devDependencies)) {
      entries.push({ name, range, dev: true });
    }
  }

  const candidates: UpgradeCandidate[] = [];
  const skipped: SkippedDependency[] = [];
  const queue = entries.filter((entry) => {
    if (only && !only.has(entry.name)) return false;
    if (exclude.has(entry.name)) {
      skipped.push({ name: entry.name, reason: 'excluded' });
      return false;
    }
    return true;
  });

  const concurrency = Math.max(1, options.concurrency ?? 8);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= queue.length) return;
      const entry = queue[index];
      if (!entry) return;

      const currentMajor = majorFromRange(entry.range);
      if (currentMajor === null) {
        skipped.push({ name: entry.name, reason: `unsupported range "${entry.range}"` });
        continue;
      }

      let versions;
      try {
        versions = await fetchPackageVersions(entry.name, options);
      } catch (err) {
        skipped.push({ name: entry.name, reason: (err as Error).message });
        continue;
      }

      const newerMajors = [...versions.stableByMajor.keys()]
        .filter((major) => major > currentMajor)
        .sort((a, b) => a - b);

      if (newerMajors.length === 0) {
        skipped.push({ name: entry.name, reason: 'already on the newest major' });
        continue;
      }

      const targets = options.latestOnly ? newerMajors.slice(-1) : newerMajors;
      for (const targetMajor of targets) {
        const targetVersion = versions.stableByMajor.get(targetMajor);
        if (!targetVersion) continue;
        candidates.push({
          name: entry.name,
          dev: entry.dev,
          currentRange: entry.range,
          currentMajor,
          targetMajor,
          targetVersion,
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );

  candidates.sort(
    (a, b) => a.name.localeCompare(b.name) || a.targetMajor - b.targetMajor,
  );
  skipped.sort((a, b) => a.name.localeCompare(b.name));

  return { candidates, skipped };
}

/** Turn a candidate into a mutation the core runner can execute. */
export function createUpgradeMutation(
  project: ProjectInfo,
  candidate: UpgradeCandidate,
): Mutation {
  const spec = `${candidate.name}@${candidate.targetVersion}`;
  return {
    id: `${candidate.name}@${candidate.targetMajor}`,
    label: `${candidate.name} ${candidate.currentMajor} -> ${candidate.targetMajor}`,
    group: candidate.name,
    meta: {
      name: candidate.name,
      dev: candidate.dev,
      currentRange: candidate.currentRange,
      currentMajor: candidate.currentMajor,
      targetMajor: candidate.targetMajor,
      targetVersion: candidate.targetVersion,
    },
    apply(sandbox: Sandbox) {
      return sandbox.exec(
        addDependencyArgv(project.packageManager, spec, candidate.dev),
        { name: 'upgrade' },
      );
    },
  };
}
