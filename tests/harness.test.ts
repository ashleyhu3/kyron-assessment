import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactHashes, loadScenarios, loadPolicy, validateReplay, PROJECT_ROOT } from '../src/harness/artifacts.ts';
import { runScenario } from '../src/harness/runner.ts';
import { SimulatedTools } from '../src/harness/tools.ts';
import { Recorder } from '../src/harness/recorder.ts';
import type { Agent, Observation, Scenario, RunBundle } from '../src/harness/types.ts';

const scenarios = loadScenarios();
function scenario(id: string): Scenario { return structuredClone(scenarios.find(s => s.id === id)!); }
function run(id: string, configuration: 'baseline' | 'candidate' = 'candidate', overrides: any = {}): RunBundle {
  const s = scenario(id);
  return runScenario(s, loadPolicy(s), { configuration, runId: `test-${id}`, ...overrides });
}
function final(b: RunBundle) { return b.state_snapshots.find(s => s.phase === 'final')!.state; }
function calls(b: RunBundle, name: string) { return b.trace.filter(e => e.type === 'tool_call' && e.payload.name === name); }

test('all scenarios run in both configurations with linked and replayable artifacts', () => {
  assert.ok(scenarios.length >= 16);
  assert.equal(new Set(scenarios.map(s=>s.id)).size,scenarios.length);
  for (const s of scenarios) for (const configuration of ['baseline', 'candidate'] as const) {
    const before = structuredClone(s);
    const b = runScenario(s, loadPolicy(s), { configuration, runId: `${configuration}-${s.id}` });
    assert.equal(b.status, 'completed', `${configuration}/${s.id}`);
    assert.deepEqual(s, before);
    assert.doesNotThrow(() => validateReplay(JSON.parse(JSON.stringify(b))));
    assert.equal(b.manifest.coverage.handoff_acceptance, 'unavailable');
    for (const e of b.trace.filter(e => e.type === 'state_change')) assert.ok(b.trace.some(c => c.type === 'tool_call' && c.payload.call_id === e.payload.call_id));
  }
});

test('scenario isolation and reproducibility include full event ordering and seeded language', () => {
  const s = scenario('A5'); const before = structuredClone(s);
  const first = runScenario(s, loadPolicy(s), { runId: 'repeat', seed: 17 });
  assert.deepEqual(first, runScenario(s, loadPolicy(s), { runId: 'repeat', seed: 17 }));
  assert.deepEqual(s, before);
  assert.notDeepEqual(run('A1', 'candidate', { seed: 17 }).trace, run('A1', 'candidate', { seed: 18 }).trace);
});

for (const [id, entity, tool, argument] of [
  ['A2', 'slot', 'reschedule_appointment', 'new_slot'],
  ['R2', 'pharmacy_id', 'submit_refill_request', 'pharmacy_id'],
]) test(`${id}: separate caller correction precedes a write using the corrected entity`, () => {
  const b = run(id);
  const updates = b.trace.filter(e => e.ground_truth?.intent_updates?.[entity]);
  assert.equal(updates.length, 2);
  assert.notEqual(updates[0].ground_truth!.intent_updates![entity], updates[1].ground_truth!.intent_updates![entity]);
  assert.ok(b.trace.some(e => e.actor === 'agent' && e.seq > updates[0].seq && e.seq < updates[1].seq));
  const write = calls(b, tool)[0];
  assert.ok(write.seq > updates[1].seq);
  assert.equal(write.payload.args[argument], updates[1].ground_truth!.intent_updates![entity]);
});

test('A3: caller can reject an available alternative without a write or callback', () => {
  const b = run('A3');
  assert.equal(calls(b, 'reschedule_appointment').length, 0);
  assert.equal(calls(b, 'create_review_task').length, 0);
  assert.equal(final(b).appointments.apt_104.slot, scenario('A3').initial_tool_state.appointments.apt_104.slot);
  assert.ok(b.trace.some(e => e.actor === 'caller' && /Keep my original/.test(e.payload.text)));
});

