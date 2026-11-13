/**
 * Build identity for logs and stats. The worker version is a hash of the
 * files the worker runs; the app version is the build's git sha, or a hash
 * of the server's own sources when none was set.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;

/** First 10 hex of sha256 over the files (sorted by path): each path relative to `root`, then its bytes. */
export function hashFiles(files, root = ROOT) {
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 10);
}

/** `entry` plus every relative .js file it imports, transitively. */
export function importedFiles(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.endsWith('.js')) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const spec = match[1] || match[2] || match[3];
      const target = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) visit(target);
    }
  };
  visit(entry);
  return [...seen];
}

/** The commit label is D360_WORKER_VERSION and nothing else; RUNPOD_* vars (e.g. RUNPOD_CPU_POD_PODVERSION) are not a commit. */
export function workerCommit(env = process.env) {
  const commit = env.D360_WORKER_VERSION || null;
  return { commit, found: commit ? ['D360_WORKER_VERSION'] : [] };
}

/** `{version, commit, found}` for the worker under `root` (the repo root, /app in the image). */
export function workerVersion(root = ROOT, env = process.env) {
  // worker/handler.py is the cloud worker's entry (direct360-server); a checkout of the helper alone has none.
  const files = [path.join(root, 'worker/render.js'), path.join(root, 'worker/handler.py'), ...importedFiles(path.join(root, 'worker/render.js'))].filter((f) => fs.existsSync(f));
  const { commit, found } = workerCommit(env);
  return { version: hashFiles(files, root), commit, found };
}

/** DIRECT360_APP_VERSION (git sha set at build), else a hash of index.js and every .js, .json and .html under src/, subfolders too. */
export function appVersion(root = ROOT, env = process.env) {
  if (env.DIRECT360_APP_VERSION) return String(env.DIRECT360_APP_VERSION).trim();
  const files = fs.readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(js|json|html)$/.test(e.name))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
  const index = path.join(root, 'index.js');
  if (fs.existsSync(index)) files.push(index);
  return hashFiles(files, root);
}
