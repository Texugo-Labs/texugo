/** Minimal ANSI helpers. No dependency, and it respects NO_COLOR. */

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  process.stdout.isTTY === true;

const wrap = (open: number, close: number) => (text: string): string =>
  enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

/** Colorize the RESULT column of an already-aligned matrix line. */
export function paintMatrix(matrix: string): string {
  if (!enabled) return matrix;
  return matrix
    .split('\n')
    .map((line) => {
      if (line.includes('BREAKS')) return line.replace('BREAKS', red('BREAKS'));
      if (line.includes('error')) return line.replace('error', yellow('error'));
      if (line.includes(' ok')) return line.replace(' ok', ` ${green('ok')}`);
      return line;
    })
    .join('\n');
}

export const BADGER = `
   ___
  (o,o)   texugo
  {\`"'}
  -"-"-
`;
