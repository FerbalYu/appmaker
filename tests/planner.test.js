const { Planner } = require('../src/planner');

describe('Planner', () => {
  let planner;

  beforeEach(() => {
    // mock api calls
    jest.spyOn(require('../src/thinker').MultiAgentThinker.prototype, 'think').mockResolvedValue('Mocked thought process...');
    planner = new Planner();
    planner.dispatcher = {
       dispatch: jest.fn().mockResolvedValue({
         output: {
            raw_output: JSON.stringify({
              project: { name: 'test_project', description: 'test' },
              features: ['f1', 'f2'],
              tasks: [
                { id: 't1', type: 'create', description: 'desc', estimated_tokens: 1000 },
                { id: 't2', type: 'create', description: 'desc2', estimated_tokens: 2000 }
              ],
              milestones: [
                { id: 'm1', name: 'Milestone 1', tasks: ['t1', 't2'] }
              ]
            })
         }
       })
    };
  });

  it('generates a fallback plan for simple requirements', () => {
    const defaultPlanText = "做一个博客系统";
    const plan = planner._generateFallbackPlan(defaultPlanText);

    expect(plan).toBeDefined();
    expect(plan.project.name).toContain('blog');
    expect(plan.tasks.length).toBeGreaterThan(0);
    expect(plan.milestones.length).toBeGreaterThan(0);
    
    // Check milestones have valid tasks
    plan.milestones.forEach(m => {
       m.tasks.forEach(tId => {
          expect(plan.tasks.find(t => t.id === tId)).toBeDefined();
       });
    });
  });

  it('parses AI JSON output correctly', async () => {
    const plan = await planner.plan("做一个带用户认证的商城系统");
    
    expect(planner.dispatcher.dispatch).toHaveBeenCalled();
    expect(plan.tasks.length).toBe(2);
    expect(plan.metadata.estimated_tokens).toBe(3000);
  });

  it('uses rainmaker plan when requirement is empty mode', async () => {
    planner.dispatcher.dispatch.mockResolvedValueOnce({
      output: {
        plan: {
          project: { name: 'rainmaker_project', description: 'audit plan' },
          features: ['runability', 'pitfall', 'optimization'],
          tasks: [
            { id: 't1', type: 'modify', description: '修复启动错误', estimated_tokens: 1200 },
            { id: 't2', type: 'modify', description: '修复阻塞问题', estimated_tokens: 1800, dependencies: ['t1'] },
            { id: 't3', type: 'test', description: '补充验证测试', estimated_tokens: 900, dependencies: ['t2'] }
          ],
          milestones: [
            { id: 'm1', name: '先能跑', tasks: ['t1', 't2'] },
            { id: 'm2', name: '再验证', tasks: ['t3'] }
          ],
          audit: {
            runability_score: 55,
            pitfall_score: 52,
            optimization_score: 68,
            findings: []
          }
        }
      }
    });

    const plan = await planner.planByRainmaker({ requirement: 'auto audit' });

    expect(planner.dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'rainmaker',
        type: 'analysis'
      })
    );
    expect(plan.project.name).toBe('rainmaker_project');
    expect(plan.tasks.length).toBe(3);
  });
});
