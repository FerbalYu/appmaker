const { ExecutionEngine } = require('../src/engine.js');
const { NativeCoderAdapter } = require('../src/agents/native-coder.js');
const { NativeReviewerAdapter } = require('../src/agents/native-reviewer.js');
const fs = require('fs').promises;
const path = require('path');

// Override execute directly on the prototypes to mock networking
const originalCoderExecute = NativeCoderAdapter.prototype.execute;
NativeCoderAdapter.prototype.execute = async function(task) {
  await new Promise(r => setTimeout(r, 2000));
  
  const prompt = task.description || '';
  let tool_calls = [];
  if (prompt.includes('Button')) {
    tool_calls.push({ tool: 'write_file', args: { file_path: 'src/components/ParallelButton.js', content: 'export default function Button() {}' }});
  } else if (prompt.includes('Input')) {
    tool_calls.push({ tool: 'write_file', args: { file_path: 'src/components/ParallelInput.js', content: 'export default function Input() {}' }});
  } else if (prompt.includes('Modal')) {
    tool_calls.push({ tool: 'write_file', args: { file_path: 'src/components/ParallelModal.js', content: 'export default function Modal() {}' }});
  }

  // Execute the tools directly using UniversalToolbox to simulate writes
  const filesCreated = [];
  for (const call of tool_calls) {
    if (call.tool === 'write_file') {
      const res = await this.executeTool(call.tool, call.args);
      if (res.success) filesCreated.push(call.args.file_path);
    }
  }

  return {
    task_id: task.id,
    agent: this.name,
    status: 'success',
    output: { files_created: filesCreated, files_modified: [], summary: "Generated UI" },
    metrics: { duration_ms: 2000, tokens_used: 100 },
    errors: []
  };
};

NativeReviewerAdapter.prototype.execute = async function(task) {
  // Mock fast review 
  await new Promise(r => setTimeout(r, 200));
  return {
    task_id: task.id,
    agent: this.name,
    status: 'success',
    output: { score: 100, issues: [], summary: "LGTM" },
    metrics: { duration_ms: 200, tokens_used: 100 },
    errors: []
  };
};

async function runParallelTest() {
  console.log('=' .repeat(50));
  console.log('🚀 测试用例：无依赖任务（多目标并行并发压缩时效）');
  console.log('   说明：模拟 3 个 UI 组件生成任务。如果有并发池，它们应当约在 2~3 秒内完成，而非 6~9 秒。');
  console.log('=' .repeat(50));

  const engine = new ExecutionEngine({
    project_root: process.cwd(),
    max_concurrent_tasks: 5,  // Config allows up to 5 concurrent tasks
    token_budget: 1000000
  });

  // Ensure they are factories!
  engine.dispatcher.registerAgent('native-coder', () => new NativeCoderAdapter({
    model: 'MiniMax-Text-01', api_key: 'mock-key'
  }));
  engine.dispatcher.registerAgent('native-reviewer', () => new NativeReviewerAdapter({
    model: 'MiniMax-Text-01', api_key: 'mock-key'
  }));

  const mockPlan = {
    plan_id: "parallel_test_1",
    project: { name: "Parallel UI Generator" },
    tasks: [
      {
        id: "task_btn",
        type: "create",
        description: "Create Button UI Component",
        agent: "native-coder",
        dependencies: [] // Independent
      },
      {
        id: "task_input",
        type: "create",
        description: "Create Input UI Component",
        agent: "native-coder",
        dependencies: [] // Independent
      },
      {
        id: "task_modal",
        type: "create",
        description: "Create Modal UI Component",
        agent: "native-coder",
        dependencies: [] // Independent
      }
    ],
    milestones: [
      {
        id: "m_ui",
        name: "UI Components Generation",
        tasks: ["task_btn", "task_input", "task_modal"]
      }
    ]
  };

  const startTime = Date.now();
  
  const result = await engine.execute(mockPlan);
  
  const durationMs = Date.now() - startTime;
  
  console.log('\n' + '=' .repeat(50));
  console.log('✅ 测试运行完成');
  console.log(`⏱️ 总耗时: ${durationMs}ms`);
  
  // Validation
  const btnCreated = await fs.access(path.join(process.cwd(), 'src/components/ParallelButton.js')).then(()=>true).catch(()=>false);
  const inputCreated = await fs.access(path.join(process.cwd(), 'src/components/ParallelInput.js')).then(()=>true).catch(()=>false);
  const modalCreated = await fs.access(path.join(process.cwd(), 'src/components/ParallelModal.js')).then(()=>true).catch(()=>false);
  
  console.log('文件落盘验证:');
  console.log('- ParallelButton.js:', btnCreated ? '✅' : '❌');
  console.log('- ParallelInput.js:', inputCreated ? '✅' : '❌');
  console.log('- ParallelModal.js:', modalCreated ? '✅' : '❌');

  if (durationMs < 4000) {
    console.log(`\n🎉 并发运行成功！3 个延时 2s 的任务，在 ${durationMs}ms 内全部完成，有效压缩了等待时间跨度！`);
  } else {
    console.warn(`\n⚠️ 警告：耗时 ${durationMs}ms，似乎是以串行模式运行。请检查并发配置。`);
  }

  // Cleanup testing files
  if (btnCreated) await fs.unlink(path.join(process.cwd(), 'src/components/ParallelButton.js'));
  if (inputCreated) await fs.unlink(path.join(process.cwd(), 'src/components/ParallelInput.js'));
  if (modalCreated) await fs.unlink(path.join(process.cwd(), 'src/components/ParallelModal.js'));
  
  process.exit(0);
}

runParallelTest().catch(err => {
  console.error(err);
  process.exit(1);
});
