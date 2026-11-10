/**
 * The agent end to end against a stand-in Direct360 server (from direct360-helper 2.0.4's smoke test): pairs with a
 * code, comes online, takes a preview render job, renders it with worker/render.js and ffmpeg, uploads the result and
 * reports it done. Then an outdated agent: the server answers 426 and the agent stops with the update message.
 *
 * D360_SMOKE_AGENT = the agent binary (a release package's, which finds its bundled node/, ffmpeg/ and worker/),
 * D360_SMOKE_WORKER = render.js and D360_SMOKE_FFMPEG = an ffmpeg folder, for an agent run outside a package.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const EXE = process.platform === 'win32' ? '.exe' : '';
const AGENT = path.resolve(process.env.D360_SMOKE_AGENT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'zig-out', 'bin', `direct360-agent${EXE}`));
const PACKAGED = fs.existsSync(path.join(path.dirname(AGENT), 'ffmpeg', `ffmpeg${EXE}`));
const FFDIR = process.env.D360_SMOKE_FFMPEG ? path.resolve(process.env.D360_SMOKE_FFMPEG) : PACKAGED ? path.join(path.dirname(AGENT), 'ffmpeg') : null;
const FFMPEG = FFDIR ? path.join(FFDIR, `ffmpeg${EXE}`) : 'ffmpeg';
const FFPROBE = FFDIR ? path.join(FFDIR, `ffprobe${EXE}`) : 'ffprobe';
const EXTRA = [
  ...(process.env.D360_SMOKE_WORKER ? ['--worker', process.env.D360_SMOKE_WORKER] : []),
  ...(process.env.D360_SMOKE_FFMPEG ? ['--ffmpeg', process.env.D360_SMOKE_FFMPEG] : []),
];
/** A cut with a pitch pan (camera 1 at yaw -90 pitch 50 → camera 5 at yaw 0 pitch 0): ffmpeg reads a sendcmd file, whose
 * Windows path once broke the filter text. */
const PAN_EDL = [{ t: 0, camera: 1 }, { t: 1, camera: 5, panSpeed: 90 }];
const UPDATE = 'Update the Direct360 Helper: the one on your computer is out of date.';
const CONFIG = '.direct360-agent.json';

const YAWS = [-90, 0, 90, -90, 0, 90, -90, 0, 90, 100, 180, -100, 100, 180, -100, 100, 180, -100];
const PITCHES = [50, 50, 50, 0, 0, 0, -50, -50, -50, 50, 50, 50, 0, 0, 0, -50, -50, -50];

