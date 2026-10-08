// Cloud routine: status lives on claude.ai, so this is a static card with a link (no network calls).
import { mk } from '../registry.js';

export const name = 'cloud';
export const staticIds = ['routine-clipflow'];

export async function collect() {
  return [
    mk('routine-clipflow', 'scheduled', 'nightly 9:30 pm ET · read-only repo review · runs on Anthropic cloud', {
      url: 'https://claude.ai/code/routines',
      note: 'Live status is on claude.ai; this card is informational.',
    }),
  ];
}
