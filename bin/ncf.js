#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '..', 'cli.js');
const envPath = path.resolve(__dirname, '..', '.env');

function parseDotEnv(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex <= 0) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    const rawValue = trimmed.slice(equalIndex + 1).trim();
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;
    result[key] = value;
  }
  return result;
}

function buildChildEnv() {
  const merged = { ...process.env };
  if (!existsSync(envPath)) return merged;
  const parsed = parseDotEnv(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (!merged[key] || merged[key].length === 0) {
      merged[key] = value;
    }
  }
  return merged;
}

const child = spawn('bun', [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
  env: buildChildEnv(),
});

child.on('error', (error) => {
  if (error.code === 'ENOENT') {
    console.error('未检测到 Bun，请先安装 Bun: https://bun.sh');
    process.exit(1);
  }
  console.error(error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
