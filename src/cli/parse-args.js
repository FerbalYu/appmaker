import path from 'path';
import { fileURLToPath } from 'url';

function normalizeOutputFormat(argv = []) {
  let format = process.env.NCF_OUTPUT_FORMAT || process.env.OUTPUT_FORMAT || '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--output-format=')) {
      format = arg.split('=')[1] || format;
      argv.splice(i, 1);
      i -= 1;
      continue;
    }
    if (arg === '--output-format' && argv[i + 1]) {
      format = argv[i + 1];
      argv.splice(i, 2);
      i -= 1;
    }
  }
  return String(format || '').toLowerCase();
}

export function parseCliArgs(argv = []) {
  const sliced = argv.slice(2);
  const rawArgs = [...sliced];
  const command = rawArgs[0];
  const mainDir = path.dirname(fileURLToPath(import.meta.url));

  const outputFormat = normalizeOutputFormat(rawArgs);

  let executeDir = process.cwd();

  const dirIndex = rawArgs.indexOf('--dir');
  if (dirIndex !== -1 && rawArgs[dirIndex + 1]) {
    executeDir = path.resolve(process.cwd(), rawArgs[dirIndex + 1]);
    rawArgs.splice(dirIndex, 2);
  }

  let daemonMode = true;
  const daemonIndex = rawArgs.indexOf('--no-daemon');
  if (daemonIndex !== -1) {
    daemonMode = false;
    rawArgs.splice(daemonIndex, 1);
  }

  const mockIndex = rawArgs.findIndex((arg) => arg === '--mock' || arg === '--dry-run');
  const dryRun = mockIndex !== -1;
  if (dryRun) {
    rawArgs.splice(mockIndex, 1);
  }

  const safeExecDir = executeDir.toLowerCase();
  const safeMainDir = mainDir.toLowerCase();
  let safe = true;
  if (safeExecDir === safeMainDir || safeExecDir.startsWith(safeMainDir + path.sep)) {
    safe = false;
  }

  return {
    command,
    rawArgs,
    executeDir,
    daemonMode,
    outputFormat,
    dryRun,
    mainDir,
    safe,
    daemonDataDir: path.join(executeDir, '.daemon'),
  };
}
