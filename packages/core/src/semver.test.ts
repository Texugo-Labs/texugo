import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareVersions, latestStableByMajor, majorFromRange } from './semver.js';

function expectMajors(cases: Array<[string, number | null]>): void {
  for (const [range, expected] of cases) {
    test(`${JSON.stringify(range)} -> ${expected}`, () => {
      assert.equal(majorFromRange(range), expected);
    });
  }
}

describe('majorFromRange', () => {
  describe('returns null for specifiers that do not name a registry version', () => {
    expectMajors([
      ['workspace:*', null],
      ['workspace:^1.2.3', null],
      ['file:../local-pkg', null],
      ['link:../local-pkg', null],
      ['git+https://github.com/owner/repo.git', null],
      ['git://github.com/owner/repo.git#v1.2.3', null],
      ['git+ssh://git@github.com/owner/repo.git', null],
      ['github:owner/repo', null],
      ['owner/repo#v1.2.3', null],
      // GitHub shorthand: owner names may start with digits.
      ['1234/repo', null],
      ['https://example.com/pkg-1.0.0.tgz', null],
      ['./pkg-1.2.3.tgz', null],
      ['npm:other-pkg@^2.0.0', null],
      ['catalog:', null],
    ]);
  });

  describe('returns null for wildcards, dist-tags and blanks', () => {
    expectMajors([
      ['*', null],
      ['x', null],
      ['latest', null],
      ['next', null],
      ['', null],
      ['   ', null],
    ]);
  });

  describe('returns null for ranges that span or escape a single major', () => {
    expectMajors([
      ['^1 || ^2', null],
      // node-semver splits on \s*\|\|\s*, so this is still a union.
      ['^1||^2', null],
      ['1.2.3 - 2.3.4', null],
      ['>=1 <3', null],
      ['>=1.2.3 <2.0.0', null],
      ['>=1\t<3', null],
      // An open lower bound resolves to the newest release, so it says nothing
      // about the installed major; reporting 1 would probe downgrades as upgrades.
      ['>=1.2.3', null],
      ['>= 1.2.3', null],
      ['>1', null],
      // An upper bound alone names the major the user is *not* on.
      ['<2', null],
      ['<2.0.0', null],
      ['<=1.5', null],
    ]);
  });

  describe('reads the major from pinned, caret, tilde and x-ranges', () => {
    expectMajors([
      ['1', 1],
      ['1.2', 1],
      ['1.2.3', 1],
      ['1.x', 1],
      ['1.X', 1],
      ['1.*', 1],
      ['1.x.x', 1],
      ['^1.2.3', 1],
      ['~1.2.3', 1],
      ['=1.2.3', 1],
      ['v1.2.3', 1],
      ['^ 1.2.3', 1],
      ['~ 1.2.3', 1],
      ['^1.2.3-beta.1', 1],
      ['  ^1.2.3  ', 1],
      ['^12.0.0', 12],
      // 0 is falsy; it must come back as a major, not collapse to null.
      ['^0.2.3', 0],
      ['0.x', 0],
    ]);
  });
});

describe('compareVersions', () => {
  // The precedence example from semver 2.0.0 section 11, in ascending order.
  const PRECEDENCE = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];

  const ASCENDING: Array<[string, string]> = [
    ...PRECEDENCE.slice(1).map((higher, i): [string, string] => [PRECEDENCE[i] ?? '', higher]),
    ['1.0.0-rc.9', '1.0.0-rc.10'],
    ['1.0.0-0', '1.0.0-alpha'],
    // Numeric identifiers always sort below alphanumeric ones, whatever digits follow.
    ['1.0.0-rc.10', '1.0.0-rc.9a'],
    // Alphanumeric identifiers compare in ASCII order, not locale order.
    ['1.0.0-Alpha', '1.0.0-alpha'],
    ['1.0.0-rc.1', '1.0.1-alpha'],
    ['9.0.0', '10.0.0'],
    ['1.9.0', '1.10.0'],
    ['1.0.9', '1.0.10'],
  ];

  for (const [lower, higher] of ASCENDING) {
    test(`${lower} < ${higher}`, () => {
      assert.ok(compareVersions(lower, higher) < 0, `compare(${lower}, ${higher}) should be negative`);
      assert.ok(compareVersions(higher, lower) > 0, `compare(${higher}, ${lower}) should be positive`);
    });
  }

  test('sorts the section 11 example into precedence order', () => {
    const shuffled = [
      '1.0.0-beta.11',
      '1.0.0',
      '1.0.0-alpha.beta',
      '1.0.0-beta.2',
      '1.0.0-alpha',
      '1.0.0-rc.1',
      '1.0.0-beta',
      '1.0.0-alpha.1',
    ];
    assert.deepEqual([...shuffled].sort(compareVersions), PRECEDENCE);
  });

  test('ignores build metadata', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0+build.5'), 0);
    assert.equal(compareVersions('1.0.0-rc.1+a', '1.0.0-rc.1+b'), 0);
  });
});

describe('latestStableByMajor', () => {
  test('picks the numerically highest release, whatever the input order', () => {
    const expected = new Map([[1, '1.10.0']]);
    assert.deepEqual(latestStableByMajor(['1.2.0', '1.10.0', '1.9.9']), expected);
    assert.deepEqual(latestStableByMajor(['1.9.9', '1.2.0', '1.10.0']), expected);
  });

  test('keys each major separately', () => {
    assert.deepEqual(
      latestStableByMajor(['1.0.0', '2.0.5', '2.1.0', '3.0.0']),
      new Map([
        [1, '1.0.0'],
        [2, '2.1.0'],
        [3, '3.0.0'],
      ]),
    );
  });

  test('omits a major that has only prereleases', () => {
    assert.deepEqual(
      latestStableByMajor(['1.4.0', '2.0.0-rc.1', '2.0.0-beta.3']),
      new Map([[1, '1.4.0']]),
    );
  });

  test('does not let a newer prerelease displace a stable release', () => {
    assert.deepEqual(latestStableByMajor(['1.5.0', '1.6.0-beta.1']), new Map([[1, '1.5.0']]));
  });

  test('keeps major 0', () => {
    assert.deepEqual(
      latestStableByMajor(['0.1.0', '0.10.0', '0.2.0']),
      new Map([[0, '0.10.0']]),
    );
  });

  test('skips strings that are not versions', () => {
    assert.deepEqual(
      latestStableByMajor(['not-a-version', '2.0', '1.0.0']),
      new Map([[1, '1.0.0']]),
    );
  });

  test('returns an empty map for no versions', () => {
    assert.deepEqual(latestStableByMajor([]), new Map());
  });
});
