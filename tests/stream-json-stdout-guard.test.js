import {
  installStreamJsonStdoutGuard,
  resetStreamJsonStdoutGuardForTesting,
  STDOUT_GUARD_MARKER,
} from '../src/ops/stream-json-stdout-guard.js';

describe('stream-json stdout guard', () => {
  const realStdoutWrite = process.stdout.write;
  const realStderrWrite = process.stderr.write;

  beforeEach(() => {
    resetStreamJsonStdoutGuardForTesting();
  });

  afterEach(() => {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    resetStreamJsonStdoutGuardForTesting();
  });

  it('should keep JSON lines on stdout and divert non-JSON lines to stderr', () => {
    const stdoutChunks = [];
    const stderrChunks = [];

    process.stdout.write = (chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    installStreamJsonStdoutGuard();
    process.stdout.write('{"type":"ok"}\nplain text\n');

    expect(stdoutChunks.join('')).toContain('{"type":"ok"}\n');
    expect(stderrChunks.join('')).toContain(STDOUT_GUARD_MARKER);
    expect(stderrChunks.join('')).toContain('plain text');
  });

  it('should be safe to install guard more than once', () => {
    process.stdout.write = () => true;
    process.stderr.write = () => true;

    installStreamJsonStdoutGuard();
    const firstPatchedWrite = process.stdout.write;
    installStreamJsonStdoutGuard();

    expect(process.stdout.write).toBe(firstPatchedWrite);
  });
});

