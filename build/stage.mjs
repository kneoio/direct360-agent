#!/usr/bin/env node
/**
 * Assembles a release package of the agent for one system, from any computer (the agent and gpmf2json are
 * cross-compiled with Zig; Node and ffmpeg are downloaded builds for that system):
 *
 *   direct360-agent(.exe)      the agent (built before this runs, passed as --agent)
 *   worker/ src/ lib/          the job pipeline from direct360-server's pipeline/ (worker/render.js and what it imports),
 *   package.json               its fonts and watermark; the pipeline's package.json makes Node read them as ES modules
 *   worker/gpmf/gpmf2json      GoPro telemetry reader, built here from the pipeline's worker/gpmf
 *   node/                      Node.js, which still runs the pipeline
 *   ffmpeg/                    static ffmpeg/ffprobe with libass (GPL; LICENSE.txt and SOURCE.txt beside them)
 *
 *   node build/stage.mjs --target windows-x64|linux-x64 --agent <agent binary> --pipeline <direct360-server>/pipeline
 *
 * Writes dist/<target>/ and dist/direct360-agent-<version>-<target>.zip (Windows) or .tar.gz (Linux).
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0 || !process.argv[at + 1]) throw new Error(`--${name} is required`);
  return process.argv[at + 1];
};
const TARGET = arg('target');
// The job pipeline: direct360-server's pipeline/ folder (one copy, shared with the server and the cloud worker).
const PIPELINE = path.resolve(arg('pipeline'));
const AGENT = path.resolve(arg('agent'));
const VERSION = fs.readFileSync(path.join(ROOT, 'build.zig.zon'), 'utf8').match(/\.version = "([^"]+)"/)[1];

/** Per target: the Zig target for gpmf2json, the executable suffix, the Node build (and where node is in it), the
 * ffmpeg build and the package's archive type. */
const TARGETS = {
  'windows-x64': {
    zig: 'x86_64-windows-gnu',
    exe: '.exe',
    node: 'win-x64.zip',
    nodeBin: 'node.exe',
    ffmpeg: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip',
    ffmpegSource: 'FFmpeg source: https://github.com/FFmpeg/FFmpeg (release/8.1). Build scripts: https://github.com/BtbN/FFmpeg-Builds',
    archive: 'zip',
  },
  'linux-x64': {
    zig: 'x86_64-linux-musl',
    exe: '',
    node: 'linux-x64.tar.xz',
    nodeBin: 'bin/node',
    ffmpeg: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz',
    ffmpegSource: 'FFmpeg source: https://github.com/FFmpeg/FFmpeg (release/8.1). Build scripts: https://github.com/BtbN/FFmpeg-Builds',
    archive: 'tar.gz',
  },
};
const T = TARGETS[TARGET];
if (!T) throw new Error(`no package is set for ${TARGET}; known: ${Object.keys(TARGETS).join(', ')}`);

const OUT = path.join(ROOT, 'dist', TARGET);
const NODE_LINE = 'latest-v22.x';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error || r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/** Unpacks a .zip or .tar.xz download into a new folder `dest`. */
function unpack(archive, dest) {
  fs.mkdirSync(dest);
  if (archive.endsWith('.zip')) run('unzip', ['-q', archive, '-d', dest]);
  else run('tar', ['-xJf', archive, '-C', dest]);
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) return full;
  }
  return null;
}

/** worker/render.js and every file it imports, relative to the pipeline folder (its own collector). */
async function pipelineFiles() {
  const { importedFiles } = await import(path.join(PIPELINE, 'src', 'version.js'));
  return importedFiles(path.join(PIPELINE, 'worker', 'render.js')).map((f) => path.relative(PIPELINE, f));
}

function copyFromPipeline(rel) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(PIPELINE, rel), dest, { recursive: true });
}

