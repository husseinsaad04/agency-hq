// Docker: OpenClaw sandbox and Hermes task containers. Read-only (`docker ps`).
import { run } from '../exec.js';
import { mk } from '../registry.js';

export const name = 'docker';
export const staticIds = ['openclaw', 'hermes'];

export function parsePs(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        const j = JSON.parse(l);
        return { name: j.Names, state: j.State, status: j.Status };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function containers() {
  const r = await run('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 4000 });
  if (r.code !== 0) throw new Error('docker not reachable');
  return parsePs(r.stdout);
}

export function buildAgents(list) {
  const oc = list.find((c) => c.name === 'openclaw-sandbox');
  const hermes = list.filter((c) => /^hermes-\d+$/.test(c.name) && c.state === 'running');
  return [
    oc
      ? mk('openclaw', oc.state === 'running' ? 'running' : 'stopped', oc.status, { container: oc.name })
      : mk('openclaw', 'stopped', 'container not created'),
    hermes.length
      ? mk('hermes', 'working', `${hermes.length} task${hermes.length === 1 ? '' : 's'} running in sandbox`, { tasks: hermes.length })
      : mk('hermes', 'standby', 'on demand (runs only when you start a task)'),
  ];
}

export async function collect() {
  return buildAgents(await containers());
}
