# Agents 大修计划（反低效循环与高 Token 浪费专项）

更新时间: 2026-04-07  
状态: In Progress（A/B 已落地，C/D/E 部分落地）

## 1. 背景与问题定义

当前 `native-coder` + `native-reviewer` 在复杂任务下会进入“低收益反复修复”循环，表现为：

- 评审失败后反复修复，循环次数极高（日志可达 50+ 轮）。
- Token 持续消耗但产出质量不显著提升。
- 运行时间可超过 100 分钟，执行链路仍未收敛。
- Reviewer 偶发 JSON 解析失败，会进一步放大重试开销。
- 部分轮次审查输入不足（如文件数为 0）仍进入正常评审流程，导致“盲审”。

本计划目标不是“简单设置上限止损”，而是通过**治理闭环质量**来实现“可持续自动化”。

---

## 2. 总体改造目标

### 2.1 业务目标

- 将“高循环低收益”任务的平均修复轮次降低 60% 以上。
- 将“无效 Token 消耗占比”降低 50% 以上。
- 将“长时间运行未收敛”场景从常态变为异常（可观测、可熔断、可接管）。

### 2.2 工程目标

- 建立统一的“进展判定”框架，不再仅依赖固定分数阈值。
- 建立“重复问题指纹”与“收益递减”检测机制。
- 建立“输入有效性门禁”与“审查输出鲁棒解析”机制。
- 建立“自动降级 + 人工接管”的标准化收敛路径。

### 2.3 设计原则

- 先治理控制面，再优化模型提示词。
- 判定逻辑可解释、可审计、可复盘。
- 失败不重试同一路径，优先策略切换。
- 每个阶段可独立上线与回滚。

---

## 3. 架构大修蓝图

### 3.1 新增核心模块

1. `ReviewConvergenceController`（收敛控制器）  
   职责：

- 维护修复轮次状态。
- 判断是否进入收益递减。
- 决定继续自动修复 / 降级策略 / 人工接管。

2. `IssueFingerprintEngine`（问题指纹引擎）  
   职责：

- 将 reviewer issues 规范化（severity + file + title + normalized reason）。
- 计算跨轮次问题相似度与重复率。
- 产出“重复修复信号”供控制器使用。

3. `ReviewInputGate`（评审输入门禁）  
   职责：

- 校验待评审文件、代码内容、diff、上下文是否达到最小有效输入。
- 拒绝“空输入评审”并返回结构化错误。

4. `ReviewerOutputParser`（评审输出解析器）  
   职责：

- 支持多级解析（原始 JSON -> repair -> fenced-json 提取 -> 结构映射）。
- 统一 parse error 语义与可重试分类。

5. `ExecutionPolicyEngine`（执行策略引擎）  
   职责：

- 统一重试、降级、熔断、接管策略（避免分散在 engine/coder/reviewer）。

6. `ProgressLedger`（进展账本）  
   职责：

- 记录每轮 score、问题数、CRITICAL 数、变更文件数、变更行数、token 增量。
- 为收益递减判断提供客观依据。

### 3.2 现有模块职责重划分

- `engine.js`：从“流程+策略混杂”改为“流程编排层”。
- `native-reviewer.js`：聚焦“审查执行 + 结果结构化”，不再承担过多收敛决策。
- `native-coder.js`：聚焦“执行修改动作”，不承担评审策略判断。
- `dispatcher.js`：聚焦调度与资源控制，不介入业务收敛判定。

---

## 4. 分阶段实施计划（大修版本）

### 当前执行进展（2026-04-07）

- 已完成：Phase A 核心控制面（Controller/Fingerprint/Ledger/Policy）接入 `engine.js`。
- 已完成：Phase B 输入门禁与解析器（Gate/Parser + 错误码）接入 `native-reviewer.js`。
- 已完成：Phase C（差异化补丁任务 + 局部回滚再修复）在 `engine.js` 落地。
- 已完成：Phase D（质量指标 + 结构化日志 + 报警规则）已写入 `summary` 与运行日志。
- 已完成：Phase E（Feature Flags + A/B Shadow + 快速回滚 + 观察窗口 + 评估报告）已接入并验证。

