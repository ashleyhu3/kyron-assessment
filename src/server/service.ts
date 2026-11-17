import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy, loadScenarios, PROJECT_ROOT } from '../harness/artifacts.ts';
import { runScenario } from '../harness/runner.ts';
import { evaluate } from '../eval/pipeline.ts';
import { compareRuns, flipTables } from '../eval/compare.ts';
import { calibrationStats, clarityLabel } from '../eval/calibration.ts';
import { CONTROLS, controlAgent } from '../testing/controls.ts';
import type { Store } from './store.ts';
import type { RunBundle } from '../harness/types.ts';

export function executeBatch(store: Store, agent: 'baseline' | 'candidate', seed: number, scenarioId?: string) {
  const scenarios = loadScenarios().filter(s => !scenarioId || s.id === scenarioId);
  if (!scenarios.length) throw new Error('Scenario not found');
  const bundles = scenarios.map(s => runScenario(s, loadPolicy(s), { configuration: agent, seed, runId: `${randomUUID()}:${s.id}` }));
  return store.addBatch(`${agent === 'candidate' ? 'Verified outcomes' : 'Optimistic completion'} · seed ${seed}`, agent, bundles);
}
export function seedExamples(store: Store) {
  if (store.batches().length) return;
  const current = join(PROJECT_ROOT, 'artifacts/runs/unfamiliar-final');
  const dir = existsSync(join(current, 'index.json')) ? current : join(PROJECT_ROOT, 'artifacts/runs/part2-verified');
  const index = existsSync(join(dir, 'index.json')) ? JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) : undefined;
  for (const agent of ['baseline', 'candidate'] as const) {
    if (index) {
      const bundles = index.entries.filter((e: any) => e.agent === agent).map((e: any) => JSON.parse(readFileSync(join(dir, e.file), 'utf8')) as RunBundle);
      store.addBatch(`${agent === 'candidate' ? 'Verified outcomes' : 'Optimistic completion'} · saved examples`, agent, bundles);
    } else executeBatch(store, agent, 17);
  }
}
export function comparison(store: Store, a: string, b: string) {
  const rows = compareRuns(store.scoredBatch(a), store.scoredBatch(b));
  const totals = { improved: 0, regressed: 0, unchanged: 0, incomparable: 0, applicability_changed: 0 };
  rows.forEach(row => row.metrics.forEach(metric => totals[metric.change as keyof typeof totals]++));
  return { rows, totals, flipTables: flipTables(rows) };
}
export function calibration(store: Store) {
  const runs = store.batches().filter(b => b.cohort === 'experiment').flatMap(b => b.runs);
  const rows = runs.map(row => {
    const full = store.run(row.id)!; const label = full.labels[0];
    const v1 = evaluate(full.bundle, { version: 'v1' }), v2 = evaluate(full.bundle, { version: 'v2' });
    return { runId: row.id, scenarioId: row.scenarioId, title: row.title, label: label?.label ?? null,
      rationale: label?.rationale, reviewer: label?.reviewer, split: label?.split, evidence: label?.evidence ?? [],
      predictions: { v1: clarityLabel(v1), v2: clarityLabel(v2) },
      outputs: { v1: v1.verdicts.find(v => v.metric === 'clarity'), v2: v2.verdicts.find(v => v.metric === 'clarity') } };
  });
  const stats = Object.fromEntries(['dev', 'held_out'].map(split => [split, Object.fromEntries(['v1', 'v2'].map(version => [version,
    calibrationStats(rows.filter(r => r.label && r.split === split).map(r => ({ reference: r.label, predicted: r.predictions[version as 'v1' | 'v2'] }))),
  ]))]));
  return { rows, stats, labeled: rows.filter(r => r.label).length, rubricVersion: 'clarity-rubric@2' };
}
export function executeControls(store: Store) {
  const ids = [];
  for (const control of CONTROLS) {
    const bundles = loadScenarios().map(s => runScenario(s, loadPolicy(s), {
      runId: `${randomUUID()}:${control}:${s.id}`, agentFactory: (config, policy) => controlAgent(control, config, policy),
    }));
    ids.push(store.addBatch(`Control · ${control}`, control, bundles, 'controls'));
  }
  return ids;
}