for (const id of ['A4', 'R3', 'R4']) test(`${id}: callback records preserve owner, reason, and caller context`, () => {
  const b = run(id); const tasks = Object.values(final(b).review_tasks);
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.equal(task.patient_id, 'patient_001');
  assert.equal(task.owner, id.startsWith('A') ? 'scheduling_team' : 'refill_team');
  assert.equal(task.callback_sla, 'one business day');
  assert.ok(task.reason_code && task.summary.includes('Caller requested'));
  const created = b.trace.find(e => e.type === 'callback_requested')!;
  assert.ok(b.trace.some(e => e.type === 'agent_message' && e.seq > created.seq && e.payload.text.includes('within one business day')));
  assert.equal(Object.keys(final(b).refill_requests).length, 0);
});

test('baseline and candidate differ after definite failure, not ordinary success', () => {
  assert.equal(Object.keys(final(run('A4', 'baseline')).review_tasks).length, 0);
  assert.ok(run('A4', 'baseline').trace.some(e => e.type === 'agent_message' && /booked|moved/.test(e.payload.text)));
  assert.equal(final(run('A1', 'candidate')).appointments.apt_104.slot, final(run('A1', 'baseline')).appointments.apt_104.slot);
});

test('A5: hidden commit precedes timeout; only candidate obtains confirmation', () => {
  for (const configuration of ['baseline', 'candidate'] as const) {
    const b = run('A5', configuration);
    const commit = b.trace.find(e => e.type === 'backend_operation' && e.payload.name === 'reschedule_appointment')!;
    const timeout = b.trace.find(e => e.type === 'tool_result' && e.payload.result.status === 'timeout_unknown')!;
    assert.equal(commit.payload.committed, true); assert.ok(commit.seq < timeout.seq);
    assert.equal(commit.visibility, 'evaluator_only');
    assert.equal(final(b).appointments.apt_104.slot, scenario('A5').caller.facts.desired_slot);
    assert.equal(Object.keys(final(b).appointments).length, 1);
    assert.equal(calls(b, 'get_operation_status').length, configuration === 'candidate' ? 1 : 0);
    if (configuration === 'candidate') {
      const confirmation = b.trace.find(e => e.type === 'tool_result' && e.payload.name === 'get_operation_status')!;
      const close = b.trace.filter(e => e.type === 'agent_message').at(-1)!;
      assert.ok(confirmation.seq < close.seq);
    }
  }
});

test('R5: symptom becomes observable mid-call, routing occurs in the next response cycle', () => {
  const b = run('R5');
  assert.deepEqual(b.trace.find(e => e.type === 'caller_message')!.ground_truth?.discloses, []);
  const trigger = b.trace.find(e => e.ground_truth?.discloses?.includes('symptom:chest_tightness'))!;
  const request = calls(b, 'request_handoff')[0];
  assert.ok(trigger.seq < request.seq);
  assert.equal(request.response_cycle, trigger.response_cycle + 1);
  assert.ok(request.payload.args.summary.includes('chest tightness'));
  assert.equal(calls(b, 'submit_refill_request').length, 0);
  assert.equal(Object.values(final(b).handoffs)[0].status, 'requested');
  assert.equal(b.trace.filter(e => e.type === 'handoff_accepted').length, 0);
});

test('agent adapter never receives future facts, fault configuration, annotations, or backend events', () => {
  const seen: Observation[] = [];
  const s = scenario('R5');
  runScenario(s, loadPolicy(s), { agentFactory: () => ({ next(o) {
    seen.push(o);
    assert.deepEqual(Object.keys(o).sort(), ['messages', 'session']);
    o.session.patient_id = 'changed';
    return { type: 'end' };
  } }) });
  const encoded = JSON.stringify(seen);
  for (const forbidden of ['ground_truth', 'expected', 'faults', 'intent_updates', 'backend_log', 'chest tightness']) assert.ok(!encoded.includes(forbidden));
  assert.equal(s.agent_visible_initial.patient_id, 'patient_001');
});

