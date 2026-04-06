function truncateTextByBudget(text, maxChars) {
  const normalized = typeof text === 'string' ? text : `${text || ''}`;
  if (maxChars <= 0) return { value: '', truncated: normalized.length > 0 };
  if (normalized.length <= maxChars) return { value: normalized, truncated: false };
  if (maxChars <= 3) return { value: '.'.repeat(maxChars), truncated: true };
  return { value: `${normalized.substring(0, maxChars - 3)}...`, truncated: true };
}

export function fitListWithinBudget(items, maxChars, separator = ', ') {
  const list = Array.isArray(items) ? items : [];
  if (maxChars <= 0 || list.length === 0) {
    return { value: [], truncated: list.length > 0 };
  }

  const kept = [];
  let used = 0;
  for (const item of list) {
    const text = String(item);
    const next = kept.length === 0 ? text.length : used + separator.length + text.length;
    if (next > maxChars) {
      return { value: kept, truncated: true };
    }
    kept.push(text);
    used = next;
  }
  return { value: kept, truncated: false };
}

export function buildBudgetedContextSections(projectContext, sectionLimits, totalBudget) {
  let remaining = Math.max(0, totalBudget);
  const sections = [];
  const meta = { total: totalBudget, used: 0, truncated: {} };

  const appendSection = (title, content, sectionLimit, emptyFallback = '') => {
    if (!content && !emptyFallback) return;
    const budgetCap = Math.min(sectionLimit, remaining);
    const input = content || emptyFallback;
    const { value, truncated } = truncateTextByBudget(input, budgetCap);
    if (!value) return;
    sections.push(`## ${title}\n${value}`);
    const used = value.length;
    remaining = Math.max(0, remaining - used);
    meta.used += used;
    meta.truncated[title] = truncated;
  };

  appendSection('项目结构', projectContext.structure, sectionLimits.structure, '空目录');
  appendSection('现有文件', (projectContext.files || []).join(', '), sectionLimits.files, '无');
  appendSection('技术栈', projectContext.techStack, sectionLimits.techStack);
  appendSection('Git 状态', projectContext.gitStatus, sectionLimits.gitStatus);
  appendSection('README 摘要', projectContext.readmeSummary, sectionLimits.readmeSummary);

  meta.remaining = remaining;
  return { sectionsText: sections.join('\n\n'), budgetMeta: meta };
}

export function budgetText(text, maxChars) {
  return truncateTextByBudget(text, maxChars);
}
