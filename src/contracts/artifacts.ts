import { validateStructure } from './validation.ts';
import { createHash } from 'node:crypto';
import type { RunBundle } from './types.ts';
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function artifactHashes(bundle: Omit<RunBundle, 'manifest'> | RunBundle): Record<string, string> {
  return {
    scenario: hash(bundle.scenario_snapshot), policy: hash(bundle.policy_snapshot),
    agent_config: hash(bundle.agent_config), trace: hash(bundle.trace),
    state_snapshots: hash(bundle.state_snapshots), backend_log: hash(bundle.backend_log),
  };
}
export function validateReplay(bundle: RunBundle) {
  validateStructure(bundle);
  if (bundle.schema_version !== '1.0.0' || !bundle.scenario_snapshot?.synthetic) throw new Error('Unsupported artifact bundle');
  for (const [key, value] of Object.entries(artifactHashes(bundle))) {
    if (bundle.manifest?.hashes[key] !== value) throw new Error(`Artifact hash mismatch: ${key}`);
  }
  const calls = new Set<string>(); const results = new Set<string>();
  for (let i = 0; i < bundle.trace.length; i++) {
    const e = bundle.trace[i];
    if (e.seq !== i + 1 || e.id !== `${bundle.run_id}:event:${e.seq}`) throw new Error('Invalid event sequence');
    if (e.type === 'tool_call') { if (calls.has(e.payload.call_id)) throw new Error('Duplicate call'); calls.add(e.payload.call_id); }
    if (e.type === 'tool_result') {
      if (!calls.has(e.payload.call_id) || results.has(e.payload.call_id)) throw new Error('Invalid call/result linkage');
      results.add(e.payload.call_id);
    }
  }
  if (bundle.trace.at(-1)?.type !== 'run_ended') throw new Error('Missing run end');
  if (bundle.manifest.coverage.tool_events === 'complete' && calls.size !== results.size) throw new Error('Incomplete tool log marked complete');
  return bundle;
}
