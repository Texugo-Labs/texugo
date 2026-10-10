import { latestStableByMajor } from '@texugolabs/core';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** The subset of the npm packument Texugo reads. */
interface Packument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, unknown>;
  deprecated?: string;
}

export interface RegistryOptions {
  registry?: string;
  /** Per-request timeout. Defaults to 15s. */
  timeoutMs?: number;
}

export interface PackageVersions {
  name: string;
  latest: string | null;
  /** Highest stable release in each major. */
  stableByMajor: Map<number, string>;
}

/**
 * Fetch a package's version list. Uses the abbreviated packument content type,
 * which is a fraction of the full document — raiding 40 dependencies should not
 * mean downloading 40 megabytes of changelog metadata.
 */
export async function fetchPackageVersions(
  name: string,
  options: RegistryOptions = {},
): Promise<PackageVersions> {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  const url = `${registry}/${name.replace(/\//g, '%2F')}`;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);

  const response = await fetch(url, {
    signal,
    headers: {
      accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
      'user-agent': 'texugo-raid (+https://github.com/Texugo-Labs/texugo)',
    },
  });

  if (!response.ok) {
    throw new Error(`registry returned ${response.status} for ${name}`);
  }

  const packument = (await response.json()) as Packument;
  const versions = Object.keys(packument.versions ?? {});

  return {
    name,
    latest: packument['dist-tags']?.latest ?? null,
    stableByMajor: latestStableByMajor(versions),
  };
}
