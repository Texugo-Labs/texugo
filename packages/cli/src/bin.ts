#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { raidCommand } from './commands/raid.js';
import { BADGER, bold, cyan, dim, red } from './ui.js';

const HELP = `${BADGER}
${bold('texugo')} — fearless tooling for JavaScript projects

${bold('Commands')}
  ${cyan('raid')}        Which major version bumps does this project survive?
  ${dim('venom')}       ${dim('Chaos-test the install environment (coming soon)')}
  ${dim('thickskin')}   ${dim('Diagnose and retry failing CI (coming soon)')}

${bold('Usage')}
  texugo <command> [options]
  texugo <command> --help

  -h, --help       Show this help
  -v, --version    Show the installed version
`;

async function version(): Promise<string> {
  const pkgUrl = new URL('../package.json', import.meta.url);
  try {
    const pkg = JSON.parse(await readFile(fileURLToPath(pkgUrl), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${await version()}\n`);
    return 0;
  }

  switch (command) {
    case 'raid':
      return raidCommand(rest);
    case 'venom':
    case 'thickskin':
      process.stderr.write(
        `${bold(command)} is not built yet — it is on the roadmap.\n` +
          `Today the badger only knows ${cyan('raid')}. Try: texugo raid --help\n`,
      );
      return 2;
    default:
      process.stderr.write(
        `${red('error')}: unknown command "${command}"\n\nRun ${bold('texugo --help')} to see what is available.\n`,
      );
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${red('error')}: ${message}\n`);
    process.exitCode = 2;
  });
