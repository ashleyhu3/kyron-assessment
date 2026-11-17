import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { PROJECT_ROOT } from '../harness/artifacts.ts';
import { Store } from './store.ts';
import { seedExamples } from './service.ts';
import { api } from './api.ts';

const store = new Store(process.env.KYRON_DB ?? join(PROJECT_ROOT, 'data/kyron.sqlite'));
seedExamples(store);
const dev = process.argv.includes('--dev');
const vite = dev ? await (await import('vite')).createServer({ root: PROJECT_ROOT, server: { middlewareMode: true }, appType: 'spa' }) : undefined;
const dist = join(PROJECT_ROOT, 'dist');
if (!dev && !existsSync(join(dist, 'index.html'))) throw new Error('Frontend build missing. Run npm run build first, or use npm run dev.');
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/')) { void api(req, res, store); return; }
  if (vite) { vite.middlewares(req, res); return; }
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const file = resolve(dist, '.' + path);
  if (!file.startsWith(dist + '/') && file !== dist) { res.writeHead(403); res.end(); return; }
  const target = existsSync(file) && extname(file) ? file : join(dist, 'index.html');
  try {
    const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(target)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' }); res.end(readFileSync(target));
  } catch { res.writeHead(404); res.end('Not found'); }
});
const port = Number(process.env.PORT ?? 4173);
server.listen(port, '127.0.0.1', () => console.log(`Kyron evaluation workbench: http://127.0.0.1:${port}`));
async function stop() { server.close(); await vite?.close(); store.close(); }
process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
