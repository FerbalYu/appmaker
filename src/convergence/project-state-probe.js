import { promises as fs } from 'fs';
import path from 'path';

export class ProjectStateProbe {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      strict: config.strict === true,
      bootstrap_dirs: config.bootstrap_dirs || ['src', 'config', 'tests', 'logs'],
      bootstrap_files: config.bootstrap_files || ['README.md'],
    };
  }

  async collectProjectState(projectRoot) {
    const root = projectRoot || process.cwd();
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files = [];
    const directories = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        directories.push(entry.name);
      } else {
        files.push(entry.name);
      }
    }

    return {
      project_root: root,
      files,
      directories,
      captured_at: new Date().toISOString(),
    };
  }

  async evaluateTaskState(task, projectRoot) {
    const requiredArtifacts = this._inferRequiredArtifacts(task);
    if (requiredArtifacts.length === 0) {
      return {
        status: 'unknown',
        already_satisfied: false,
        required_artifacts: [],
        missing_artifacts: [],
        reason: 'no_inferable_artifacts',
      };
    }

    const checks = await Promise.all(
      requiredArtifacts.map(async (artifact) => ({
        artifact,
        exists: await this._exists(path.join(projectRoot, artifact)),
      })),
    );
    const missing = checks.filter((item) => !item.exists).map((item) => item.artifact);

    return {
      status: missing.length === 0 ? 'already_satisfied' : 'not_satisfied',
      already_satisfied: missing.length === 0,
      required_artifacts: requiredArtifacts,
      missing_artifacts: missing,
      reason: missing.length === 0 ? 'all_required_artifacts_exist' : 'missing_required_artifacts',
    };
  }

  _inferRequiredArtifacts(task = {}) {
    const inferred = new Set();
    const description = String(task.description || '').toLowerCase();
    const taskFiles = Array.isArray(task.files) ? task.files : [];

    for (const file of taskFiles) {
      if (typeof file === 'string' && file.trim()) {
        inferred.add(file.replace(/\\/g, '/'));
      }
    }

    if (description.includes('初始化') && description.includes('结构')) {
      for (const dir of this.config.bootstrap_dirs) inferred.add(dir);
      for (const file of this.config.bootstrap_files) inferred.add(file);
    }

    if (description.includes('.gitignore')) inferred.add('.gitignore');
    if (description.includes('pyproject')) inferred.add('pyproject.toml');
    if (description.includes('package.json')) inferred.add('package.json');
    if (description.includes('requirements')) inferred.add('requirements.txt');
    if (description.includes('readme')) inferred.add('README.md');

    return [...inferred];
  }

  async _exists(targetPath) {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}

export default ProjectStateProbe;
