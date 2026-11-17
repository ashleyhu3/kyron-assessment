import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import { calibration, comparison, executeBatch, executeControls, seedExamples } from '../src/server/service.ts';
import { evaluate } from '../src/eval/pipeline.ts';
import { calibrationStats } from '../src/eval/calibration.ts';
import { expectedSchema } from '../src/eval/predicates.ts';
import { loadScenarios } from '../src/harness/artifacts.ts';

test('all scenario predicate schemas validate before the product loads them', () => {
  for (const scenario of loadScenarios()) assert.equal(expectedSchema.safeParse(scenario.expected).success, true, scenario.id);
});
test('saved examples load once, remain comparable, and never invent human labels', () => {
  const store = new Store(':memory:');
  try {
    seedExamples(store); seedExamples(store);
    const batches = store.batches(); assert.equal(batches.length, 2);
    assert.equal(batches.reduce((n, b) => n + b.runs.length, 0), loadScenarios().length * 2);
    const report = comparison(store, batches.find(b => b.agent === 'baseline').id, batches.find(b => b.agent === 'candidate').id);
    assert.equal(report.rows.length, loadScenarios().length); assert.equal(report.totals.regressed, 0);
    assert.ok(report.totals.improved > 0); assert.equal(calibration(store).labeled, 0);
  } finally { store.close(); }
});
test('rescoring and reviews preserve immutable artifacts and original results', () => {
  const store = new Store(':memory:');
  try {
    const batch = executeBatch(store, 'baseline', 17, 'A5'); const run = store.batchRuns(batch)[0];
    const before = JSON.stringify(store.bundle(run.id));
    const original = store.run(run.id)!.passes[0];
    const claim = original.verdicts.find(v => v.metric === 'claim_support')!;
    assert.equal(claim.status, 'fail');
    store.review({ resultId: claim.resultId, status: 'pass', reason: 'Test-only override', reviewer: 'Test reviewer' });
    store.review({ resultId: claim.resultId, reason: 'Annotation after override', reviewer: 'Test reviewer' });
    const reviewed = store.run(run.id)!.passes[0].verdicts.find(v => v.metric === 'claim_support')!;
    assert.equal(reviewed.status, 'fail'); assert.equal(reviewed.effectiveStatus, 'pass'); assert.equal(reviewed.reviews.length, 2);
    const newId = store.transaction(() => store.addPass(run.id, evaluate(store.bundle(run.id)!, { profile: 'transcript_only' })));
    const after = store.run(run.id)!;
    assert.equal(after.passes.length, 2); assert.equal(after.passes[0].id, newId);
    assert.equal(JSON.stringify(store.bundle(run.id)), before);
    assert.equal(after.passes[1].result.gate, 'FAIL');
    assert.throws(() => store.db.prepare('UPDATE runs SET scenario_id=? WHERE id=?').run('changed', run.id), /Append-only/);
    assert.throws(() => store.db.prepare('DELETE FROM evaluation_passes WHERE id=?').run(newId), /Append-only/);
  } finally { store.close(); }
});
test('human labels include evidence, persist history, and drive calibration statistics', () => {
  const store = new Store(':memory:');
  try {
    const batch = executeBatch(store, 'baseline', 17, 'A5'); const run = store.batchRuns(batch)[0];
    const evidence = store.bundle(run.id)!.trace.filter(e => e.type === 'agent_message').at(-1)!.id;
    const label = { runId: run.id, label: 'unclear', rationale: 'Claim preceded verification.', evidence: [evidence], reviewer: 'Test reviewer', split: 'dev' };
    store.label(label); assert.equal(calibration(store).labeled, 1);
    const data = calibration(store);
    assert.equal((data.stats.dev as any).v2.n, 1); assert.equal((data.stats.dev as any).v2.agreement, 1);
    assert.throws(() => store.label({ ...label, evidence: ['missing'] }), /Unknown evidence/);
    store.label({ ...label, rationale: 'Second independent review entry.' });
    assert.equal(store.run(run.id)!.labels.length, 2);
  } finally { store.close(); }
});
test('empty and skewed calibration sets show honest denominators and undefined rates', () => {
  assert.equal(calibrationStats([]).agreement, null);
  assert.equal(calibrationStats([]).classes[0].precision, null);
  const stats = calibrationStats([{ reference: 'clear', predicted: 'clear' }, { reference: 'clear', predicted: 'unclear' }]);
  assert.equal(stats.agreement, .5); assert.equal(stats.majorityBaseline, 1);
});
test('control runs are persisted in a separate cohort and excluded from the human queue', () => {
  const store = new Store(':memory:');
  try {
    const ids = executeControls(store); assert.equal(ids.length, 5);
    assert.equal(store.batches().flatMap(b => b.runs).length, loadScenarios().length * 5);
    assert.equal(calibration(store).rows.length, 0);
    assert.ok(store.batches().every(b => b.cohort === 'controls'));
  } finally { store.close(); }
});
test('SQLite survives restart and rejects a duplicate run without a partial batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyron-store-')); const file = join(dir, 'test.sqlite');
  let store = new Store(file);
  try {
    const batch = executeBatch(store, 'candidate', 17, 'R2'); const run = store.batchRuns(batch)[0];
    const original = store.bundle(run.id)!;
    assert.throws(() => store.addBatch('Duplicate', 'candidate', [original]), /UNIQUE/);
    assert.equal(store.batches().length, 1);
    store.close(); store = new Store(file);
    assert.deepEqual(store.bundle(run.id), original); assert.equal(store.run(run.id)!.passes.length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
