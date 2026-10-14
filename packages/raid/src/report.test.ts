import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProbeResult, StepResult } from '@texugolabs/core';
import { failureReason } from './report.js';

function step(overrides: Partial<StepResult>): StepResult {
  return {
    name: 'test',
    command: 'npm run test',
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 1200,
    timedOut: false,
    ok: false,
    ...overrides,
  };
}

const INSTALLED = step({ name: 'install', command: 'npm install', exitCode: 0, ok: true });
const UPGRADED = step({ name: 'upgrade', command: 'npm install chalk@6.0.1', exitCode: 0, ok: true });

/** A failed probe shaped as runProbe records it: the last step is the one that broke. */
function failed(...steps: StepResult[]): ProbeResult {
  return {
    mutationId: 'chalk@6',
    label: 'chalk 4 -> 6',
    group: 'chalk',
    meta: {
      name: 'chalk',
      dev: false,
      currentRange: '^4.1.2',
      currentMajor: 4,
      targetMajor: 6,
      targetVersion: '6.0.1',
    },
    status: 'failed',
    failedStep: steps.at(-1)?.name,
    steps,
    durationMs: 5000,
  };
}

/** A failure in the verification steps, after install and upgrade succeeded. */
function failedAt(overrides: Partial<StepResult>): ProbeResult {
  return failed(INSTALLED, UPGRADED, step(overrides));
}

const NPM_BANNER = '\n> fixture@1.0.0 test\n> node test.js\n\n';
const ESC = '\u001b';

// Captured from Node 22.15.1 running a CJS-style chalk call against chalk 5+.
const NODE_TYPEERROR = [
  'file:///tmp/texugo-chalk-6/test.js:3',
  "console.log(chalk.green('ok'));",
  '                  ^',
  '',
  'TypeError: chalk.green is not a function',
  '    at file:///tmp/texugo-chalk-6/test.js:3:19',
  '    at ModuleJob.run (node:internal/modules/esm/module_job:274:25)',
  '    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:644:26)',
  '    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:116:5)',
  '',
  'Node.js v22.15.1',
  '',
].join('\n');

const NPM_ERESOLVE_LINES = [
  'code ERESOLVE',
  'ERESOLVE unable to resolve dependency tree',
  '',
  'While resolving: fixture@1.0.0',
  'Found: react@18.3.1',
  'node_modules/react',
  '  react@"^18.3.1" from the root project',
  '',
  'Could not resolve dependency:',
  'peer react@"^19.0.0" from react-dom@19.0.0',
  'node_modules/react-dom',
  '  react-dom@"19.0.0" from the root project',
  '',
  'Fix the upstream dependency conflict, or retry',
  'this command with --force or --legacy-peer-deps',
  'to accept an incorrect (and potentially broken) dependency resolution.',
  'A complete log of this run can be found in: /home/ci/.npm/_logs/2026-10-12T00_00_00_000Z-debug-0.log',
];

function npmLog(prefix: string, lines: string[]): string {
  return lines.map((line) => `${prefix} ${line}`).join('\n') + '\n';
}

type Case = [name: string, probe: ProbeResult, reason: string | RegExp];

