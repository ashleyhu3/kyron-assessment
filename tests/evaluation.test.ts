import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { artifactHashes, loadPolicy, loadScenarios } from '../src/harness/artifacts.ts';
import { runScenario } from '../src/harness/runner.ts';
import { evaluate } from '../src/eval/pipeline.ts';
import { extractClaims } from '../src/eval/claims.ts';
import { compareRuns } from '../src/eval/compare.ts';
import { runControl } from '../src/testing/controls.ts';
import type { RunBundle, Event } from '../src/harness/types.ts';
const scenarios = loadScenarios();
const run = (id: string, configuration: 'candidate' | 'baseline' = 'candidate') => {
  const s = scenarios.find(s => s.id === id)!; return runScenario(s, loadPolicy(s), { runId: id, configuration });
};
const verdict = (b: RunBundle, metric: string) => evaluate(b).verdicts.find(v => v.metric === metric)!;
const rehash = (b: RunBundle) => { b.manifest.hashes = artifactHashes(b); return b; };

test('candidate suite has no metric errors, unsupported certainty, or unknown results with complete evidence', () => {
  for (const s of scenarios) {
    const evaluation = evaluate(run(s.id));
    if(['I3','I4','I5','I6'].includes(s.id)){assert.equal(evaluation.gate,'INCOMPLETE',s.id);assert.equal(evaluation.verdicts.find(v=>v.metric==='outcome')!.reasonCode,'task_unresolved');assert.equal(evaluation.verdicts.find(v=>v.metric==='identity_access')!.status,'pass');assert.equal(evaluation.counts.unknown,1);}
    else {assert.equal(evaluation.gate, 'CLEAR', `${s.id}: ${JSON.stringify(evaluation.verdicts.filter(v => v.status === 'fail' || v.status === 'unknown'))}`);assert.equal(evaluation.counts.unknown, 0);}
  }
});
test('A5 separates successful outcome and unsupported baseline claim from verified candidate communication', () => {
  assert.equal(verdict(run('A5', 'baseline'), 'outcome').status, 'pass');
  assert.equal(verdict(run('A5', 'baseline'), 'claim_support').status, 'fail');
  assert.equal(verdict(run('A5'), 'claim_support').status, 'pass');
});
test('control signatures distinguish silence, optimism, unnecessary escalation, and stale entity writes', () => {
  for (const [control, id, metric, status, reason] of [
    ['oracle', 'A5', 'claim_support', 'pass', 'supported'],
    ['optimist', 'A4', 'claim_support', 'fail', 'unsupported_claim'],
    ['silent', 'A1', 'outcome', 'fail', 'no_acceptable_outcome'],
    ['silent', 'A1', 'claim_support', 'unknown', 'no_status_statement_extracted'],
    ['over_escalator', 'A1', 'escalation_decision', 'fail', 'unnecessary_escalation'],
    ['stale_writer', 'A2', 'entities', 'fail', 'stale_value'],
    ['stale_writer', 'R2', 'outcome', 'fail', 'forbidden_outcome'],
  ] as const) {
    const s = scenarios.find(s => s.id === id)!;
    const v = verdict(runControl(s, control), metric);
    assert.equal(v.status, status, `${control}/${id}/${metric}`); assert.equal(v.reasonCode, reason);
  }
});
test('masked state and transcript-only scoring return unknown rather than invented conclusions', () => {
  const noState = evaluate(run('A5'), { profile: 'no_final_state' });
  assert.equal(noState.verdicts.find(v => v.metric === 'outcome')!.status, 'unknown');
  assert.equal(noState.verdicts.find(v => v.metric === 'claim_support')!.status, 'pass');
  const transcript = evaluate(run('A5'), { profile: 'transcript_only' });
  assert.equal(transcript.gate, 'INCOMPLETE');
  assert.ok(transcript.verdicts.every(v => v.status === 'unknown'));
});
test('moving a claim before confirmation produces premature certainty', () => {
  const b = run('A1');
  const close = b.trace.find(e => e.type === 'agent_message' && /booked|appointment is moved/.test(e.payload.text))!;
  b.trace = b.trace.filter(e => e !== close);
  const resultIndex = b.trace.findIndex(e => e.type === 'tool_result' && e.payload.name === 'reschedule_appointment');
  b.trace.splice(resultIndex, 0, close);
  b.trace.forEach((e, i) => { e.seq = i + 1; });
  // IDs remain unique identities; normalize them for the strict harness sequence validator.
  b.trace.forEach(e => { e.id = `${b.run_id}:event:${e.seq}`; e.sim_time = new Date(Date.parse(b.scenario_snapshot.simulated_now) + e.seq).toISOString(); });
  b.backend_log = b.trace.filter(e => e.actor === 'backend'); rehash(b);
  const result = evaluate(b);
  assert.equal(result.facts.claims.find(c=>c.type==='appointment_moved')!.status, 'premature');
  assert.equal(result.gate, 'WARN');
});
test('collateral mutations and incomplete handoff context are evidence-linked failures', () => {
  const b = run('A1'); b.state_snapshots[1].state.medications.med_001.label = 'Changed'; rehash(b);
  assert.equal(verdict(b, 'outcome').reasonCode, 'collateral_change');
  const h = run('R5'); h.trace.find(e => e.type === 'handoff_requested')!.payload.summary = 'Caller denies chest tightness.';
  h.backend_log = h.trace.filter(e => e.actor === 'backend'); rehash(h);
  assert.equal(verdict(h, 'handoff_integrity').status, 'fail');
});
test('trace identity and configuration changes do not change evaluator decisions', () => {
  const b = run('A5'), other = structuredClone(b);
  other.scenario_snapshot.id = 'unseen-id'; other.agent_config.id = 'unseen-agent'; rehash(other);
  assert.deepEqual(evaluate(b), evaluate(other));
});
test('changed artifacts become diagnostic unknowns instead of passing or crashing', () => {
  const b = run('A5'); b.trace[0].payload.modified = true;
  const e = evaluate(b); assert.equal(e.counts.unknown, 7); assert.equal(e.gate, 'INCOMPLETE');
});
test('paired comparison excludes incompatible versions and unknowns', () => {
  const a = run('A5', 'baseline'), b = run('A5');
  const row = compareRuns([{ bundle: a, evaluation: evaluate(a) }], [{ bundle: b, evaluation: evaluate(b) }])[0];
  assert.equal(row.metrics.find(m => m.metric === 'claim_support')!.change, 'improved');
  assert.equal(compareRuns([{ bundle: a, evaluation: evaluate(a) }], [{ bundle: b, evaluation: evaluate(b, { version: 'v1' }) }])[0].compatible, false);
});
test('extractor corpus tests propositions, negation, conditionals, and independent paraphrases', () => {
  const corpus = JSON.parse(readFileSync(new URL('../artifacts/extractor-corpus/sentences.json', import.meta.url), 'utf8'));
  for (const row of corpus) {
    const e: Event = { id: 'sentence', seq: 1, response_cycle: 1, sim_time: '2026-11-30T09:00:00Z',
      actor: 'agent', visibility: 'agent', type: 'agent_message', payload: { text: row.text } };
    assert.deepEqual(extractClaims([e]).map(c => c.type), row.types, row.text);
  }
});
