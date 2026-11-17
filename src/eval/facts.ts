import { extractClaims, assessClaims } from './claims.ts';
import { eventRef } from './types.ts';
import type { EvalInput, Facts } from './types.ts';

export function deriveFacts(input: EvalInput): Facts {
  const f: Facts = {
    input, initial: input.snapshots.find(s => s.phase === 'initial'), final: input.snapshots.find(s => s.phase === 'final'),
    changes: [], calls: input.trace.filter(e => e.type === 'tool_call').map(event => ({ event,
      result: input.trace.find(e => e.type === 'tool_result' && e.payload.call_id === event.payload.call_id),
      commit: input.trace.find(e => e.type === 'backend_operation' && e.payload.call_id === event.payload.call_id) })),
    intents: input.trace.filter(e => e.type === 'caller_message' && e.ground_truth?.intent_updates)
      .map(event => ({ seq: event.seq, values: event.ground_truth!.intent_updates!, event })),
    claims: extractClaims(input.trace,input.policy.timezone,input.snapshots.find(s=>s.phase==='initial')?.state??{}), handoffs: input.trace.filter(e => e.type === 'handoff_requested'),
    callbacks: input.trace.filter(e => e.type === 'callback_requested'), closing: input.trace.filter(e => e.type === 'agent_message').at(-1),
  };
  if (f.initial && f.final) {
    for (const collection of new Set([...Object.keys(f.initial.state), ...Object.keys(f.final.state)])) {
      const before = f.initial.state[collection] ?? {}, after = f.final.state[collection] ?? {};
      for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) f.changes.push({ path: `${collection}.${id}`,
          before: before[id] ?? null, after: after[id] ?? null, evidence: [
            { kind: 'state', snapshotId: f.initial.id, path: '' },
            { kind: 'state', snapshotId: f.final.id, path: '' },
            ...input.trace.filter(e => e.type === 'state_change' && e.payload.path === `${collection}.${id}`).map(eventRef),
          ] });
      }
    }
  }
  f.claims = assessClaims(f);
  return f;
}
export function intentAt(f: Facts, seq: number, entity: string) {
  return f.intents.filter(i => i.seq < seq && Object.hasOwn(i.values, entity)).at(-1);
}
