# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Texugo is a set of developer tools that answer the question "what does this
project actually survive?" by sandboxing a copy of the user's repo, breaking
something on purpose, and running their own build and tests against it.

The honey badger is the mascot: it keeps going through what kills everything
else. Commands are named for badger behaviours.

| Command     | Mutation it applies                               | Status  |
| ----------- | ------------------------------------------------- | ------- |
| `raid`      | Bump a dependency to a newer major                | Working |
| `venom`     | Poison the install environment                    | Planned |
| `thickskin` | Apply a candidate remediation to a failing CI run | Planned |

## Commands

```sh
pnpm install
pnpm build          # tsc --build across the three packages, in dependency order
pnpm typecheck      # same as build: referenced projects can't check with --noEmit (TS6310)
pnpm test           # per package: tsc --build, then node --test inside dist/
pnpm clean          # tsc --build --clean

# run the CLI from source build
node packages/cli/dist/bin.js raid --cwd /path/to/some/project
```

There is no watch task and no bundler. `tsc --build` with project references is
the whole build.

## Architecture

The central idea: **every tool is a `Mutation`, not a new runner.** If you find
yourself writing sandbox or process-management code inside `raid`, it belongs in
`core` instead.

```
packages/core   @texugolabs/core   sandbox runner, project detection, probe engine
packages/raid   @texugolabs/raid   the raid strategy (registry + upgrade mutations)
packages/cli    texugo             the CLI — this is what users install
```

Dependency direction is strictly `cli -> raid -> core`. `core` must never import
from a strategy package.

### The probe lifecycle

`runProbe()` in `core/src/runner.ts` is the heart of it, and the step order is
load-bearing:

1. Copy the project into a temp sandbox (uncommitted work included).
2. Run the **baseline install** — before any mutation.
3. Apply the mutation (`mutation.apply(sandbox)`).
4. Run the verification steps (build, typecheck, test) derived from the user's
   own package.json scripts.
5. Dispose of the sandbox.

Installing _before_ mutating is deliberate: it means a mutation can be expressed
as `pnpm add pkg@6` against an already-resolved tree, rather than as a
package.json edit plus a full re-resolve, which would let unrelated dependencies
float and pollute the signal.

Adding a new tool means implementing `Mutation` (`id`, `label`, `apply`) and
wiring a CLI subcommand. Nothing else.

## Invariants — do not break these

- **Never write to the user's working tree.** Everything happens in a temp
  sandbox. This is the core promise of the tool.
- **A probe run requires a green baseline.** Without it, failures are
  unattributable and the matrix is a lie. `raid` exits 2 on a red baseline
  rather than printing results. `--skip-baseline` is the escape hatch.
- **`exec()` never rejects.** A command that fails to spawn returns a
  `StepResult` with `exitCode: -1`. Callers treat "does not exist" and "failed"
  identically. Do not add a throwing path. On Windows, where package managers
  are `.cmd` shims, commands run through `cmd.exe`, so `exec()` refuses any
  argument outside a safe character set and checks `PATH` itself to keep the
  `-1` contract.
- **A timeout kills the whole process tree**, not just the direct child:
  `taskkill /T` on Windows, the step's own process group elsewhere. Killing
  only `npm` leaves its `sh` and `node` holding the pipes, and the step never
  settles. Because those groups are out of reach of the terminal's Ctrl+C,
  `core` kills any still running on process exit, and the CLI turns
  SIGINT/SIGTERM into an exit so that hook runs.
- **Captured output is capped** (256KB per stream) and truncated again in the
  JSON report. A pathological build log must not exhaust memory or produce a
  megabyte report.
- **Probe every major, not just the latest.** "You can get to 6 but not 7" is
  the answer users need; latest-only reports it as a flat failure.
  `--latest-only` is opt-in.
- **Zero runtime dependencies.** A tool that audits other people's dependency
  trees keeps its own shallow. Dev dependencies are limited to TypeScript and
  `@types/node`. If you want a package for colors, argument parsing or semver,
  write the 30 lines instead — `core/src/semver.ts` and `cli/src/ui.ts` are the
  precedent.

## Conventions

- ESM only, `"type": "module"`, `NodeNext` resolution. **Relative imports need
  the `.js` extension** even in `.ts` source.
- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- `noUncheckedIndexedAccess` is on: array indexing yields `T | undefined`.
  Handle it rather than asserting with `!`.
- Target Node 22+. `node:util` `parseArgs`, global `fetch` and
  `AbortSignal.timeout` are all fair game.
- Comments explain **why**, not what. The existing comments are the house style:
  they justify a non-obvious decision. Do not add comments restating the code.
- User-facing output goes through `cli/src/ui.ts`, which respects `NO_COLOR`.
  Library packages print nothing — they return structured results and let the
  CLI render.

## Testing

`node:test` and `node:assert` only — the zero-dependency rule covers test
tooling too. Tests sit next to their source as `src/*.test.ts` and compile with
the package, so the build type-checks them. Each package's `test` script runs
`node --test` from inside `dist/` on purpose: Node 22 treats a directory
argument as a file to run, and discovery from the package root would also pick
up `src/*.test.ts` on Node versions that strip types, where the `.js` imports do
not resolve. `files` excludes `dist/**/*.test.*` so compiled tests never ship.
A deleted test's compiled copy keeps running until `pnpm clean`.

`failureReason()` fixtures are real tool output. When a probe reports a useless
reason, capture the failing step's stdout and stderr and add them as a case
rather than guessing what the tool prints — older and current npm already
disagree on their error prefix.

Manual verification uses a fixture with one known-breaking and one known-safe
upgrade: a project depending on `chalk@^4` (whose v5 is ESM-only, so a CJS
`require` breaks) and `semver@^6` (whose v7 upgrade is safe if nothing imports
it). Expected output:

```
DEPENDENCY  FROM  TO     RESULT
chalk       4     5.6.2  BREAKS  test: TypeError: chalk.green is not a function
chalk       4     6.0.1  BREAKS  test: TypeError: chalk.green is not a function
semver      6     7.8.5  ok
```

That pair is also the integration test: `packages/cli/fixtures/raid/`, driven by
`cli/src/raid.integration.test.ts`, which runs the built CLI against it and
checks the `--json` report and that the fixture is byte-identical afterwards.
It runs once per package manager: npm against the fixture itself, pnpm, yarn
and bun against a temp copy given their lockfile, skipping any not installed.
It needs network, so `pnpm test` skips it unless `TEXUGO_INTEGRATION=1` is set;
CI runs it on pushes to main only. Run it alone after `pnpm build`:

```sh
cd packages/cli/dist && TEXUGO_INTEGRATION=1 node --test raid.integration.test.js
```

## Known gaps

Be aware of these before assuming the code handles a case:

- **Yarn Berry (2+) is untested.** npm, pnpm, yarn classic and bun run in the
  integration test; Berry needs a `packageManager` field and Corepack, and
  its output has no `failureReason()` fixtures yet.
- **Monorepos are detected, not handled.** `defaultPipeline()` reads root
  scripts only, and a root-level `pnpm add` in a workspace may not do what the
  user expects.
- **One dependency at a time.** Combinations are not probed. `ProbeResult` was
  shaped to allow them later without a format break — this is the real
  differentiator over Renovate, so do not design it out.
- **Cold install per probe.** No shared package-manager store. This is the
  biggest adoption risk on a large dependency set.

## Release

Not set up yet. Packages are at `0.0.0` and unpublished. `texugo` is the
user-facing unscoped package; `@texugolabs/*` are internals. When adding
release automation, note that `raid` and `cli` depend on `core` via
`workspace:*`, which must be rewritten at publish time.