## Phase A：控制面重构（第一优先级）

目标：先建立“会停、会降级、会接管”的控制系统。

- [x] A1 新增 `ReviewConvergenceController`
- [x] A2 实现收益递减判定（窗口 N=3，可配置）
- [x] A3 实现重复问题判定（指纹相似度阈值，可配置）
- [x] A4 实现“连续 parse 失败熔断”
- [x] A5 实现“自动接管输出包”（停止原因 + 最后有效建议 + 待人工动作）

交付物：

- 新增控制器模块及单测。
- `engine.js` 接入控制器决策流。

验收标准：

- 出现重复低收益时，不进入无限修复循环。
- 每次停止均有可解释 stop reason 与证据字段。

---

## Phase B：评审链路重构（第二优先级）

目标：让 reviewer 输入可靠、输出稳定、失败可分类。

- [x] B1 新增 `ReviewInputGate`，实现“无有效输入拒审”
- [x] B2 新增 `ReviewerOutputParser`，实现解析回退骨架
- [x] B3 统一 reviewer 错误码（`PARSE_FAILED`, `EMPTY_INPUT`, `INVALID_SCHEMA`, `API_ERROR`）
- [x] B4 评审输出 schema 强校验（score/issues 结构与字段类型）
- [x] B5 重试策略由“通用重试”改为“错误分类重试”

交付物：

- reviewer 输入门禁、解析器、错误分类模块与测试。

验收标准：

- parse 失败不再无限重试。
- 空输入评审不会给出正常评分并触发循环。

---

## Phase C：修复策略升级（第三优先级）

目标：从“反复改”升级为“有针对性改”。

- [x] C1 将 reviewer issues 映射为“修复任务队列”（按严重级分组）
- [x] C2 修复提示词改为“差异化补丁任务”而非全文重写
- [x] C3 引入“未变化检测”（文件哈希/摘要）避免伪修复（最小可用版本）
- [x] C4 引入“关键问题优先闭环”（CRITICAL 清零优先，按严重级队列优先）
- [x] C5 支持“局部回滚 + 再修复”策略

交付物：

- 修复任务编排器、差异化 prompt builder、变更有效性检测器。

验收标准：

- 修复轮次减少，关键问题消失速度提升。
- “改了但没用”比例显著下降。

---

## Phase D：观测与运营化（第四优先级）

目标：把“是否有效”变成可度量事实。

- [x] D1 新增收敛指标：`convergence_rate`, `avg_cycles`, `diminishing_abort_rate`
- [x] D2 新增成本指标：`tokens_per_success_task`, `wasted_token_ratio`
- [x] D3 新增质量指标：`critical_clearance_time`, `repeat_issue_rate`
- [x] D4 新增运行看板日志格式（结构化 JSON）
- [x] D5 新增报警规则（长时运行、异常重试、解析失败风暴）

交付物：

- 指标采集点、日志结构、报告脚本。

验收标准：

- 能快速定位“为何烧 token、卡在哪个环节、是否值得继续自动化”。

---

## Phase E：灰度、回滚与发布（第五优先级）

目标：大修可控落地，不影响现网稳定性。

- [x] E1 Feature Flags：按模块灰度（Controller/Gate/Parser/Fingerprint）
- [x] E2 A/B 对比（旧流程 vs 新流程，Shadow 基础版）
- [x] E3 失败快速回滚策略（模块级开关）
- [x] E4 发布后 7 天观察窗口
- [x] E5 输出最终评估报告（成本、时延、质量三维）

---

## 5. 关键算法与判定策略

## 5.1 收益递减判定（建议）

输入：最近 3 轮记录  
字段：`score_delta`, `critical_delta`, `issue_repeat_rate`, `file_change_effective`

判定条件（示例）：

