import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerUtilityTools(toolbox) {
  toolbox._registerTool(
    'regex_search',
    TOOL_CATEGORIES.UTILITY,
    '正则表达式搜索',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        flags: { type: 'string', default: 'g' },
        content: { type: 'string' },
      },
      required: ['pattern', 'content'],
    },
    async (args) => {
      try {
        const regex = new RegExp(args.pattern, args.flags);
        const matches = [...args.content.matchAll(regex)];
        return {
          matches: matches.map((m) => ({
            match: m[0],
            index: m.index,
            groups: m.groups || null,
          })),
          count: matches.length,
        };
      } catch (err) {
        return { error: `Invalid regex: ${err.message}` };
      }
    },
  );

  toolbox._registerTool(
    'json_parse',
    TOOL_CATEGORIES.UTILITY,
    '解析 JSON',
    {
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
    },
    async (args) => {
      try {
        return { parsed: JSON.parse(args.content), success: true };
      } catch (err) {
        return { error: `JSON parse error: ${err.message}`, success: false };
      }
    },
  );

  toolbox._registerTool(
    'yaml_parse',
    TOOL_CATEGORIES.UTILITY,
    '解析 YAML',
    {
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
    },
    async (args) => {
      try {
        const { parse } = await import('yaml');
        return { parsed: parse(args.content), success: true };
      } catch (err) {
        return { error: `YAML parse error: ${err.message}`, success: false };
      }
    },
  );

  toolbox._registerTool(
    'template_render',
    TOOL_CATEGORIES.UTILITY,
    '模板渲染',
    {
      type: 'object',
      properties: {
        template: { type: 'string' },
        variables: { type: 'object' },
      },
      required: ['template', 'variables'],
    },
    async (args) => {
      let result = args.template;
      for (const [key, value] of Object.entries(args.variables)) {
        const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        result = result.replace(regex, String(value));
      }
      return { rendered: result, success: true };
    },
  );
}
