import { config as appConfig } from '../config/index.js';

export class MultiAgentThinker {
  constructor(options = {}) {
    this.apiKey = process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY || options.api_key || appConfig.agents?.['native-coder']?.api_key;
    this.apiHost = process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST || options.api_host || appConfig.agents?.['native-coder']?.api_host || 'https://api.minimaxi.com';
    this.model = process.env.OPENAI_MODEL || process.env.MINIMAX_API_MODEL || options.model || appConfig.agents?.['native-coder']?.model || 'MiniMax-Text-01';
    this.verbose = options.verbose || false;

    if (!this.apiKey) {
      throw new Error('API Key missing. Please set OPENAI_API_KEY or MINIMAX_API_KEY.');
    }
  }

  /**
   * 调用特定的 LLM 角色
   */
  async _callAgent(roleName, systemPrompt, userMessage, temperature) {
    const endpoint = this.apiHost.endsWith('/v1') 
        ? `${this.apiHost}/chat/completions` 
        : `${this.apiHost}/v1/chat/completions`;

    try {
      const payload = {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: temperature,
        max_tokens: 4096
      };
      
      if (this.apiHost.includes('minimaxi.com')) {
        payload.extra_body = { reasoning_split: true };
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(600000)
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`API Error ${res.status}: ${errorText}`);
      }

      const data = await res.json();
      if (!data.choices || data.choices.length === 0) {
        throw new Error(`API 响应结构异常`);
      }

      const msg = data.choices[0].message;
      let finalContent = '';
      
      // Extract Minimax Extra Body Reasoning Split mechanism
      if (msg.reasoning_details && msg.reasoning_details.length > 0) {
        const reasoningText = msg.reasoning_details.map(r => r.text).join('\n');
        finalContent += `<think>\n${reasoningText.trim()}\n</think>\n\n`;
      } else if (msg.reasoning_content && msg.reasoning_content.trim() !== '') {
        // Support native reasoning content fields (DeepSeek-R1 style fallback)
        finalContent += `<think>\n${msg.reasoning_content.trim()}\n</think>\n\n`;
      }
      
      finalContent += (msg.content || '').trim();
      
      return finalContent;
    } catch (error) {
      throw new Error(`[${roleName}] 调用失败: ${error.message}`);
    }
  }

  /**
   * 执行 4-Agent 多角色并行思考与总结
   */
  async think(question, onProgress) {
    const log = (msg) => {
      if (onProgress) onProgress(msg);
    };

    const sysPrompts = {
      researcher: `你是一个「研究员 (Fact-Checker)」。负责提供准确、客观的事实基础、数据或外部知识。请严格审视信息，如果不确定请坦白。字数精简，只讲重点。`,
      logician: `你是一个「逻辑学家 (Logician)」。负责严格审查逻辑链条，做逐步推理（step-by-step），找出可能的矛盾、边界情况与跳跃性结论。专注于严谨、无懈可击的推断。字数精简，直指核心。`,
      creative: `你是一个「创意人员 (Creative)」。负责发散思维，探索非传统的观点，使用生动、活泼且易懂的语气。请大胆假设、跳出框架，让答案更有趣、更具启发性。`,
      captain: `你是一个团队的「总指挥 (Captain)」。你的团队（研究员、逻辑学家、创意人员）刚刚针对用户问题进行了激烈的讨论。
你的职责：
1. 整合他们所有的有效观点。
2. 解决他们意见中的冲突。
3. 输出一个风格统一、逻辑连贯、阅读体验极佳的最终解答。
4. 【重要】你的输出直接面向最终用户，请直接回答问题，不要加入"我的团队认为"、"综合以上观点"等开场白，请展现出一位权威专家的气度。`
    };

    log('启动第一阶段：并行独立发想...');
    
    // ==========================================
    // 第一阶段：独立思考
    // ==========================================
    const round1Prompt = `用户提出了一个问题：\n"""\n${question}\n"""\n请基于你的角色给出初步解答。`;

    const [r1_researcher, r1_logician, r1_creative] = await Promise.all([
      this._callAgent('Researcher', sysPrompts.researcher, round1Prompt, 0.2),
      this._callAgent('Logician', sysPrompts.logician, round1Prompt, 0.2),
      this._callAgent('Creative', sysPrompts.creative, round1Prompt, 0.7)
    ]);

    if (this.verbose) {
      log(`\n--- 🕵️ 研究员 初稿 ---\n${r1_researcher}`);
      log(`\n--- 🧠 逻辑学家 初稿 ---\n${r1_logician}`);
      log(`\n--- 🎨 创意人员 初稿 ---\n${r1_creative}\n`);
    }

    log('启动第二阶段：交叉辩论与互相质疑...');

    // ==========================================
    // 第二阶段：交叉辩论
    // ==========================================
    const ctx = `【团队其他成员的初稿】\n\n[研究员的观点]:\n${r1_researcher}\n\n[逻辑学家的观点]:\n${r1_logician}\n\n[创意人员的观点]:\n${r1_creative}`;

    const debatePrompt = `原问题：\n${question}\n\n${ctx}\n\n请基于你的角色特点，阅读上述其他人的观点后，进行「反驳、纠正错误、补充盲区」的辩论。指出他们不合理的地方，或提出更深入的见解。字数精简，不用客气。`;

    const [r2_researcher, r2_logician, r2_creative] = await Promise.all([
      this._callAgent('Researcher', sysPrompts.researcher, debatePrompt, 0.3),
      this._callAgent('Logician', sysPrompts.logician, debatePrompt, 0.3),
      this._callAgent('Creative', sysPrompts.creative, debatePrompt, 0.7)
    ]);

    if (this.verbose) {
      log(`\n--- 🕵️ 研究员 辩论 ---\n${r2_researcher}`);
      log(`\n--- 🧠 逻辑学家 辩论 ---\n${r2_logician}`);
      log(`\n--- 🎨 创意人员 辩论 ---\n${r2_creative}\n`);
    }

    log('启动第三阶段：队长最终总结...');

    // ==========================================
    // 第三阶段：队长综合总结
    // ==========================================
    const synthesisPrompt = `原问题：\n${question}\n\n【第一轮：独立发想】\n[研究员]:\n${r1_researcher}\n[逻辑学家]:\n${r1_logician}\n[创意人员]:\n${r1_creative}\n\n【第二轮：交叉辩论】\n[研究员]:\n${r2_researcher}\n[逻辑学家]:\n${r2_logician}\n[创意人员]:\n${r2_creative}\n\n请作为队长，综合成一个完美的答案。`;

    const finalAnswer = await this._callAgent('Captain', sysPrompts.captain, synthesisPrompt, 0.5);

    log('思考完毕，成功产出最终答案。');

    return finalAnswer;
  }
}
