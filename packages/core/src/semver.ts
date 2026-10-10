/**
 * The slice of semver Texugo actually needs: parse, compare, and find the
 * highest stable release in a major. Deliberately dependency-free — a tool that
 * audits other people's dependency trees should keep its own shallow.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_RE.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function isStable(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.prerelease === null;
}

/** Compare two exact versions. Prereleases sort below their own release. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease.localeCompare(pb.prerelease);
}

/**
 * Pull the major out of a dependency range. Handles the common forms
 * (^1.2.3, ~1.2.3, >=1.2.3, 1.x, 1) and returns null for anything exotic —
 * workspace:, file:, git URLs, "*", and multi-clause ranges are all cases
 * where "what major are they on" has no honest answer.
 */
export function majorFromRange(range: string): number | null {
  const trimmed = range.trim();
  if (!trimmed || /^(\*|latest|workspace:|file:|link:|npm:|git|https?:)/.test(trimmed)) {
    return null;
  }
  if (/\s(\|\||-)\s/.test(trimmed)) return null;

  const match = /^[\^~><=v\s]*(\d+)/.exec(trimmed);
  if (!match?.[1]) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

/** Highest stable version within each major, keyed by major. */
export function latestStableByMajor(versions: string[]): Map<number, string> {
  const byMajor = new Map<number, string>();
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (!parsed || parsed.prerelease !== null) continue;
    const current = byMajor.get(parsed.major);
    if (!current || compareVersions(version, current) > 0) {
      byMajor.set(parsed.major, version);
    }
  }
  return byMajor;
}
