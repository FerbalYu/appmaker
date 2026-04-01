import { ExecutionEngine } from './src/engine.js';
import fs from 'fs';

async function main() {
  const engine = new ExecutionEngine({ project_root: 'd:/roguelike' });
  const plan = {
    project: { name: 'Test Plan' },
    tasks: [
      {
        id: 'task-test-tracker',
        description:
          '必须使用 bash_execute 工具执行命令 `echo "test content" > test_file_tracked.txt`。不要使用 write_file 工具。',
        agent: 'native-coder',
        dependencies: [],
      },
    ],
    milestones: [{ id: 'm1', name: 'test_milestone', tasks: ['task-test-tracker'] }],
    dependencies: {},
  };

  engine.on('task:start', ({ task }) => console.log('🟢 START', task.id));
  engine.on('task:review', ({ task, result }) =>
    console.log(
      '🔍 REVIEW',
      task.id,
      result?.output?.files || 'no files in output?',
      result?.output?.issues || 'no issues in output?',
    ),
  );
  engine.on('task:done', ({ task, result }) => {
    console.log('✅ DONE', task.id);
    console.log(
      'Final Result CodeResult Files:',
      result.code_result.output.files_created,
      result.code_result.output.files_modified,
    );
  });

  await engine.execute(plan);

  // Clean up
  try {
    fs.unlinkSync('d:/roguelike/test_file_tracked.txt');
  } catch (e) {
    /* ignore cleanup errors */
  }
}

main().catch(console.error);
