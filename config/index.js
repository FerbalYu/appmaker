/**
 * 配置加载器
 */

const fs = require('fs');
const path = require('path');

function loadConfig(name = 'agents') {
  const configPath = path.join(__dirname, `${name}.json`);
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  return {};
}

const agents = loadConfig('agents');

module.exports = { agents, loadConfig };
