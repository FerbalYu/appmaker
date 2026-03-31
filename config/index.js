/**
 * 配置加载器
 * Bun 下可直接用 import JSON（原生支持）
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 深度合并对象
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && key in target) {
      Object.assign(source[key], deepMerge(target[key], source[key]));
    }
  }
  Object.assign(target || {}, source);
  return target;
}

function loadJson(filename) {
  const filepath = path.join(__dirname, filename);
  if (existsSync(filepath)) {
    try {
      return JSON.parse(readFileSync(filepath, 'utf-8'));
    } catch (e) {
      console.error(`Failed to parse ${filename}:`, e.message);
    }
  }
  return {};
}

function loadConfig() {
  const defaults = loadJson('defaults.json');
  const userConfig = loadJson('agents.json');

  const merged = deepMerge(defaults, userConfig);
  validateConfig(merged);
  return merged;
}

export const config = loadConfig();
export const agents = config;
export { loadConfig };
