import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { executeBatch, comparison } from './service.ts';
import { PROJECT_ROOT } from '../harness/artifacts.ts';

const store = new Store(process.env.KYRON_DB ?? join(PROJECT_ROOT, 'data/kyron.sqlite'));
try {
  const a = executeBatch(store, 'baseline', 17), b = executeBatch(store, 'candidate', 17);
  const result = comparison(store, a, b);
  const output = join(PROJECT_ROOT, 'artifacts/experiment', randomUUID());
  mkdirSync(output, { recursive: true });
  for (const [name, batchId] of [['baseline', a], ['candidate', b]]) {
    mkdirSync(join(output, name));
    for (const run of store.batchRuns(batchId)) writeFileSync(join(output, name, `${run.scenarioId}.json`), JSON.stringify(store.run(run.id), null, 2) + '\n', { flag: 'wx' });
  }
  writeFileSync(join(output, 'comparison.json'), JSON.stringify({ baselineBatch: a, candidateBatch: b, ...result }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, baselineBatch: a, candidateBatch: b, metricPairCounts: result.totals }, null, 2));
} finally { store.close(); }