test('unsupported request ends without changing state', () => {
  const s = scenario('A1'); s.caller.opening = 'Can you explain my insurance bill?';
  const b = runScenario(s, loadPolicy(s));
  assert.deepEqual(final(b), s.initial_tool_state);
  assert.equal(b.trace.filter(e => e.type === 'tool_call').length, 0);
  assert.ok(b.trace.some(e => e.type === 'agent_message' && e.payload.text.includes('contact the clinic')));
});

test('turn limit, step limit, caller refusal, and agent error retain final artifacts with explicit end reasons', () => {
  const looping: Agent = { next: () => ({ type: 'say', text: 'Waiting.' }) };
  const crashing: Agent = { next: () => { throw new Error('synthetic_agent_error'); } };
  const s = scenario('A1'); s.caller.behavior.disclose_details_when_asked = false;
  const unresponsive = runScenario(s, loadPolicy(s));
  const bundles = [run('A1', 'candidate', { maxResponseCycles: 1 }),
    run('A1', 'candidate', { maxSteps: 3, agentFactory: () => looping }),
    run('A1', 'candidate', { agentFactory: () => crashing }), unresponsive];
  assert.deepEqual(bundles.map(b => b.end_reason), ['turn_limit', 'step_limit', 'harness_error', 'caller_unresponsive']);
  for (const b of bundles) {
    assert.equal(b.status, 'incomplete');
    assert.equal(b.state_snapshots.length, 2);
    assert.equal(b.trace.at(-1)!.type, 'run_ended');
    assert.doesNotThrow(() => validateReplay(b));
  }
});

test('uncertain status and failed callback do not become a false callback promise', () => {
  const s = scenario('A5');
  s.caller.behavior.accept_review_offer = true;
  s.faults.push({ tool: 'get_operation_status', result: 'timeout_unknown' },
    { tool: 'create_review_task', result: 'error_definite', commit: false });
  const b = runScenario(s, loadPolicy(s));
  assert.ok(b.trace.some(e => e.type === 'agent_message' && e.payload.text.includes('cannot confirm whether')));
  assert.equal(Object.keys(final(b).review_tasks).length, 0);
  assert.ok(b.trace.some(e => e.type === 'agent_message' && e.payload.text.includes('no callback is confirmed')));
});

test('failed urgent connection stays unresolved without routine refill or invented acceptance', () => {
  const s = scenario('R5'); s.faults = [{ tool: 'request_handoff', result: 'error_definite', commit: false }];
  const b = runScenario(s, loadPolicy(s));
  assert.equal(Object.keys(final(b).handoffs).length, 0);
  assert.equal(Object.keys(final(b).refill_requests).length, 0);
  assert.ok(b.trace.some(e => e.type === 'agent_message' && e.payload.text.includes('remains unresolved')));
});

test('timeout-before-commit is verifiable failure and does not imply success', () => {
  const s = scenario('A5'); s.faults[0].commit = false; s.caller.behavior.accept_review_offer = true;
  const b = runScenario(s, loadPolicy(s));
  assert.equal(final(b).appointments.apt_104.slot, s.initial_tool_state.appointments.apt_104.slot);
  const failureRead=b.trace.find(e=>e.type==='tool_result' && e.payload.name==='get_operation_status' && e.payload.result.data?.status==='failed')!;
  assert.ok(failureRead);
  assert.ok(b.trace.some(e=>e.type==='agent_message' && e.seq>failureRead.seq && /request did not complete/.test(e.payload.text)));
  assert.equal(Object.keys(final(b).review_tasks).length, 1);
});

test('idempotent write retry after timeout cannot create a duplicate or change the payload under the same key', () => {
  const s = scenario('R1'); s.faults = [{ tool: 'submit_refill_request', result: 'timeout_unknown', commit: true }];
  const recorder = new Recorder('retry', s.simulated_now); const tools = new SimulatedTools(s, recorder);
  const args = { patient_id: 'patient_001', medication_id: 'med_001', pharmacy_id: 'pharmacy_001', idempotency_key: 'same' };
  assert.equal(tools.call('submit_refill_request', args).status, 'timeout_unknown');
  assert.equal(tools.call('submit_refill_request', args).status, 'ok');
  assert.equal(Object.keys(tools.state.refill_requests).length, 1);
  assert.equal(tools.call('submit_refill_request', { ...args, pharmacy_id: 'pharmacy_002' }).error, 'idempotency_key_conflict');
  assert.equal(Object.keys(tools.state.refill_requests).length, 1);
});

