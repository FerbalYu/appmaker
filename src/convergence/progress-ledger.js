export class ProgressLedger {
  constructor() {
    this.rounds = [];
  }

  addRound(round) {
    this.rounds.push({
      score: 0,
      critical_count: 0,
      issue_count: 0,
      issue_repeat_rate: 0,
      file_change_effective: true,
      parse_failed: false,
      tokens_delta: 0,
      ...round,
    });
  }

  getRecent(windowSize = 3) {
    if (windowSize <= 0) return [];
    return this.rounds.slice(-windowSize);
  }
}

export default ProgressLedger;
