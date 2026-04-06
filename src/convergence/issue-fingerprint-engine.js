function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function issueKey(issue = {}) {
  return [
    normalizeText(issue.severity),
    normalizeText(issue.file),
    normalizeText(issue.title),
    normalizeText(issue.reason),
  ].join('|');
}

export class IssueFingerprintEngine {
  fingerprintIssues(issues = []) {
    return (issues || []).map((issue) => issueKey(issue));
  }

  computeRepeatRate(previousIssues = [], currentIssues = []) {
    const prevSet = new Set(this.fingerprintIssues(previousIssues));
    const curr = this.fingerprintIssues(currentIssues);
    if (curr.length === 0) return 0;
    const repeated = curr.filter((fp) => prevSet.has(fp)).length;
    return repeated / curr.length;
  }
}

export default IssueFingerprintEngine;
