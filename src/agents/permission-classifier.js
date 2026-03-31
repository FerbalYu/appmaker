/**
 * AI Permission Classifier - 智能权限分类器
 * 
 * 核心功能：
 * - 基于上下文和规则的混合权限决策
 * - 自动审批低风险操作
 * - 高风险操作需要人工确认或拒绝
 * - 学习机制：记录决策历史，改进分类准确性
 * 
 * 权限等级：
 * - AUTO_ALLOW: 自动批准，无需确认
 * - AUTO_DENY: 自动拒绝
 * - NEED_CONFIRM: 需要人工确认
 * - DELEGATE_AI: AI 自主判断
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

export const PermissionLevel = {
  AUTO_ALLOW: 'auto_allow',
  AUTO_DENY: 'auto_deny',
  NEED_CONFIRM: 'need_confirm',
  DELEGATE_AI: 'delegate_ai'
};

export const RiskLevel = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
};

const DEFAULT_RULES = {
  file_read: {
    allowed_extensions: ['.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.css', '.html', '.vue', '.py', '.go', '.rs', '.java', '.kt', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf'],
    denied_paths: ['/etc/', '/sys/', '/proc/', '/dev/', '.env', '.aws/credentials', '/root/.ssh/', 'package-lock.json', 'yarn.lock'],
    risk_level: RiskLevel.LOW,
    default_action: PermissionLevel.AUTO_ALLOW
  },
  file_write: {
    allowed_extensions: ['.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.css', '.html', '.vue', '.py', '.go', '.rs', '.java', '.kt', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf'],
    denied_paths: ['/etc/', '/sys/', '/proc/', '/dev/', '/usr/bin/', '/usr/sbin/', '/bin/', '/sbin/', '.env', '.aws/credentials'],
    risk_level: RiskLevel.MEDIUM,
    default_action: PermissionLevel.NEED_CONFIRM
  },
  bash_execute: {
    allowed_commands: ['git', 'npm', 'npx', 'bun', 'node', 'python', 'python3', 'cargo', 'rustc', 'go', 'java', 'javac', 'make', 'cmake', 'ls', 'cat', 'grep', 'find', 'echo', 'pwd', 'cd', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'chmod', 'chown'],
    denied_patterns: ['rm -rf', 'dd if=', ':(){:|:&};:', 'mkfs', 'fdisk', 'shutdown', 'reboot', 'halt', 'init 0', 'kill -9', 'curl.*-o.*sh', 'wget.*sh', 'eval ', 'exec ', '> /dev/', '2>&1'],
    risk_level: RiskLevel.HIGH,
    default_action: PermissionLevel.NEED_CONFIRM
  },
  network_request: {
    allowed_domains: ['api.github.com', 'registry.npmjs.org', 'crates.io', 'pypi.org', 'api.openai.com', 'api.anthropic.com'],
    risk_level: RiskLevel.LOW,
    default_action: PermissionLevel.AUTO_ALLOW
  },
 危险操作: {
    risk_level: RiskLevel.CRITICAL,
    default_action: PermissionLevel.AUTO_DENY
  }
};

export class PermissionClassifier {
  constructor(config = {}) {
    this.config = {
      auto_allow_low_risk: true,
      auto_deny_critical: true,
      enable_ai_delegation: true,
      learn_from_history: true,
      history_file: config.history_file || './.appmaker/permission-history.jsonl',
      ...config
    };

    this.rules = { ...DEFAULT_RULES, ...config.custom_rules };
    this.decisionCache = new Map();
    this.stats = {
      total_requests: 0,
      auto_allowed: 0,
      auto_denied: 0,
      ai_delegated: 0,
      confirmed: 0
    };
  }

  /**
   * 分类工具调用的权限请求
   * @param {Object} toolCall - 工具调用请求
   * @returns {Promise<Object>} 权限决策结果
   */
  async classify(toolCall) {
    const { tool_name, arguments: args, context = {} } = toolCall;
    this.stats.total_requests++;

    const cacheKey = this._generateCacheKey(toolCall);
    if (this.decisionCache.has(cacheKey)) {
      return this.decisionCache.get(cacheKey);
    }

    const riskLevel = await this._evaluateRisk(toolCall);
    const decision = this._makeDecision(tool_name, riskLevel, toolCall);

    if (this.config.learn_from_history) {
      await this._recordDecision(toolCall, decision);
    }

    const result = { tool_name, risk_level: riskLevel, decision, tool_call: toolCall };
    this.decisionCache.set(cacheKey, result);

    if (result.decision === PermissionLevel.AUTO_ALLOW) this.stats.auto_allowed++;
    else if (result.decision === PermissionLevel.AUTO_DENY) this.stats.auto_denied++;
    else if (result.decision === PermissionLevel.DELEGATE_AI) this.stats.ai_delegated++;
    else this.stats.confirmed++;

    return result;
  }

  /**
   * 批量分类多个工具调用
   * @param {Array} toolCalls
   * @returns {Promise<Array>} 权限决策结果数组
   */
  async classifyBatch(toolCalls) {
    const results = [];
    for (const call of toolCalls) {
      results.push(await this.classify(call));
    }
    return results;
  }

  /**
   * 快速路径：基于规则的同步判断
   * @private
   */
  _quickPathDecision(toolName, args) {
    const toolLower = toolName.toLowerCase();

    if (toolLower.includes('read') || toolLower === 'read_file' || toolLower === 'read_multiple_files') {
      return this._evaluateReadOperation(args);
    }

    if (toolLower.includes('write') || toolLower.includes('edit') || toolLower.includes('create')) {
      return this._evaluateWriteOperation(args);
    }

    if (toolLower.includes('bash') || toolLower.includes('exec') || toolLower.includes('run')) {
      return this._evaluateBashOperation(args);
    }

    if (toolLower.includes('network') || toolLower.includes('http') || toolLower.includes('fetch')) {
      return this._evaluateNetworkOperation(args);
    }

    return null;
  }

  _evaluateReadOperation(args) {
    const filePath = args?.file_path || args?.path || '';
    
    for (const denied of this.rules.file_read.denied_paths) {
      if (filePath.includes(denied)) {
        return { risk: RiskLevel.HIGH, reason: `读取受限路径: ${denied}` };
      }
    }

    const ext = path.extname(filePath);
    if (ext && !this.rules.file_read.allowed_extensions.includes(ext)) {
      return { risk: RiskLevel.MEDIUM, reason: `非标准文件类型: ${ext}` };
    }

    return { risk: RiskLevel.LOW, reason: '安全文件读取' };
  }

  _evaluateWriteOperation(args) {
    const filePath = args?.file_path || args?.path || '';
    
    for (const denied of this.rules.file_write.denied_paths) {
      if (filePath.includes(denied)) {
        return { risk: RiskLevel.CRITICAL, reason: `写入系统受限路径: ${denied}` };
      }
    }

    const ext = path.extname(filePath);
    if (!this.rules.file_write.allowed_extensions.includes(ext)) {
      return { risk: RiskLevel.MEDIUM, reason: `写入非标准文件类型: ${ext}` };
    }

    return { risk: RiskLevel.MEDIUM, reason: '文件写入操作' };
  }

  _evaluateBashOperation(args) {
    const command = args?.command || args?.cmd || '';
    
    for (const denied of this.rules.bash_execute.denied_patterns) {
      if (command.toLowerCase().includes(denied.toLowerCase())) {
        return { risk: RiskLevel.CRITICAL, reason: `危险命令模式: ${denied}` };
      }
    }

    const cmdParts = command.trim().split(/\s+/);
    const baseCmd = cmdParts[0];
    
    if (!this.rules.bash_execute.allowed_commands.includes(baseCmd)) {
      return { risk: RiskLevel.HIGH, reason: `未授权命令: ${baseCmd}` };
    }

    if (command.includes('sudo') || command.includes('su ')) {
      return { risk: RiskLevel.HIGH, reason: '涉及特权执行' };
    }

    return { risk: RiskLevel.MEDIUM, reason: '命令执行' };
  }

  _evaluateNetworkOperation(args) {
    const url = args?.url || '';
    
    try {
      const hostname = new URL(url).hostname;
      if (!this.rules.network_request.allowed_domains.some(d => hostname.includes(d))) {
        return { risk: RiskLevel.MEDIUM, reason: `非白名单域名: ${hostname}` };
      }
    } catch {
      return { risk: RiskLevel.MEDIUM, reason: '无效 URL' };
    }

    return { risk: RiskLevel.LOW, reason: '安全网络请求' };
  }

  /**
   * 评估风险等级
   * @private
   */
  async _evaluateRisk(toolCall) {
    const quickResult = this._quickPathDecision(toolCall.tool_name, toolCall.arguments);
    
    if (quickResult) {
      return quickResult.risk;
    }

    if (this.config.enable_ai_delegation) {
      this.stats.ai_delegated++;
      return await this._aiEvaluateRisk(toolCall);
    }

    return RiskLevel.MEDIUM;
  }

  /**
   * AI 增强风险评估（用于复杂场景）
   * @private
   */
  async _aiEvaluateRisk(toolCall) {
    const context = toolCall.context || {};
    const history = context.task_history || [];
    const similarPast = history.filter(h => h.tool_name === toolCall.tool_name);
    
    if (similarPast.length > 5) {
      const successRate = similarPast.filter(h => h.success).length / similarPast.length;
      if (successRate > 0.95) return RiskLevel.LOW;
      if (successRate < 0.5) return RiskLevel.HIGH;
    }

    return RiskLevel.MEDIUM;
  }

  /**
   * 基于风险等级做出决策
   * @private
   */
  _makeDecision(toolName, riskLevel, toolCall) {
    if (riskLevel >= RiskLevel.CRITICAL) {
      return PermissionLevel.AUTO_DENY;
    }

    if (riskLevel <= RiskLevel.LOW && this.config.auto_allow_low_risk) {
      return PermissionLevel.AUTO_ALLOW;
    }

    if (riskLevel === RiskLevel.HIGH) {
      return PermissionLevel.NEED_CONFIRM;
    }

    return PermissionLevel.DELEGATE_AI;
  }

  /**
   * 记录决策到历史
   * @private
   */
  async _recordDecision(toolCall, decision) {
    try {
      const record = {
        timestamp: new Date().toISOString(),
        tool_name: toolCall.tool_name,
        decision: decision,
        args_hash: this._hashArgs(toolCall.arguments)
      };

      const dir = path.dirname(this.config.history_file);
      if (!require('fs').existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
      }

      await fs.appendFile(
        this.config.history_file,
        JSON.stringify(record) + '\n',
        'utf-8'
      );
    } catch (error) {
      console.warn('[PermissionClassifier] 记录决策历史失败:', error.message);
    }
  }

  _generateCacheKey(toolCall) {
    return crypto
      .createHash('sha256')
      .update(`${toolCall.tool_name}:${this._hashArgs(toolCall.arguments)}`)
      .digest('hex')
      .substring(0, 16);
  }

  _hashArgs(args) {
    return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
  }

  /**
   * 确认需要人工审批的请求
   * @param {string} toolName
   * @param {Object} args
   * @param {boolean} approved
   */
  async confirm(toolName, args, approved) {
    const decision = approved ? PermissionLevel.AUTO_ALLOW : PermissionLevel.AUTO_DENY;
    await this._recordDecision({ tool_name: toolName, arguments: args }, decision);
    return { decision, approved };
  }

  /**
   * 获取分类器统计信息
   */
  getStats() {
    return {
      ...this.stats,
      cache_size: this.decisionCache.size
    };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.stats = {
      total_requests: 0,
      auto_allowed: 0,
      auto_denied: 0,
      ai_delegated: 0,
      confirmed: 0
    };
    this.decisionCache.clear();
  }
}

export default PermissionClassifier;
