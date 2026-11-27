import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ignoredDirs = new Set([
  '.git', 'node_modules', 'auto_qa_tests', 'testsprite_tests', 'artifacts',
  'test-results', 'playwright-report', 'coverage', '.next', 'dist', 'build'
]);
const generatedFile = /^(?:failure-step-\d+(?:-context\.json|\.png)|run-final-\d+\.png|test-report-\d+\.json|auto-qa-test-report\.md)$/i;

export async function readGitHead(projectPath) {
  try {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_COMMON_DIR;
    const { stdout } = await run('git', ['-C', path.resolve(projectPath), 'rev-parse', '--verify', 'HEAD'], {
      cwd: path.dirname(process.execPath), env, windowsHide: true, timeout: 3000
    });
    const head = stdout.trim();
    return /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}

export async function checkFailureContextFreshness(contextFilePath, projectPath = process.cwd()) {
  const root = path.resolve(projectPath);
  const file = path.resolve(root, contextFilePath);
  const raw = await fs.readFile(file, 'utf8');
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw new Error('Invalid failure context JSON.');
  }
  const capturedAt = snapshot?.capturedAt;
  const capturedMs = typeof capturedAt === 'string' ? Date.parse(capturedAt) : NaN;
  if (!Number.isFinite(capturedMs)) throw new Error('Failure context requires a valid capturedAt timestamp.');

  let latest = null;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = entry.name.toLowerCase();
      const absolute = path.join(dir, entry.name);
      if (ignoredDirs.has(name) || absolute === file || generatedFile.test(name) || /^\.auto-qa-[\da-f-]+\.tmp$/.test(name)) continue;
      if (entry.isDirectory()) pending.push(absolute);
      if (entry.isFile()) {
        try {
          const ms = Math.floor((await fs.lstat(absolute)).mtimeMs);
          latest = latest === null ? ms : Math.max(latest, ms);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
    }
  }
  const currentHead = snapshot.gitHead ? await readGitHead(root) : null;
  const gitHeadChanged = Boolean(currentHead && currentHead !== snapshot.gitHead);
  const reasons = [];
  if (latest !== null && latest > capturedMs) reasons.push('Project files changed after capture');
  if (gitHeadChanged) reasons.push('Git HEAD changed since capture');
  const reason = reasons.join('. ') || null;
  return {
    stale: Boolean(reason), reason, capturedAt,
    latestSourceChangeAt: latest === null ? null : new Date(latest).toISOString(),
    gitHeadChanged,
    warning: reason ? `Stale failure context. ${reason}. Rerun the plan before patching.` : null
  };
}
