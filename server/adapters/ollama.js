// Ollama: is the local-model engine up, and which model is loaded. Read-only HTTP on localhost.
import { mk } from '../registry.js';

export const name = 'ollama';
export const staticIds = ['ollama'];

export async function collect({ base = 'http://127.0.0.1:11434', fetchFn = fetch } = {}) {
  try {
    const v = await (await fetchFn(`${base}/api/version`, { signal: AbortSignal.timeout(1500) })).json();
    let loaded = [];
    try {
      const ps = await (await fetchFn(`${base}/api/ps`, { signal: AbortSignal.timeout(1500) })).json();
      loaded = (ps.models || []).map((m) => m.name);
    } catch {
      /* optional */
    }
    return [
      mk('ollama', loaded.length ? 'working' : 'running', `v${v.version} · ${loaded.length ? `loaded: ${loaded.join(', ')}` : 'no model loaded'}`, { version: v.version, loaded }),
    ];
  } catch {
    return [mk('ollama', 'stopped', 'engine not running')];
  }
}
