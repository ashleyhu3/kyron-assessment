import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, loadScenarios } from '../src/harness/artifacts.ts';
import { runScenario } from '../src/harness/runner.ts';
import { proposedDate, medicationMatches } from '../src/harness/language.ts';
import { evaluate } from '../src/eval/pipeline.ts';

function run(id: string) {
  const scenario = loadScenarios().find(s => s.id === id)!;
  return runScenario(scenario, loadPolicy(scenario), { runId: `uncertainty-${id}` });
}
test('relative dates use the clinic clock, require a clock, and leave vague/multiple weekdays unresolved', () => {
  assert.equal(proposedDate('Thursday', '2026-11-30T09:00:00-05:00', 'America/New_York'), '2026-12-03');
  assert.equal(proposedDate('Thursday', '2026-12-04T09:00:00-05:00', 'America/New_York'), '2026-12-10');
  assert.equal(proposedDate('tomorrow', '2026-12-01T01:00:00Z', 'America/New_York'), '2026-12-01');
  for (const text of ['later next week', 'Thursday or Friday']) assert.equal(proposedDate(text, '2026-11-30T09:00:00Z', 'America/New_York'), undefined);
  assert.equal(proposedDate('Thursday', undefined, 'America/New_York'), undefined);
});
test('weekday interpretation is confirmed before a date search, with final slot consent before mutation', () => {
  const b = run('A6');
  const interpretation = b.trace.find(e => e.type === 'agent_message' && e.payload.text.includes('Do you mean Thursday, December 3, 2026'))!;
  const consent = b.trace.find(e => e.type === 'caller_message' && e.payload.text.includes('Yes, that is the date'))!;
  const search = b.trace.find(e => e.type === 'tool_call' && e.payload.name === 'list_available_slots')!;
  const finalConsent = b.trace.find(e => e.type === 'caller_message' && e.payload.text === 'Yes, please do that.')!;
  const write = b.trace.find(e => e.type === 'tool_call' && e.payload.name === 'reschedule_appointment')!;
  assert.ok(interpretation.seq < consent.seq && consent.seq < search.seq && search.seq < finalConsent.seq && finalConsent.seq < write.seq);
  assert.equal(search.payload.args.date, '2026-12-03');
});
test('a rejected next-week interpretation never reaches the availability tool', () => {
  const b = run('A7');
  assert.deepEqual(b.trace.filter(e => e.type === 'tool_call' && e.payload.name === 'list_available_slots').map(e => e.payload.args.date), ['2026-12-10']);
  assert.equal(b.state_snapshots.at(-1)!.state.appointments.apt_104.slot, '2026-12-10T14:00:00-05:00');
});
test('a vague afternoon preference does not select the first afternoon opening', () => {
  const b = run('A8');
  const clarification = b.trace.find(e => e.type === 'agent_message' && e.payload.text.includes('Please choose a specific time'))!;
  assert.match(clarification.payload.text, /2:00 PM or 4:00 PM/);
  const choice = b.trace.find(e => e.type === 'caller_message' && e.payload.text === '2:00 PM, please.')!;
  assert.ok(clarification.seq < choice.seq);
  assert.ok(b.trace.filter(e => e.type === 'state_change').every(e => e.seq > choice.seq));
});
test('history is read before clarification and the confirmed strength wins over the first record', () => {
  const b = run('R6');
  const lookup = b.trace.find(e => e.type === 'tool_call' && e.payload.name === 'get_medications')!;
  const clarification = b.trace.find(e => e.type === 'agent_message' && e.payload.text.includes('Your chart lists'))!;
  const identified = b.trace.find(e => e.type === 'caller_message' && e.payload.text.includes('I found my medication list'))!;
  const write = b.trace.find(e => e.type === 'tool_call' && e.payload.name === 'submit_refill_request')!;
  assert.ok(lookup.seq < clarification.seq && clarification.seq < identified.seq && identified.seq < write.seq);
  assert.match(clarification.payload.text, /Examplemed 5 mg.*Examplemed 10 mg/);
  assert.equal(write.payload.args.medication_id, 'med_001');
  assert.equal(b.trace.find(e => e.type === 'caller_message' && e.payload.text.includes('little white tablet'))!.ground_truth?.intent_updates?.medication_id, undefined);
});
test('appearance, strength alone, negation and tentative names do not establish medication identity', () => {
  const records = [{id:'first',label:'Examplemed 10 mg tablets'}];
  for (const text of ['little white tablet','10 mg',"Not Examplemed 10 mg tablets",'Maybe Examplemed 10 mg tablets']) assert.equal(medicationMatches(text, records).length, 0, text);
  assert.equal(medicationMatches('Examplemed 10 mg', records)[0].id, 'first');
});
test('unresolved history preserves the request for staff and never creates a refill', () => {
  const b = run('R7');
  assert.ok(b.trace.some(e => e.type === 'tool_call' && e.payload.name === 'get_medications'));
  assert.equal(b.trace.filter(e => e.type === 'tool_call' && e.payload.name === 'submit_refill_request').length, 0);
  const task = Object.values(b.state_snapshots.at(-1)!.state.review_tasks)[0];
  assert.equal(task.reason_code, 'medication_unverified');
  assert.match(task.summary, /little white tablet/);
});
test('ambiguous pharmacy location is clarified before refill submission', () => {
  const b = run('R8');
  const location = b.trace.find(e => e.type === 'caller_message' && e.payload.text.includes("It's the one at"))!;
  const write = b.trace.find(e => e.type === 'tool_call' && e.payload.name === 'submit_refill_request')!;
  assert.ok(location.seq < write.seq);
  assert.equal(write.payload.args.pharmacy_id, 'pharmacy_001');
});
test('all six uncertainty scenarios complete with evidence-supported expected outcomes', () => {
  for (const id of ['A6','A7','A8','R6','R7','R8']) {
    const b = run(id), result = evaluate(b);
    assert.equal(b.status, 'completed', id);
    for (const metric of ['outcome','entities','claim_support']) assert.notEqual(result.verdicts.find(v => v.metric === metric)!.status, 'fail', `${id}/${metric}`);
    assert.equal(result.verdicts.some(v => v.status === 'unknown'), false, id);
  }
});
