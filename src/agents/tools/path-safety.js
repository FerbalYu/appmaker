import path from 'path';

export function getWorkspaceRoot(config) {
  return path.resolve(config.workspace_root || process.cwd());
}

export function isWithinWorkspace(rootPath, targetPath) {
  const root = path.normalize(rootPath);
  const target = path.normalize(targetPath);
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolvePathInWorkspace(config, inputPath, fieldName = 'path') {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  const workspaceRoot = getWorkspaceRoot(config);
  const fullPath = path.resolve(workspaceRoot, inputPath);
  if (!isWithinWorkspace(workspaceRoot, fullPath)) {
    throw new Error(`${fieldName} escapes workspace`);
  }
  return fullPath;
}

export function resolveCwdInWorkspace(config, cwd) {
  if (!cwd) {
    return getWorkspaceRoot(config);
  }
  return resolvePathInWorkspace(config, cwd, 'cwd');
}
