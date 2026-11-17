import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { loadScenarios } from '../harness/artifacts.ts';
import { evaluate } from '../eval/pipeline.ts';
import { calibration, comparison, executeBatch, executeControls } from './service.ts';
import type { Store } from './store.ts';

const version = z.enum(['v1', 'v2']).default('v2');
const profile = z.enum(['full', 'no_final_state', 'transcript_only']).default('full');
async function body(req: IncomingMessage): Promise<any> {
  let value = ''; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 100_000) throw new Error('Request too large');
    value += chunk;
  }
  return value ? JSON.parse(value) : {};
}
export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
export async function api(req: IncomingMessage, res: ServerResponse, store: Store) {
  try {
    const url = new URL(req.url!, 'http://localhost');
    const path = url.pathname;
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, { error: 'Cross-origin write rejected' }, 403);
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, { error: 'Use application/json' }, 415);
    }
    if (req.method === 'GET' && path === '/api/health') return json(res, { ok: true });
    if (req.method === 'GET' && path === '/api/scenarios') return json(res, loadScenarios());
    if (req.method === 'GET' && path === '/api/batches') return json(res, store.batches());
    if (req.method === 'POST' && path === '/api/batches') {
      const input = z.object({ agent: z.enum(['baseline', 'candidate', 'both']).default('both'), seed: z.number().int().min(0).max(0xffffffff).default(17), scenarioId: z.string().optional() }).parse(await body(req));
      const ids = (input.agent === 'both' ? ['baseline', 'candidate'] as const : [input.agent]).map(agent => executeBatch(store, agent, input.seed, input.scenarioId));
      return json(res, { ids }, 201);
    }
    if (req.method === 'POST' && path === '/api/controls') return json(res, { ids: executeControls(store) }, 201);
    if (req.method === 'GET' && path === '/api/compare') {
      const a = url.searchParams.get('a'), b = url.searchParams.get('b');
      if (!a || !b || !store.batchRuns(a).length || !store.batchRuns(b).length) return json(res, { error: 'Choose two existing batches' }, 400);
      return json(res, comparison(store, a, b));
    }
    if (req.method === 'GET' && path === '/api/calibration') return json(res, calibration(store));
    if (req.method === 'POST' && path === '/api/labels') {
      const input = z.object({ runId: z.string(), label: z.enum(['clear', 'unclear', 'insufficient_evidence']),
        rationale: z.string().trim().min(3).max(4000), reviewer: z.string().trim().min(1).max(80),
        evidence: z.array(z.string()).min(1).max(100), split: z.enum(['dev', 'held_out']) }).parse(await body(req));
      return json(res, { id: store.label(input) }, 201);
    }
    if (req.method === 'POST' && path === '/api/reviews') {
      const input = z.object({ resultId: z.string(), status: z.enum(['pass', 'fail', 'unknown', 'not_applicable']).optional(),
        reason: z.string().trim().min(3).max(4000), reviewer: z.string().trim().min(1).max(80) }).parse(await body(req));
      return json(res, { id: store.review(input) }, 201);
    }
    const rescore = path.match(/^\/api\/runs\/([^/]+)\/rescore$/);
    if (req.method === 'POST' && rescore) {
      const bundle = store.bundle(decodeURIComponent(rescore[1]));
      if (!bundle) return json(res, { error: 'Run not found' }, 404);
      const input = z.object({ version, profile }).parse(await body(req));
      const passId = store.transaction(() => store.addPass(bundle.run_id, evaluate(bundle, input)));
      return json(res, { passId }, 201);
    }
    const run = path.match(/^\/api\/runs\/([^/]+)(\/export)?$/);
    if (req.method === 'GET' && run) {
      const data = store.run(decodeURIComponent(run[1]));
      if (!data) return json(res, { error: 'Run not found' }, 404);
      if (run[2]) res.setHeader('Content-Disposition', 'attachment; filename="evaluation-run.json"');
      return json(res, data);
    }
    return json(res, { error: 'API route not found' }, 404);
  } catch (e) {
    if (e instanceof z.ZodError) return json(res, { error: e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    const message = e instanceof Error ? e.message : 'Request failed';
    return json(res, { error: message }, 400);
  }
}
