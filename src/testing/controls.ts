import { parseSlot } from '../contracts/calendar.ts';
import { FixtureAgent } from '../harness/agent.ts';
import { runScenario } from '../harness/runner.ts';
import { loadPolicy } from '../harness/artifacts.ts';
import type { Agent, AgentConfig, Policy, Scenario } from '../harness/types.ts';
export const CONTROLS = ['oracle', 'optimist', 'silent', 'over_escalator', 'stale_writer'] as const;
export type Control = typeof CONTROLS[number];
export function controlAgent(name: Control, config: AgentConfig, policy: Policy): Agent {
  const base = new FixtureAgent({ ...config, verify_writes: name !== 'optimist' }, policy);
  let step = 0;
  let firstSlot: string | undefined;
  let firstPharmacy: string | undefined;
  if (name === 'silent') return { next: () => step++ ? { type: 'end' } : { type: 'say', text: 'Okay.' } };
  if (name === 'over_escalator') return { next(o) {
    const workflow = /appointment/.test(o.messages[0]?.text ?? '') ? 'scheduling' : 'refills';
    const callback = policy.callbacks[workflow];
    if (step++ === 0) return { type: 'tool', name: 'create_review_task', args: { patient_id: o.session.patient_id,
      owner: callback.owner, reason_code: 'unnecessary_review', summary: 'Caller asked: ' + o.messages[0]?.text, callback_sla: callback.sla } };
    return step === 2 ? { type: 'say', text: `A callback request is recorded. The ${callback.owner.replaceAll("_"," ")} will call within ${callback.sla}.` } : { type: 'end' };
  } };
  return { next(o) {
    if(o.lastTool?.name==='find_pharmacies' && o.lastTool.result.status==='ok' && o.lastTool.result.data?.pharmacies?.length===1)firstPharmacy??=o.lastTool.result.data.pharmacies[0].id;
    const action = base.next(o);
    if(name==='stale_writer' && action.type==='say' && action.prompt==='confirmation' && !firstSlot)firstSlot=parseSlot(action.text,policy.timezone);
    if (name === 'stale_writer' && action.type === 'tool') {
      const callers = o.messages.filter(m => m.actor === 'caller').map(m => m.text).join(' ');
      if (action.name === 'reschedule_appointment') {
        const first = firstSlot;
        if (first) action.args.new_slot = first;
      }
      if (action.name === 'submit_refill_request') action.args.pharmacy_id = firstPharmacy ?? action.args.pharmacy_id;
    }
    return action;
  } };
}
export function runControl(scenario: Scenario, name: Control) {
  return runScenario(scenario, loadPolicy(scenario), { runId: `control-${name}-${scenario.id}`,
    agentFactory: (config, policy) => controlAgent(name, config, policy) });
}
