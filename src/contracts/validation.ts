import { z } from 'zod';
import type { RunBundle } from './types.ts';

const text = z.string().trim().min(1).max(32_000);
const record = z.record(z.unknown());
const payloads: Record<string, z.ZodTypeAny> = {
  caller_message: z.object({ text }), agent_message: z.object({ text }),
  tool_call: z.object({ call_id: z.string().min(1), name: z.string().min(1), args: record, mutating: z.boolean() }),
  tool_result: z.object({ call_id: z.string().min(1), name: z.string().min(1), result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), data: record, latency_ms: z.number().nonnegative(), operation_id: z.string().optional() }),
    z.object({ status: z.literal('error_definite'), error: text, latency_ms: z.number().nonnegative(), operation_id: z.string().optional() }),
    z.object({ status: z.literal('timeout_unknown'), error: text, latency_ms: z.number().nonnegative(), operation_id: z.string().optional() }),
  ]) }),
  backend_operation: z.object({ call_id: z.string(), name: z.string(), committed: z.boolean() }),
  state_change: z.object({ call_id: z.string(), path: z.string().regex(/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/), before: z.unknown(), after: z.unknown() }),
  handoff_requested: record, callback_requested: record,
  run_started: record, run_ended: z.object({ reason: text, status: z.enum(['completed', 'incomplete']) }),
  state_snapshot: z.object({ phase: z.enum(['initial','final']) }), error: z.object({ message: text }),
};
const event = z.object({ id: z.string().min(1), seq: z.number().int().positive(), response_cycle: z.number().int().nonnegative(),
  sim_time: z.string().datetime(), actor: z.enum(['caller','agent','tool','backend','harness']),
  visibility: z.enum(['agent','evaluator_only']), type: z.string(), payload: record,
  ground_truth: z.object({ intent_updates: record.optional(), discloses: z.array(z.string()).optional(), ambiguous_entities: z.array(z.string()).optional() }).optional(),
}).superRefine((e, ctx) => {
  const schema = payloads[e.type];
  if (!schema || !schema.safeParse(e.payload).success) ctx.addIssue({ code: 'custom', message: `Invalid ${e.type} payload` });
});
export function validateStructure(bundle: RunBundle) {
  z.object({ trace: z.array(event).min(1).max(10_000), backend_log: z.array(event),
    state_snapshots: z.array(z.object({ id: z.string(), phase: z.enum(['initial','final']), at_seq: z.number().int(), state: z.record(z.record(record)) })),
    manifest: z.object({ coverage: z.record(z.enum(['complete','partial','unavailable'])), hashes: z.record(z.string()) }),
  }).parse(bundle);
  if (new Set(bundle.trace.map(e=>e.id)).size !== bundle.trace.length) throw new Error('Duplicate event identity');
  const calls=new Map<string, typeof bundle.trace[number]>();
  let lastTime=-Infinity, lastCycle=0;
  for (const e of bundle.trace) {
    if (Date.parse(e.sim_time)<lastTime || e.response_cycle<lastCycle) throw new Error('Non-monotonic event time/cycle');
    lastTime=Date.parse(e.sim_time);lastCycle=e.response_cycle;
    if(e.type==='tool_call')calls.set(e.payload.call_id,e);
    if(e.type==='tool_result'){
      const call=calls.get(e.payload.call_id);
      if(!call || call.payload.name!==e.payload.name)throw new Error('Tool response does not match its call');
    }
    if(e.type==='state_change'||e.type==='backend_operation') {
      const call=calls.get(e.payload.call_id);
      if(!call?.payload.mutating)throw new Error('Backend event has no preceding mutating call');
    }
  }
  if(bundle.manifest.coverage.backend_log==='complete' && JSON.stringify(bundle.backend_log)!==JSON.stringify(bundle.trace.filter(e=>e.actor==='backend')))throw new Error('Backend log disagrees with trace');
}

// Validate a complete event-sourced history without consulting policy or outcome
// expectations. Partial histories must not be promoted to authoritative state.
export function provenanceComplete(bundle: RunBundle): boolean {
  if(bundle.manifest.coverage.backend_log!=='complete'||bundle.manifest.coverage.initial_state!=='complete'||bundle.manifest.coverage.final_state!=='complete')return false;
  const initial=bundle.state_snapshots.find(s=>s.phase==='initial'), final=bundle.state_snapshots.find(s=>s.phase==='final');
  if(!initial||!final)return false;
  const state=structuredClone(initial.state);
  for(const e of bundle.trace.filter(e=>e.type==='state_change')) {
    const [collection,id]=e.payload.path.split('.');
    const commit=bundle.trace.find(x=>x.type==='backend_operation'&&x.payload.call_id===e.payload.call_id&&x.payload.committed&&x.seq<e.seq);
    if(!commit||JSON.stringify(state[collection]?.[id]??null)!==JSON.stringify(e.payload.before))return false;
    state[collection]??={};
    if(e.payload.after===null)delete state[collection][id];else state[collection][id]=structuredClone(e.payload.after);
  }
  return JSON.stringify(state)===JSON.stringify(final.state);
}
