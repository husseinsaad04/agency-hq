import { execFile } from 'node:child_process';

const PATH_PREFIX = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** Run a program with fixed argv (never a shell). Always resolves; never throws. */
export function run(file, args = [], { timeout = 4000, env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: 2_000_000, cwd, env: { ...process.env, PATH: `${PATH_PREFIX}:${process.env.PATH || ''}`, ...env } },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: Boolean(err && err.killed),
        });
      }
    );
  });
}
