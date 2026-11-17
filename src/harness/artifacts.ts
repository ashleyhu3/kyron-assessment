import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import type { Policy, RunBundle, Scenario } from './types.ts';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function loadScenarios(root = PROJECT_ROOT): Scenario[] {
  return ['scheduling', 'refills'].flatMap(folder => readdirSync(join(root, 'scenarios', folder)).sort()
    .filter(f => f.endsWith('.json')).map(f => {
      const s = JSON.parse(readFileSync(join(root, 'scenarios', folder, f), 'utf8'));
      validateScenario(s);
      return s;
    }));
}
export function validateScenario(s: Scenario) {
  if (!s.synthetic || !s.id || !s.policy_id || !s.caller?.opening || !s.initial_tool_state) throw new Error('Invalid synthetic scenario');
  if (!['appointment_reschedule', 'refill_request'].includes(s.workflow)) throw new Error('Unsupported scenario workflow');
  if (!Number.isFinite(Date.parse(s.simulated_now))) throw new Error('Invalid simulated time');
  if(s.agent_visible_initial.identity_verified&&!s.agent_visible_initial.patient_id)throw new Error('Verified session requires a patient ID');
  if (!Array.isArray(s.availability) || !Array.isArray(s.faults)) throw new Error('Missing tool configuration');
  if (s.initial_tool_state.appointments === undefined || s.initial_tool_state.pharmacies === undefined) throw new Error('Missing state collections');
  for (const f of s.faults) {
    if (!['ok', 'error_definite', 'timeout_unknown'].includes(f.result)) throw new Error('Invalid fault result');
    if (f.result === 'error_definite' && f.commit) throw new Error('Definite failure cannot commit');
    if (f.delay_ms !== undefined && (!Number.isFinite(f.delay_ms) || f.delay_ms < 0)) throw new Error('Invalid fault delay');
  }
}
export function loadPolicy(scenario: Scenario, root = PROJECT_ROOT): Policy {
  if (!/^[a-zA-Z0-9_-]+$/.test(scenario.policy_id)) throw new Error('Invalid policy ID');
  const policy = JSON.parse(readFileSync(resolve(root, 'policies', `${scenario.policy_id}.json`), 'utf8'));
  if (!policy.synthetic || policy.id !== scenario.policy_id || !policy.callbacks || !policy.routing) throw new Error('Invalid policy');
  return policy;
}

export { hash, artifactHashes, validateReplay } from '../contracts/artifacts.ts';
