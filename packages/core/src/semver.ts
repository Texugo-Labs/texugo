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

/**
 * Semver 2.0.0 section 11: identifiers compare left to right, numeric ones
 * numerically and below any alphanumeric one, the rest in ASCII order (not
 * locale order, so "Alpha" < "alpha"). A shorter set of equal identifiers
 * sorts first.
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
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
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** One comparator that pins a single major: ^1.2.3, ~1.2, =1.2.3, v1, 1.x, 1. */
const SINGLE_MAJOR_RE =
  /^[\^~=]?\s*v?(\d+)(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Pull the major out of a dependency range, or null when "what major are they
 * on" has no honest answer. Matching the accepted forms whole, rather than
 * rejecting known-exotic prefixes, is what keeps workspace:, file:, git URLs,
 * GitHub shorthands, "*", unions and comparator sets out. Comparison operators
 * are rejected too: `>=1.2.3` resolves to the newest release, so reading it as
 * major 1 would make raid probe downgrades and call them upgrades.
 */
export function majorFromRange(range: string): number | null {
  const match = SINGLE_MAJOR_RE.exec(range.trim());
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
