import { spawn } from 'node:child_process';

export const FFMPEG = process.env.D360_FFMPEG || process.env.HYPERFRAMES_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.D360_FFPROBE || process.env.HYPERFRAMES_FFPROBE || 'ffprobe';

/** Parses ffmpeg's `-progress pipe:1` key=value stream (one `out_time=
 * HH:MM:SS.microseconds` line per reported step) and calls onProgress with
 * the elapsed output time in seconds. Buffers across chunk boundaries since
 * a line can arrive split across two `data` events. */
function watchFfmpegProgress(onProgress) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    }
  };
}

export function run(bin, args, { capture = true, binary = false, onProgress, onOutput, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('stopped');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const p = spawn(bin, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'], cwd });
    let out = '', err = '';
    const chunks = [];
    const feedProgress = onProgress && watchFfmpegProgress(onProgress);
    // SIGINT is ffmpeg's own quit: it stops the encode without leaving the
    // process running. A follow-up SIGKILL covers a process that ignores it.
    let sentKill = false;
    const onAbort = () => {
      try { p.kill('SIGINT'); } catch { /* already gone */ }
      const kill = setTimeout(() => {
        sentKill = true;
        try { p.kill('SIGKILL'); } catch { /* already gone */ }
      }, 2000);
      kill.unref?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.stdout?.on('data', (d) => {
      if (binary) chunks.push(d);
      else out += d;
      feedProgress?.(d.toString());
      onOutput?.(d.toString());
    });
    p.stderr.on('data', (d) => {
      err += d;
      onOutput?.(d.toString());
    });
    p.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    p.on('close', (c, closeSignal) => {
      signal?.removeEventListener('abort', onAbort);
      if (c === 0) { resolve(binary ? Buffer.concat(chunks) : out); return; }
      // A SIGKILL we did not send is the cgroup killer. Our own abort sends
      // SIGINT, then SIGKILL only after a grace period (`sentKill`).
      const killed = c === null && closeSignal === 'SIGKILL' && !sentKill;
      if (killed) {
        const error = new Error(`${bin} was killed by SIGKILL (likely out of memory)\n${err}`);
        error.oom = true;
        reject(error);
        return;
      }
      if (signal?.aborted) {
        const stopped = new Error('stopped');
        stopped.name = 'AbortError';
        reject(stopped);
        return;
      }
      const how = c === null ? `was killed by ${closeSignal}` : `exited ${c}`;
      reject(new Error(`${bin} ${how}\n${err}`));
    });
  });
}

export async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return JSON.parse(out);
}

/** Duration and streams from the container header. Does not read the whole file. */
export async function probeHeader(file) {
  const out = await run(FFPROBE, [
    '-v', 'error',
    '-probesize', '5000000',
    '-analyzeduration', '1000000',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return JSON.parse(out);
}
