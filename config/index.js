/**
 * 配置加载器
 */

const fs = require('fs');
const path = require('path');
const { validateConfig } = require('./schema');

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
  if (fs.existsSync(filepath)) {
    try {
      return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    } catch (e) {
      console.error(`Failed to parse ${filename}:`, e.message);
    }
  }
  return {};
}

function loadConfig() {
  const defaults = loadJson('defaults.json');
  const userConfig = loadJson('agents.json'); // Main user config for backward compatibility

  const merged = deepMerge(defaults, userConfig);
  
  validateConfig(merged);
  
  return merged;
}

const config = loadConfig();
const agents = config; // Keep export signature

module.exports = { config, agents, loadConfig };