function runHelper(args, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // Without a command the Windows agent is the tray app; these runs are the terminal agent.
  const headless = args.length === 0 ? ['--headless'] : [];
  const child = spawn(AGENT, [...args, ...headless, ...EXTRA, '--verbose'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // An agent that cannot start fails the test at once instead of leaving it waiting.
  const exit = new Promise((resolve) => {
    child.on('exit', resolve);
    child.on('error', (e) => { out += `\nspawn failed: ${e.message}`; resolve(-1); });
  });
  return { child, out: () => out, exit };
}

const readBody = (req) => new Promise((resolve) => {
  const parts = [];
  req.on('data', (d) => parts.push(d));
  req.on('end', () => resolve(Buffer.concat(parts)));
});

/** A stand-in for the server's /local-worker routes and its result upload, with one job to hand out. */
async function standIn({ clip, minMajor = 2 }) {
  const state = { paired: false, online: false, job: null, done: null, chunks: new Map(), seen: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    const json = (code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    state.seen.push(`${req.method} ${url.pathname}`);
    const tooOld = (info) => Number(String(info?.version || '0').split('.')[0]) < minMajor;
    if (url.pathname === '/source.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': fs.statSync(clip).size, 'accept-ranges': 'bytes' });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(clip).pipe(res);
      return;
    }
    const part = url.pathname.match(/^\/runpod\/result\/r1\/(\d+|done)$/);
    if (part) {
      if (part[1] !== 'done') state.chunks.set(Number(part[1]), body);
      res.writeHead(200, { etag: '"x"' }).end();
      return;
    }
    if (url.pathname === '/local-worker/pair') {
      const { code, info } = JSON.parse(body);
      if (tooOld(info)) { json(426, { error: UPDATE }); return; }
      if (code !== 'ABCD-EFGH') { json(400, { error: 'bad code' }); return; }
      state.paired = true;
      json(200, { token: 't0k' });
      return;
    }
    if (req.headers.authorization !== 'Bearer t0k') { json(401, { error: 'not paired' }); return; }
    if (url.pathname === '/local-worker/hello') {
      if (tooOld(JSON.parse(body).info)) { json(426, { error: UPDATE }); return; }
      state.online = true;
      json(200, { ok: true });
      return;
    }
    if (url.pathname === '/local-worker/stats') { json(200, { ok: true }); return; }
    if (url.pathname === '/local-worker/jobs/next') {
      const job = state.job;
      state.job = null;
      if (job) json(200, job);
      else setTimeout(() => res.writeHead(204).end(), 500);
      return;
    }
    if (/^\/local-worker\/jobs\/j1\/progress$/.test(url.pathname)) { json(200, { cancelled: false }); return; }
    if (/^\/local-worker\/jobs\/j1\/done$/.test(url.pathname)) { state.done = JSON.parse(body); json(200, { ok: true }); return; }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state };
}

async function until(pred, ms, label) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('pairs, takes a preview render, renders it and reports it done', { timeout: 240000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-smoke-'));
  const clip = path.join(tmp, 'pano.mp4');
  const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1024x512:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clip], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const { server, base, state } = await standIn({ clip });
  let helper = null;
  try {
    const pairing = runHelper(['pair', 'ABCD-EFGH', '--server', base], tmp);
    assert.equal(await pairing.exit, 0, pairing.out());
    assert.ok(fs.existsSync(path.join(tmp, CONFIG)));

    helper = runHelper([], tmp);
    let ended = false;
    helper.exit.then(() => { ended = true; });
    await until(() => state.online || ended, 20000, `online\n${helper.out()}`);
    assert.ok(state.online, `the agent stopped before coming online\n${helper.out()}`);
    state.job = {
      id: 'j1',
      input: {
        task: 'render', source_url: `${base}/source.mp4`, result_url: `${base}/runpod/result/r1`,
        edl: PAN_EDL, grid: '3x7', format: 'youtube', yaws: YAWS, pitches: PITCHES,
        preview: true, watermark: false, source_is_proxy: true,
      },
    };
    await until(() => state.done, 200000, `job done\n${helper.out()}`);
    assert.equal(state.done.error, undefined, `${state.done.error}\n${helper.out()}`);
    assert.ok(state.done.output.chunks >= 1);
    const file = path.join(tmp, 'out.mp4');
    fs.writeFileSync(file, Buffer.concat([...state.chunks.keys()].sort((a, b) => a - b).map((k) => state.chunks.get(k))));
    assert.equal(fs.statSync(file).size, state.done.output.bytes);
    const probe = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    assert.match(probe.stdout.trim(), /^\d+,\d+$/);
    assert.match(helper.out(), /render done/);
  } finally {
    helper?.child.kill();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an outdated helper is refused and says to update', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-smoke-old-'));
  const { server, base } = await standIn({ clip: null, minMajor: 999 });
  try {
    const pairing = runHelper(['pair', 'ABCD-EFGH', '--server', base], tmp);
    assert.equal(await pairing.exit, 1);
    assert.ok(pairing.out().includes(UPDATE), pairing.out());
    fs.writeFileSync(path.join(tmp, CONFIG), JSON.stringify({ server: base, token: 't0k' }));
    const run = runHelper([], tmp);
    assert.equal(await run.exit, 1);
    assert.ok(run.out().includes(UPDATE), run.out());
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Windows: the tray app comes up with its icon and takes a job', { skip: process.platform !== 'win32', timeout: 240000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-tray-'));
  const clip = path.join(tmp, 'pano.mp4');
  const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1024x512:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clip], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const { server, base, state } = await standIn({ clip });
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp };
  fs.writeFileSync(path.join(tmp, CONFIG), JSON.stringify({ server: base, token: 't0k' }));
  const child = spawn(AGENT, [...EXTRA], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const logFile = path.join(tmp, '.direct360-agent.log');
  const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
  try {
    await until(() => state.online, 30000, `online\n${out}\n${logText()}`);
    state.job = {
      id: 'j1',
      input: {
        task: 'render', source_url: `${base}/source.mp4`, result_url: `${base}/runpod/result/r1`,
        edl: PAN_EDL, grid: '3x7', format: 'youtube', yaws: YAWS, pitches: PITCHES,
        preview: true, watermark: false, source_is_proxy: true,
      },
    };
    await until(() => state.done, 200000, `job done\n${logText()}`);
    assert.equal(state.done.error, undefined, `${state.done.error}\n${logText()}`);
    assert.match(logText(), /started \(tray\)/);
    assert.match(logText(), /tray icon ready/);
    assert.match(logText(), /render done/);
  } finally {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
