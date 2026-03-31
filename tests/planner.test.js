const { Planner } = require('../src/planner');

describe('Planner', () => {
  let planner;

  beforeEach(() => {
    planner = new Planner();
    // mock api calls
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
});