test('missing or mismatched medication, pharmacy, and patient are rejected without writes', () => {
  const s = scenario('R1'); const tools = new SimulatedTools(s, new Recorder('validation', s.simulated_now));
  const args = { patient_id: 'patient_001', medication_id: 'med_001', pharmacy_id: 'pharmacy_001', idempotency_key: 'new' };
  for (const change of [{ medication_id: 'med_999' }, { pharmacy_id: 'pharmacy_999' }, { patient_id: 'patient_999' }, { medication_id: '' }]) {
    assert.equal(tools.call('submit_refill_request', { ...args, ...change }).status, 'error_definite');
  }
  assert.equal(Object.keys(tools.state.refill_requests).length, 0);
});

test('replay detects changed evidence and a missing result', () => {
  const b = run('A5');
  const changed = structuredClone(b); changed.trace[0].payload.tampered = true;
  assert.throws(() => validateReplay(changed), /hash mismatch/);
  const missing = structuredClone(b);
  missing.trace = missing.trace.filter(e => !(e.type === 'tool_result' && e.payload.name === 'get_operation_status'));
  missing.trace.forEach((e, i) => { e.seq = i + 1; e.id = `${missing.run_id}:event:${e.seq}`; });
  missing.manifest.hashes = artifactHashes(missing);
  assert.throws(() => validateReplay(missing), /Incomplete tool log/);
});

test('CLI writes immutable outputs, supports replay, and rejects invalid run parameters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyron-harness-'));
  const execute = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', 'src/harness/cli.ts', ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  try {
    const out = join(dir, 'bundle');
    assert.equal(execute(['run', '--scenario', 'A5', '--out', out]).status, 0);
    assert.equal(readdirSync(out).length, 3);
    const before = readFileSync(join(out, 'candidate-A5.json'), 'utf8');
    assert.notEqual(execute(['run', '--scenario', 'A5', '--out', out]).status, 0);
    assert.equal(readFileSync(join(out, 'candidate-A5.json'), 'utf8'), before);
    assert.equal(execute(['replay', join(out, 'candidate-A5.json')]).status, 0);
    assert.notEqual(execute(['run', '--max-turns', '-1']).status, 0);
    assert.notEqual(execute(['run', '--scenario', 'does-not-exist']).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary rescheduling finds the current appointment before asking a date, lists matching openings, and waits for selection/consent', () => {
 const b=run('A1');const speech=b.trace.filter(e=>e.type==='caller_message'||e.type==='agent_message');
 assert.equal(speech[0].payload.text,"Hi, I'd like to reschedule my appointment.");
 const lookup=calls(b,'get_appointment')[0],availability=calls(b,'list_available_slots')[0],write=calls(b,'reschedule_appointment')[0];
 assert.equal(lookup.payload.args.current_date,'2026-12-01');assert.equal(lookup.payload.args.appointment_id,undefined);
 const preferenceQuestion=speech.find(e=>/What date would you like/.test(e.payload.text))!;
 assert.ok(lookup.seq<preferenceQuestion.seq&&preferenceQuestion.seq<availability.seq);
 assert.equal(availability.payload.args.date,'2026-12-03');
 const returned=b.trace.find(e=>e.type==='tool_result'&&e.payload.name==='list_available_slots')!;
 assert.deepEqual(returned.payload.result.data.slots,['2026-12-03T09:00:00-05:00','2026-12-03T14:00:00-05:00']);
 const options=speech.find(e=>/9:00 AM or 2:00 PM available/.test(e.payload.text))!;
 const choice=speech.find(e=>e.actor==='caller'&&e.payload.text==='2:00 PM works for me.')!;
 const consent=speech.find(e=>e.actor==='caller'&&e.payload.text==='Yes, please do that.')!;
 assert.ok(returned.seq<options.seq&&options.seq<choice.seq&&choice.seq<consent.seq&&consent.seq<write.seq);
 assert.equal(write.payload.args.new_slot,'2026-12-03T14:00:00-05:00');
 assert.ok(speech.every(e=>!/apt_\d|\d{4}-\d{2}-\d{2}T/.test(e.payload.text)),'Spoken dialogue should not expose internal IDs or machine timestamps');
});

