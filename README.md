<div align="center">

```
   ___
  (o,o)   texugo
  {`"'}
  -"-"-
```

**Fearless tooling for JavaScript projects.**

Find out what your repo actually survives — before production does.

</div>

---

The honey badger is famous for one thing: it keeps going through what kills
everything else. Texugo tools work the same way. They take your project, drop a
copy into a hostile sandbox, break something on purpose, and report what
survived.

Nothing is ever written to your working tree.

## Install

```sh
npx texugo raid
```

Requires Node 20.11 or newer.

## `texugo raid`

Which major version bumps does this project survive?

`raid` reads your dependencies, asks the registry which newer majors exist, and
spawns an isolated sandbox for each one. In each sandbox it installs the bump
and runs your own `build`, `typecheck` and `test` scripts. You get a matrix of
what is safe to take today.

```
DEPENDENCY  FROM  TO     RESULT
chalk       4     6.0.1  BREAKS  test: TypeError: chalk.green is not a function
semver      6     7.8.5  ok

2 major bumps probed: 1 safe, 1 breaking.
```

Before probing anything, `raid` verifies your project passes its own checks
unchanged. Without a green baseline every failure below it is unattributable,
so a red baseline stops the run rather than producing a matrix you cannot
trust.

By default it probes **every** major between where you are and the newest one,
not just the newest. "You can get to 6 but not 7" is the useful answer, and a
latest-only run reports it as a flat failure.

```sh
texugo raid                                  # probe everything
texugo raid --only react,react-dom           # probe two dependencies
texugo raid --latest-only --concurrency 4    # faster, less detail
texugo raid --json raid-report.json          # machine-readable output
texugo raid --fail-on-break                  # exit 1 in CI if anything breaks
```

Run `texugo raid --help` for the full list.

### How is this different from Renovate or `npm outdated`?

They tell you a newer version exists. `raid` tells you whether taking it
actually works, by running your code against it. It opens no PRs and changes no
files — it answers a question.

## Roadmap

| Command     | What it does                                                        | Status  |
| ----------- | ------------------------------------------------------------------- | ------- |
| `raid`      | Which major bumps survive your build and tests                       | Working |
| `venom`     | Chaos-test the install environment: registry faults, lockfile drift, injected postinstall scripts, slow resolution | Planned |
| `thickskin` | Diagnose a failing CI run, retry with a targeted fix, learn which fixes work | Planned |

All three sit on the same engine in `@texugolabs/core`: detect the project,
sandbox it, apply a mutation, run a verification pipeline, report structured
results. A new tool is a new `Mutation` implementation, not a new runner.

## Packages

| Package              | Description                                     |
| -------------------- | ----------------------------------------------- |
| `texugo`             | The CLI. This is what you install.              |
| `@texugolabs/core`   | Sandbox runner, project detection, probe engine |
| `@texugolabs/raid`   | The `raid` strategy                             |

## Development

```sh
pnpm install
pnpm build
node packages/cli/dist/bin.js raid --cwd /path/to/some/project
```

The runtime has no dependencies. A tool that audits other people's dependency
trees should keep its own shallow.

## License

MIT © Vinicius Costa Marinho / Texugo Labs