- `score_delta < 3` 连续 2 轮；
- 且 `critical_delta == 0`；
- 且 `issue_repeat_rate > 0.7`；
- 且有效文件变更不足阈值。

动作：

- 触发 `DIMINISHING_RETURNS`；
- 停止自动修复，转“人工接管建议包”。

## 5.2 重复问题指纹（建议）

指纹组成：

- `severity + normalized(file) + normalized(title) + normalized(reason)`。

相似度建议：

- 字段完全一致记 1.0；
- 标题/原因做规范化后编辑距离比对；
- 轮次重复率超过阈值触发 `REPEATED_ISSUE_LOOP`。

## 5.3 评审输入门禁（建议）

拒审条件（任一命中）：

- 待审查文件为空；
- 文件读取全部失败；
- 代码内容为空或仅占位符；
- 本轮无有效修改却请求“重新评审”。

拒审结果：

- 返回结构化失败，不进入评分比较与修复循环。

---

## 6. 配置项规划（新增）

建议新增配置（可热更新）：

- `convergence.window_size`
- `convergence.min_score_delta`
- `convergence.max_repeat_issue_rate`
- `convergence.max_parse_failures`
- `convergence.handoff_enabled`
- `review.input_gate_enabled`
- `review.parser_fallback_enabled`
- `review.retry_by_error_code`

---

## 7. 测试与验收计划

## 7.1 单元测试

- `ReviewConvergenceController` 判定覆盖：
  - 正常推进
  - 收益递减
  - 重复问题
  - 解析失败熔断
- `IssueFingerprintEngine`：
  - 稳定性与去噪
  - 多语言/路径格式兼容
- `ReviewInputGate`：
  - 空输入拒审
  - 部分输入容错
- `ReviewerOutputParser`：
  - 多种脏输出格式恢复
  - 非法输出分类

## 7.2 集成测试

- 构造“长期低分反复修复”场景，验证自动收敛到接管路径。
- 构造“review parse 抖动”场景，验证不会无限重试。
- 构造“文件未变更但反复评审”场景，验证被门禁拦截。

## 7.3 回归测试

- 既有 `agents`/`permission-toolbox` 测试必须全绿。
- 增加“长任务稳态测试”与“成本回归测试”。

---

## 8. 风险与回滚

### 8.1 主要风险

- 误判收益递减，过早停止自动化。
- 指纹过严导致“应修复问题”被归类重复。
- 解析器回退策略过宽导致错误吞噬。

### 8.2 缓解策略

- 阈值可配置并灰度放量。
- 所有熔断决策写入证据字段，便于人工复核。
- 关键决策引入“软停止”（先提示，可手动继续）模式。

### 8.3 回滚策略

- 按 Feature Flag 模块级回滚，不做全量回退。
- 保持旧流程可并行运行，支持快速切回。

---

## 9. 里程碑与工期评估（建议）

- M1（1 周）：Phase A 控制面重构 + 单测。
- M2（1 周）：Phase B 评审链路重构 + 单测/集成。
- M3（1 周）：Phase C 修复策略升级 + 集成测试。
- M4（0.5 周）：Phase D 指标化 + 看板日志。
- M5（0.5 周）：Phase E 灰度发布 + 报告。

总计建议：约 4 周（可按人力并行压缩）。

---

## 10. 执行清单（可直接跟踪）

- [ ] 建立分支：`feat/agents-convergence-overhaul`
- [ ] 完成 Phase A 设计评审
- [ ] 完成 Phase A 开发与测试
- [ ] 完成 Phase B 开发与测试
- [ ] 完成 Phase C 开发与测试
- [ ] 完成 Phase D 指标接入
- [ ] 完成 Phase E 灰度与评估
- [ ] 输出《大修验收报告》

---

## 11. 参考（对标思路来源）

本计划对标 `Open-ClaudeCode` 的治理思想（非一比一复制）：

- 多层防回环（错误路径短路、阻断继续）。
- 进展/收益驱动而非纯次数驱动。
- 大输出预算控制与落盘稳定重放。
- 钩子化策略与可观测闭环。