test('a corrected appointment date triggers a fresh date-specific availability query before committing',()=>{
 const b=run('A2');const searches=calls(b,'list_available_slots');
 assert.deepEqual(searches.map(e=>e.payload.args.date),['2026-12-01','2026-12-03']);
 const correction=b.trace.find(e=>e.actor==='caller'&&e.payload.text.startsWith('Actually'))!;
 assert.ok(searches[1].seq>correction.seq&&searches[1].seq<calls(b,'reschedule_appointment')[0].seq);
});

for(const id of ['R1','R2','R3','R4','R5'])test(`${id}: realistic refill conversation avoids internal IDs and gathers information before action`,()=>{
 const b=run(id);const speech=b.trace.filter(e=>['caller_message','agent_message'].includes(e.type));
 assert.ok(speech.every(e=>!/\b(?:med|pharmacy|patient|apt)_\d+\b|tool reported|error_definite|timeout_unknown/.test(e.payload.text)));
 const nameQuestion=speech.find(e=>e.actor==='agent'&&/name and strength/.test(e.payload.text))!;
 const medication=speech.find(e=>e.actor==='caller'&&e.seq>nameQuestion.seq)!;
 assert.ok(nameQuestion.seq<medication.seq);
 if(id==='R5') {
  assert.equal(calls(b,'submit_refill_request').length,0);assert.equal(calls(b,'find_pharmacies').length,0);
  assert.equal(b.end_reason,'handoff_pending');
  assert.equal(b.manifest.coverage.handoff_acceptance,'unavailable');
 } else if(id==='R3') {
  assert.ok(speech.some(e=>e.actor==='agent'&&/prescription bottle/.test(e.payload.text)));
  assert.equal(calls(b,'submit_refill_request').length,0);
 } else {
  const lookup=calls(b,'get_medications')[0],pharmacyQuestion=speech.find(e=>e.actor==='agent'&&/Which pharmacy/.test(e.payload.text))!;
  const pharmacyLookup=calls(b,'find_pharmacies')[0],write=calls(b,'submit_refill_request')[0];
  assert.ok(medication.seq<lookup.seq&&lookup.seq<pharmacyQuestion.seq&&pharmacyQuestion.seq<pharmacyLookup.seq&&pharmacyLookup.seq<write.seq);
  const lastConsent=speech.filter(e=>e.actor==='caller'&&e.payload.text==='Yes, please do that.').at(-1)!;
  assert.ok(lastConsent.seq<write.seq);
 }
});

test('pharmacy correction is resolved from its name/address and reconfirmed before submission',()=>{
 const b=run('R2'),lookups=calls(b,'find_pharmacies');
 assert.equal(lookups.length,2);assert.match(lookups[0].payload.args.query,/Maple Pharmacy/);assert.match(lookups[1].payload.args.query,/Harbor Pharmacy/);
 assert.equal(calls(b,'submit_refill_request')[0].payload.args.pharmacy_id,'pharmacy_003');
});

test('same-name pharmacies require a location rather than choosing the first result',()=>{
 const s=scenario('R1');s.caller.behavior.pharmacy_name_only=true;
 const b=runScenario(s,loadPolicy(s));
 assert.ok(b.trace.some(e=>e.type==='agent_message'&&/more than one location/.test(e.payload.text)));
 assert.equal(calls(b,'submit_refill_request')[0].payload.args.pharmacy_id,'pharmacy_001');
});
