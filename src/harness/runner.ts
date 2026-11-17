import { randomUUID } from 'node:crypto';
import type { Agent, AgentConfig, Observation, Policy, RunBundle, Scenario } from './types.ts';
import { CONFIGURATIONS, FixtureAgent } from './agent.ts';
import { ScriptedCaller } from './caller.ts';
import { Recorder } from './recorder.ts';
import { SimulatedTools } from './tools.ts';
import { artifactHashes, validateScenario } from './artifacts.ts';

export function visibleObservation(session: Observation['session'], recorder: Recorder,
  lastTool?: Observation['lastTool']): Observation {
  const visibleSession={...session};
  if(!visibleSession.identity_verified)delete visibleSession.patient_id;
  return structuredClone({ session:visibleSession, messages: recorder.events
    .filter(e => e.visibility === 'agent' && ['caller_message', 'agent_message'].includes(e.type))
    .map(e => ({ actor: e.actor as 'caller' | 'agent', text: e.payload.text })),
    ...(lastTool ? { lastTool } : {}),
  });
}

export function runScenario(scenario: Scenario, policy: Policy, options: {
  configuration?: keyof typeof CONFIGURATIONS; seed?: number; trial?: number; runId?: string;
  maxResponseCycles?: number; maxSteps?: number;
  agentConfig?: {id:string;version:string};
  agentFactory?: (config: AgentConfig, policy: Policy) => Agent;
} = {}): RunBundle {
  validateScenario(scenario);
  if (scenario.policy_id !== policy.id) throw new Error('Policy snapshot mismatch');
  const maxCycles = options.maxResponseCycles ?? 12;
  const maxSteps = options.maxSteps ?? 100;
  if (![maxCycles, maxSteps].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Run limits must be positive integers');
  const seed = options.seed ?? scenario.seed;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be an unsigned 32-bit integer');
  const config = { ...CONFIGURATIONS[options.configuration ?? 'candidate'], ...options.agentConfig, seed };
  const recorder = new Recorder(options.runId ?? randomUUID(), scenario.simulated_now);
  const caller = new ScriptedCaller(structuredClone(scenario),policy.timezone);
  const tools = new SimulatedTools(structuredClone(scenario), recorder,policy.timezone,policy);
  const snapshots: RunBundle['state_snapshots'] = [];
  function snapshot(phase: 'initial' | 'final') {
    const e = recorder.append('harness', 'state_snapshot', { phase });
    snapshots.push({ id: `${recorder.runId}:state:${phase}`, phase, at_seq: e.seq, state: structuredClone(tools.state) });
  }
  recorder.append('harness', 'run_started', { identity_verified: scenario.agent_visible_initial.identity_verified, patient_id: scenario.caller.facts.patient_id, harness_version: '1.7.0', max_response_cycles: maxCycles, max_steps: maxSteps });
  snapshot('initial');
  let endReason = 'step_limit';
  let lastTool: Observation['lastTool'];
  let session: Observation['session']={...scenario.agent_visible_initial,reference_time:scenario.simulated_now};
  if(!session.identity_verified)delete session.patient_id;
  try {
    const agent = (options.agentFactory ?? ((c, p) => new FixtureAgent(c, p)))(structuredClone(config), structuredClone(policy));
    const opening = caller.opening();
    recorder.append('caller', 'caller_message', { text: opening.text }, 'agent', opening.truth);
    recorder.responseCycle = 1;
    for (let step = 0; step < maxSteps; step++) {
      const action = agent.next(visibleObservation(session, recorder, lastTool));
      if (!action || !['say','tool','end'].includes(action.type) || (action.type==='say' && (typeof action.text!=='string'||!action.text.trim()))) throw new Error('Agent returned an invalid action; next must return a synchronous Action');
      if (action.type === 'end') { endReason = action.reason ?? 'agent_ended'; break; }
      if (action.type === 'tool') {
        lastTool = { name: action.name, args: structuredClone(action.args), result: tools.call(action.name, action.args) };
        if(action.name==='verify_patient' && lastTool.result.status==='ok' && lastTool.result.data?.verified===true)session={...session,identity_verified:true,patient_id:lastTool.result.data.patient_id};
      } else {
        recorder.append('agent', 'agent_message', { text: action.text }, 'agent');
        if (action.prompt) {
          const response = caller.respond(action.prompt, action.text);
          if (!response) { endReason = 'caller_unresponsive'; break; }
          if (recorder.responseCycle >= maxCycles) { endReason = 'turn_limit'; break; }
          recorder.append('caller', 'caller_message', { text: response.text }, 'agent', response.truth);
          recorder.responseCycle++;
          lastTool = undefined;
        }
      }
    }
  } catch (e) {
    endReason = 'harness_error';
    recorder.append('harness', 'error', { message: e instanceof Error ? e.message : String(e) });
  } finally {
    snapshot('final');
    recorder.append('harness', 'run_ended', { reason: endReason, status: ['agent_ended','handoff_pending'].includes(endReason) ? 'completed' : 'incomplete' });
  }
  const calls = recorder.events.filter(e => e.type === 'tool_call');
  const results = recorder.events.filter(e => e.type === 'tool_result');
  const bundle: RunBundle = {
    schema_version: '1.0.0', harness_version: '1.7.0', run_id: recorder.runId,
    scenario_snapshot: structuredClone(scenario), policy_snapshot: structuredClone(policy),
    agent_config: config, seed, trial: options.trial ?? 0, trace: recorder.events,
    state_snapshots: snapshots, backend_log: recorder.events.filter(e => e.actor === 'backend'),
    status: ['agent_ended','handoff_pending'].includes(endReason) ? 'completed' : 'incomplete', end_reason: endReason,
    manifest: { coverage: {
      conversation: 'complete', tool_events: calls.length === results.length ? 'complete' : 'partial',
      intent_annotations: 'complete', initial_state: 'complete', final_state: 'complete',
      backend_log: 'complete', handoff_requests: 'complete', handoff_acceptance: 'unavailable',
      real_audio: 'unavailable',
    }, hashes: {} },
  };
  bundle.manifest.hashes = artifactHashes(bundle);
  return bundle;
}
