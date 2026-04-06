import os from 'os';
import path from 'path';
import * as realFs from 'node:fs/promises';
import { ExecutionEngine } from '../src/engine.js';
import { ReviewConvergenceController } from '../src/convergence/review-convergence-controller.js';
import { ProgressLedger } from '../src/convergence/progress-ledger.js';

describe('Round 2 Convergence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should detect effective change when same file content hash changes', async () => {
    const tmpRoot = await realFs.mkdtemp(path.join(os.tmpdir(), 'appmaker-r2-'));
    try {
      const engine = new ExecutionEngine({ project_root: tmpRoot });
      const prev = { output: { files_modified: ['src/a.js'], files_created: [] } };
      const next = { output: { files_modified: ['src/a.js'], files_created: [] } };
      const filePath = path.join(tmpRoot, 'src', 'a.js');

      await realFs.mkdir(path.dirname(filePath), { recursive: true });
      await realFs.writeFile(filePath, 'const a = 1;', 'utf-8');
      await engine._attachFileHashes(prev);
      await realFs.writeFile(filePath, 'const a = 2;', 'utf-8');
      await engine._attachFileHashes(next);

      expect(engine._hasEffectiveFileChange(prev, next)).toBe(true);
    } finally {
      await realFs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should keep ineffective change false when content hash stays the same', async () => {
    const tmpRoot = await realFs.mkdtemp(path.join(os.tmpdir(), 'appmaker-r2-'));
    try {
      const engine = new ExecutionEngine({ project_root: tmpRoot });
      const prev = { output: { files_modified: ['src/a.js'], files_created: [] } };
      const next = { output: { files_modified: ['src/a.js'], files_created: [] } };
      const filePath = path.join(tmpRoot, 'src', 'a.js');

      await realFs.mkdir(path.dirname(filePath), { recursive: true });
      await realFs.writeFile(filePath, 'const a = 1;', 'utf-8');
      await engine._attachFileHashes(prev);
      await realFs.writeFile(filePath, 'const a = 1;', 'utf-8');
      await engine._attachFileHashes(next);

      expect(engine._hasEffectiveFileChange(prev, next)).toBe(false);
    } finally {
      await realFs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should trigger diminishing returns only after consecutive low-gain signals', () => {
    const controller = new ReviewConvergenceController({
      window_size: 3,
      min_score_delta: 3,
      max_repeat_issue_rate: 0.7,
      diminishing_streak_required: 2,
      handoff_enabled: true,
    });
    const ledger = new ProgressLedger();

    ledger.addRound({
      score: 60,
      critical_count: 1,
      issue_repeat_rate: 0.1,
      file_change_effective: true,
      parse_failed: false,
    });
    expect(controller.evaluate(ledger).action).toBe('continue');

    ledger.addRound({
      score: 61,
      critical_count: 1,
      issue_repeat_rate: 0.9,
      file_change_effective: false,
      parse_failed: false,
    });
    expect(controller.evaluate(ledger).action).toBe('continue');

    ledger.addRound({
      score: 62,
      critical_count: 1,
      issue_repeat_rate: 0.95,
      file_change_effective: false,
      parse_failed: false,
    });
    const softDecision = controller.evaluate(ledger);
    expect(softDecision.action).toBe('soft_stop');
    expect(softDecision.stop_reason).toBe('DIMINISHING_RETURNS_SOFT_STOP');

    ledger.addRound({
      score: 63,
      critical_count: 1,
      issue_repeat_rate: 0.96,
      file_change_effective: false,
      parse_failed: false,
    });
    const handoffDecision = controller.evaluate(ledger);
    expect(handoffDecision.action).toBe('handoff');
    expect(handoffDecision.stop_reason).toBe('DIMINISHING_RETURNS');
    expect(handoffDecision.evidence.diminishing_signal_count).toBeGreaterThanOrEqual(2);
  });
});
