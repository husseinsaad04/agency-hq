// Text-in, text-out model access for the lab. The lab never gives a model tools, files or a shell.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/** Local model through Ollama (free, private). */
export function ollamaLlm({ model = 'qwen3-coder:30b', base = 'http://127.0.0.1:11434', temperature = 0.2, numPredict = 350, fetchFn = fetch } = {}) {
  return {
    name: `ollama:${model}`,
    async generate(prompt, { timeoutMs = 180000 } = {}) {
      const r = await fetchFn(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, options: { temperature, num_predict: numPredict } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`ollama answered ${r.status}`);
      return String((await r.json()).response || '');
    },
  };
}

/** Claude through the headless CLI, with ALL tools turned off. Uses your Claude plan, so it is opt-in per click. */
export function claudeLlm({ model = 'haiku', spawnFn = spawn } = {}) {
  return {
    name: `claude:${model}`,
    generate(prompt, { timeoutMs = 120000 } = {}) {
      return new Promise((resolve, reject) => {
        const env = { ...process.env, PATH: `${path.join(os.homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` };
        const child = spawnFn('claude', ['-p', '--model', model, '--tools', ''], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude timed out')); }, timeoutMs);
        child.stdout.on('data', (d) => (out += d));
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}`)); });
        child.stdin.end(prompt);
      });
    },
  };
}
