// Offline SDK replay helper. No auth store or network is used.
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createPlugin } from '../src/plugin.mjs';
import { BASE } from '../src/session.mjs';

const raw = await readFile(process.argv[2]);
const plugin = await createPlugin({ client: {} }, { fetchImpl: async () =>
  new Response(raw, { headers: { 'content-type': 'text/event-stream' } }) });
const loader = await plugin.auth.loader(async () => ({ access: 'offline-placeholder' }));
const response = await loader.fetch(`${BASE}/chat/completions`, {
  method: 'POST', body: JSON.stringify({ model: 'offline-fixture', messages: [], stream: true }),
});
await pipeline(Readable.fromWeb(response.body), process.stdout);