const CASES: Record<string, Case[]> = {
  'Node uncaught exceptions': [
    [
      'TypeError behind a code frame, stack and the Node.js trailer',
      failedAt({ stdout: NPM_BANNER, stderr: NODE_TYPEERROR }),
      'TypeError: chalk.green is not a function',
    ],
    [
      'the same output with CRLF line endings',
      failedAt({
        stdout: NPM_BANNER.replaceAll('\n', '\r\n'),
        stderr: NODE_TYPEERROR.replaceAll('\n', '\r\n'),
      }),
      'TypeError: chalk.green is not a function',
    ],
    [
      // The shipped bug: "TypeError:" did not match the named-error signal, so a
      // vaguer line won. Here that line is Jest's FAIL header, printed first.
      'a named error beats an earlier test-runner FAIL header',
      failedAt({
        stderr: [
          'FAIL src/banner.test.js',
          '  ● renders the banner',
          '',
          "    TypeError: Cannot read properties of undefined (reading 'green')",
          '',
          "      1 | const chalk = require('chalk');",
          "    > 2 | console.log(chalk.default.green('ok'));",
          '        |                           ^',
          '',
          '      at Object.green (src/banner.test.js:2:27)',
          '',
          'Test Suites: 1 failed, 1 total',
          'Tests:       1 failed, 1 total',
        ].join('\n'),
      }),
      "TypeError: Cannot read properties of undefined (reading 'green')",
    ],
  ],

  TypeScript: [
    [
      'error TS2345 on stdout behind the npm banner',
      failedAt({
        name: 'build',
        exitCode: 2,
        stdout:
          '\n> fixture@1.0.0 build\n> tsc\n\n' +
          "src/add.ts(3,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n\n" +
          'Found 1 error in src/add.ts:3\n\n',
      }),
      /^src\/add\.ts\(3,5\): error TS2345: Argument of type 'string'/,
    ],
    [
      'tsc --pretty output with ANSI colours',
      failedAt({
        name: 'build',
        exitCode: 2,
        stdout:
          `${ESC}[96msrc/add.ts${ESC}[0m:${ESC}[93m3${ESC}[0m:${ESC}[93m5${ESC}[0m - ${ESC}[91merror${ESC}[0m${ESC}[90m TS2345: ${ESC}[0m` +
          "Argument of type 'string' is not assignable to parameter of type 'number'.\n\n" +
          `${ESC}[7m3${ESC}[0m add('1', 2);\n` +
          `${ESC}[7m ${ESC}[0m ${ESC}[91m    ~~~${ESC}[0m\n\n\n` +
          `Found 1 error in src/add.ts${ESC}[90m:3${ESC}[0m\n\n`,
      }),
      /^src\/add\.ts:3:5 - error TS2345: Argument of type 'string'/,
    ],
    [
      // stderr is read first, so the package manager's own error line is seen
      // before the compiler's; the TS signal has to outrank it.
      'a TS error beats yarn classic\'s own "error Command failed" line',
      failedAt({
        name: 'build',
        command: 'yarn run build',
        exitCode: 2,
        stdout:
          'yarn run v1.22.22\n$ tsc\n' +
          'src/add.ts(3,1): error TS2554: Expected 2 arguments, but got 1.\n\n' +
          'Found 1 error in src/add.ts:3\n\n' +
          'info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.\n',
        stderr: 'error Command failed with exit code 2.\n',
      }),
      'src/add.ts(3,1): error TS2554: Expected 2 arguments, but got 1.',
    ],
  ],

  npm: [
    [
      'npm ERR! spelling: ERESOLVE names the conflict, not the code',
      failed(
        INSTALLED,
        step({
          name: 'upgrade',
          command: 'npm install react-dom@19.0.0',
          stderr: npmLog('npm ERR!', NPM_ERESOLVE_LINES),
        }),
      ),
      'npm ERR! ERESOLVE unable to resolve dependency tree',
    ],
    [
      'npm error spelling (npm 10.9, Node 22): ERESOLVE names the conflict, not the code',
      failed(
        INSTALLED,
        step({
          name: 'upgrade',
          command: 'npm install react-dom@19.0.0',
          stderr: npmLog('npm error', NPM_ERESOLVE_LINES),
        }),
      ),
      'npm error ERESOLVE unable to resolve dependency tree',
    ],
    [
      'npm error spelling: a failed fetch names the request, not the code',
      failed(
        INSTALLED,
        step({
          name: 'upgrade',
          command: 'npm install left-pad@99.0.0',
          stderr:
            'npm error code ENOTCACHED\n' +
            "npm error request to https://registry.npmjs.org/left-pad failed: cache mode is 'only-if-cached' but no cached response is available.\n" +
            'npm error A complete log of this run can be found in: /home/ci/.npm/_logs/2026-10-12T00_00_00_000Z-debug-0.log\n',
        }),
      ),
      /^npm error request to https:\/\/registry\.npmjs\.org\/left-pad failed/,
    ],
    [
      'npm error spelling: a missing script',
      failedAt({
        name: 'build',
        command: 'npm run build',
        stderr:
          'npm error Missing script: "build"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n' +
          'npm error A complete log of this run can be found in: /home/ci/.npm/_logs/2026-10-12T00_00_00_000Z-debug-0.log\n',
      }),
      'npm error Missing script: "build"',
    ],
  ],

  'bare non-zero exit': [
    [
      'npm banner and nothing else',
      failedAt({ stdout: '\n> fixture@1.0.0 test\n> node -e "process.exit(1)"\n\n' }),
      'test exited 1',
    ],
    [
      'pnpm banner and ELIFECYCLE epilogue and nothing else',
      failedAt({
        command: 'pnpm run test',
        stdout: '\n> fixture@1.0.0 test /tmp/texugo-chalk-6\n> node test.js\n\n',
        stderr: ' ELIFECYCLE  Test failed. See above for more details.\n',
      }),
      'test exited 1',
    ],
    [
      'a plain message with no error words is the reason',
      failedAt({ name: 'build', exitCode: 2, stdout: '\n> fixture@1.0.0 build\n> node build.js\n\nBuild did not complete\n' }),
      'Build did not complete',
    ],
  ],

  'ANSI and terminal control sequences': [
    ...(
      [
        ['basic red', `${ESC}[31m`, `${ESC}[39m`],
        ['bold and red in one sequence', `${ESC}[1;31m`, `${ESC}[0m`],
        ['256-colour', `${ESC}[38;5;196m`, `${ESC}[0m`],
        ['truecolor', `${ESC}[38;2;255;85;85m`, `${ESC}[0m`],
        ['bare reset', `${ESC}[31m`, `${ESC}[m`],
      ] as const
    ).map(([label, open, close]): Case => [
      `${label} colour codes are stripped`,
      failedAt({ stderr: `${open}TypeError: x is not a function${close}\n` }),
      'TypeError: x is not a function',
    ]),
    [
      'a coloured Node.js trailer is still noise',
      failedAt({ stderr: `Build did not complete\n${ESC}[2mNode.js v22.15.1${ESC}[22m\n` }),
      'Build did not complete',
    ],
    [
      'spinner erase-line, cursor and visibility codes are stripped',
      failedAt({
        name: 'build',
        stderr: `${ESC}[?25l${ESC}[2K${ESC}[1G✖ Build failed: 2 errors\n${ESC}[?25h`,
      }),
      '✖ Build failed: 2 errors',
    ],
    [
      'carriage-return progress keeps what the terminal last showed',
      failedAt({ name: 'build', stdout: 'Bundling 10%\rBundling 90%\rBuild did not complete\n' }),
      'Build did not complete',
    ],
  ],

  timeouts: [
    [
      'a timed-out step says so, whatever it printed',
      failedAt({
        name: 'build',
        exitCode: null,
        signal: 'SIGKILL',
        timedOut: true,
        stderr: 'Error: connect ECONNREFUSED 127.0.0.1:5432\n',
      }),
      'build timed out',
    ],
  ],

  'empty and degenerate output': [
    ['no output at all', failedAt({}), 'test exited 1'],
    ['whitespace only', failedAt({ stdout: '  \n\r\n\t\n', stderr: '\n' }), 'test exited 1'],
    [
      'only stack frames and the Node.js trailer',
      failedAt({ exitCode: 3, stderr: '    at main (test.js:1:1)\n\nNode.js v22.15.1\n' }),
      'test exited 3',
    ],
    [
      'killed by a signal it did not ask for, with no output',
      failedAt({ exitCode: null, signal: 'SIGKILL' }),
      'test killed by SIGKILL',
    ],
    [
      'a command that could not be spawned, as exec() reports it',
      failedAt({ command: 'pnpm run test', exitCode: -1, stderr: '\nspawn pnpm ENOENT' }),
      'spawn pnpm ENOENT',
    ],
  ],

  'choosing the line': [
    ...(['✔', '✓', '√'] as const).map((tick): Case => [
      `a passing "${tick}" test that mentions an error does not beat the real failure`,
      failedAt({
        stdout:
          `${tick} rejects with TypeError: on null input (0.41ms)\n` +
          '✖ parses the header (1.12ms)\n' +
          '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n',
      }),
      'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    ]),
    [
      'an earlier optional step failure does not hide the step that failed the probe',
      {
        ...failed(
          INSTALLED,
          UPGRADED,
          step({ name: 'lint', stdout: 'src/db.ts: 3 problems (1 error, 2 warnings)\n' }),
          step({ name: 'test', stderr: 'TypeError: client.close is not a function\n' }),
        ),
        failedStep: 'test',
      },
      'TypeError: client.close is not a function',
    ],
    [
      'the harness error wins over step output',
      {
        ...failed(INSTALLED),
        status: 'errored',
        failedStep: undefined,
        error: 'mutation failed to apply: ENOSPC: no space left on device, write',
      },
      'mutation failed to apply: ENOSPC: no space left on device, write',
    ],
    [
      'nothing failed and there is no harness error',
      { ...failed(INSTALLED, UPGRADED), failedStep: undefined },
      'unknown',
    ],
  ],

  truncation: [
    ['exactly 100 characters is kept whole', failedAt({ stderr: `Error: ${'x'.repeat(93)}` }), `Error: ${'x'.repeat(93)}`],
    ['101 characters is cut to 100', failedAt({ stderr: `Error: ${'x'.repeat(94)}` }), `Error: ${'x'.repeat(90)}...`],
    [
      'a long, multi-line harness error is cut to its first line',
      {
        ...failed(),
        status: 'errored',
        failedStep: undefined,
        error:
          "could not create sandbox: EACCES: permission denied, mkdir 'C:\\Users\\someone\\AppData\\Local\\Temp\\texugo-typescript-eslint-parser@8'\n" +
          '    at async mkdir (node:internal/fs/promises:858:10)',
      },
      /^could not create sandbox: EACCES: permission denied, mkdir .*\.\.\.$/,
    ],
  ],
};

describe('failureReason', () => {
  for (const [group, cases] of Object.entries(CASES)) {
    describe(group, () => {
      for (const [name, probe, reason] of cases) {
        test(name, () => {
          const actual = failureReason(probe);
          if (typeof reason === 'string') assert.equal(actual, reason);
          else assert.match(actual, reason);
        });
      }
    });
  }

  // The reason is printed as the last column of the result matrix; a newline,
  // a stray escape sequence or an unbounded length breaks the table.
  test('every reason fits on one row of the matrix', () => {
    const violations = Object.values(CASES)
      .flat()
      .map(([name, probe]) => [name, failureReason(probe)] as const)
      .filter(([, actual]) => actual.length > 100 || /[\r\n\u001b]/.test(actual))
      .map(([name, actual]) => `${name}: ${JSON.stringify(actual)}`);
    assert.deepEqual(violations, []);
  });
});