function buildGpmf() {
  const src = path.join(PIPELINE, 'worker', 'gpmf');
  const parser = path.join(src, 'third_party', 'gpmf-parser');
  const out = path.join(OUT, 'worker', 'gpmf', `gpmf2json${T.exe}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run('zig', [
    'cc', '-target', T.zig, '-O2', '-D_FILE_OFFSET_BITS=64', `-I${parser}`, `-I${path.join(parser, 'demo')}`, '-o', out,
    path.join(src, 'gpmf2json.c'), path.join(parser, 'GPMF_parser.c'), path.join(parser, 'demo', 'GPMF_mp4reader.c'), '-lm',
  ]);
  if (T.exe) fs.rmSync(out.replace(/\.exe$/, '.pdb'), { force: true });
  for (const name of ['LICENSE.txt', 'LICENSE-APACHE', 'LICENSE-MIT']) copyFromPipeline(path.join('worker', 'gpmf', 'third_party', 'gpmf-parser', name));
}

/** The newest Node 22 build for the target, checked against nodejs.org's SHASUMS256.txt. */
async function fetchNode(work) {
  const base = `https://nodejs.org/dist/${NODE_LINE}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const line = sums.split('\n').find((l) => l.trim().endsWith(`-${T.node}`));
  if (!line) throw new Error(`no ${T.node} in ${base}/SHASUMS256.txt`);
  const [sha, name] = line.trim().split(/\s+/);
  const archive = await download(`${base}/${name}`, path.join(work, name));
  const got = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (got !== sha) throw new Error(`${name}: checksum ${got} is not ${sha}`);
  const unpacked = path.join(work, 'node');
  unpack(archive, unpacked);
  const top = path.join(unpacked, name.replace(/\.(zip|tar\.xz)$/, ''));
  const dir = path.join(OUT, 'node');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(top, T.nodeBin), path.join(dir, `node${T.exe}`));
  fs.copyFileSync(path.join(top, 'LICENSE'), path.join(dir, 'LICENSE'));
  console.log(`node: ${name}`);
}

async function fetchFfmpeg(work) {
  const archive = await download(T.ffmpeg, path.join(work, path.basename(T.ffmpeg)));
  const unpacked = path.join(work, 'ffmpeg');
  unpack(archive, unpacked);
  const dir = path.join(OUT, 'ffmpeg');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [`ffmpeg${T.exe}`, `ffprobe${T.exe}`]) {
    const found = findFile(unpacked, name);
    if (!found) throw new Error(`${name} is not in the ffmpeg download`);
    fs.copyFileSync(found, path.join(dir, name));
  }
  const licence = findFile(unpacked, 'LICENSE.txt');
  if (licence) fs.copyFileSync(licence, path.join(dir, 'LICENSE.txt'));
  else fs.copyFileSync(path.join(PIPELINE, 'build', 'GPL-3.0.txt'), path.join(dir, 'LICENSE.txt'));
  fs.writeFileSync(path.join(dir, 'SOURCE.txt'), `This ffmpeg/ffprobe build is GPL software, licensed as in LICENSE.txt.\n${T.ffmpegSource}\n`);
  console.log(`ffmpeg: ${T.ffmpeg}`);
}

function notices() {
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));
  fs.writeFileSync(path.join(OUT, 'THIRD-PARTY.txt'), [
    'Direct360 agent (MIT, LICENSE) bundles:',
    '- The Direct360 job pipeline (MIT): worker/, src/, lib/.',
    '- GoPro gpmf-parser (MIT or Apache-2.0): worker/gpmf/third_party/gpmf-parser/.',
    '- Node.js (MIT and others): node/LICENSE.',
    '- ffmpeg/ffprobe (GPL): ffmpeg/LICENSE.txt and ffmpeg/SOURCE.txt.',
    '',
  ].join('\n'));
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-agent-stage-'));
try {
  fs.copyFileSync(AGENT, path.join(OUT, `direct360-agent${T.exe}`));
  for (const rel of ['package.json', 'lib/fonts', 'lib/watermark.png', ...(await pipelineFiles())]) copyFromPipeline(rel);
  fs.copyFileSync(path.join(PIPELINE, 'LICENSE'), path.join(OUT, 'worker', 'LICENSE'));
  buildGpmf();
  await fetchNode(work);
  await fetchFfmpeg(work);
  notices();
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
const packed = path.join(ROOT, 'dist', `direct360-agent-${VERSION}-${TARGET}.${T.archive}`);
fs.rmSync(packed, { force: true });
if (T.archive === 'zip') run('zip', ['-qr', packed, '.'], { cwd: OUT });
else run('tar', ['-czf', packed, '--owner=0', '--group=0', '--numeric-owner', '-C', OUT, '.']);
console.log(`staged ${OUT}\n${packed}`);
