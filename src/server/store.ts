import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunBundle } from '../harness/types.ts';
import type { EvalResult } from '../eval/types.ts';
import { evaluate } from '../eval/pipeline.ts';
import { validateReplay } from '../harness/artifacts.ts';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, cohort TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), scenario_id TEXT NOT NULL, bundle_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evaluation_passes(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), result_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metric_results(id TEXT PRIMARY KEY, pass_id TEXT NOT NULL REFERENCES evaluation_passes(id), metric TEXT NOT NULL, verdict_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, result_id TEXT NOT NULL REFERENCES metric_results(id), status TEXT, reason TEXT NOT NULL, reviewer TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS labels(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), label TEXT NOT NULL, rationale TEXT NOT NULL, evidence_json TEXT NOT NULL, reviewer TEXT NOT NULL, rubric_version TEXT NOT NULL, split TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_batch ON runs(batch_id);
      CREATE INDEX IF NOT EXISTS passes_run ON evaluation_passes(run_id);
      CREATE INDEX IF NOT EXISTS results_pass ON metric_results(pass_id);
      CREATE INDEX IF NOT EXISTS reviews_result ON reviews(result_id);
      CREATE INDEX IF NOT EXISTS labels_run ON labels(run_id);`);
    for (const table of ['batches', 'runs', 'evaluation_passes', 'metric_results', 'reviews', 'labels']) {
      for (const operation of ['UPDATE', 'DELETE']) this.db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Append-only records'); END;`);
    }
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  addBatch(name: string, agent: string, bundles: RunBundle[], cohort = 'experiment') {
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?)').run(id, name, agent, cohort, new Date().toISOString());
      for (const b of bundles) {
        validateReplay(b);
        this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(b.run_id, id, b.scenario_snapshot.id, JSON.stringify(b));
        this.addPass(b.run_id, evaluate(b));
      }
      return id;
    });
  }
  addPass(runId: string, result: EvalResult) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO evaluation_passes VALUES(?,?,?,?)').run(id, runId, JSON.stringify(result), new Date().toISOString());
    for (const verdict of result.verdicts) this.db.prepare('INSERT INTO metric_results VALUES(?,?,?,?)').run(randomUUID(), id, verdict.metric, JSON.stringify(verdict));
    return id;
  }
  bundle(id: string): RunBundle | undefined {
    const row = this.db.prepare('SELECT bundle_json FROM runs WHERE id=?').get(id) as any;
    return row ? JSON.parse(row.bundle_json) : undefined;
  }
  run(id: string) {
    const bundle = this.bundle(id); if (!bundle) return undefined;
    const passes = (this.db.prepare('SELECT * FROM evaluation_passes WHERE run_id=? ORDER BY rowid DESC').all(id) as any[]).map(p => ({
      id: p.id, created_at: p.created_at, result: JSON.parse(p.result_json) as EvalResult,
      verdicts: (this.db.prepare('SELECT * FROM metric_results WHERE pass_id=? ORDER BY rowid').all(p.id) as any[]).map(r => {
        const reviews = this.db.prepare('SELECT * FROM reviews WHERE result_id=? ORDER BY rowid DESC').all(r.id) as any[];
        const override = reviews.find(review => review.status !== null);
        return { ...JSON.parse(r.verdict_json), resultId: r.id, reviews, effectiveStatus: override?.status ?? JSON.parse(r.verdict_json).status };
      }),
    }));
    const labels = (this.db.prepare('SELECT * FROM labels WHERE run_id=? ORDER BY rowid DESC').all(id) as any[])
      .map(l => ({ ...l, evidence: JSON.parse(l.evidence_json) }));
    return { bundle, passes, labels };
  }
  batches() {
    return (this.db.prepare('SELECT * FROM batches ORDER BY rowid DESC').all() as any[]).map(batch => ({ ...batch, runs: this.batchRuns(batch.id) }));
  }
  batchRuns(batchId: string) {
    return (this.db.prepare('SELECT id, scenario_id FROM runs WHERE batch_id=? ORDER BY scenario_id').all(batchId) as any[]).map(row => {
      const pass = this.db.prepare('SELECT * FROM evaluation_passes WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(row.id) as any;
      const b = this.bundle(row.id)!;
      return { id: row.id, scenarioId: row.scenario_id, title: b.scenario_snapshot.title, workflow: b.scenario_snapshot.workflow,
        status: b.status, seed: b.seed, latestPassId: pass?.id, evaluation: pass ? JSON.parse(pass.result_json) as EvalResult : undefined };
    });
  }
  scoredBatch(batchId: string) {
    return this.batchRuns(batchId).map(row => ({ bundle: this.bundle(row.id)!, evaluation: row.evaluation! }));
  }
  review(input: { resultId: string; status?: string; reason: string; reviewer: string }) {
    if (!this.db.prepare('SELECT id FROM metric_results WHERE id=?').get(input.resultId)) throw new Error('Evaluation result not found');
    const id = randomUUID();
    this.db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?,?)').run(id, input.resultId, input.status ?? null, input.reason, input.reviewer, new Date().toISOString());
    return id;
  }
  label(input: { runId: string; label: string; rationale: string; evidence: string[]; reviewer: string; split: string }) {
    const b = this.bundle(input.runId); if (!b) throw new Error('Run not found');
    if (input.evidence.some(id => !b.trace.some(e => e.id === id))) throw new Error('Unknown evidence event');
    const id = randomUUID();
    this.db.prepare('INSERT INTO labels VALUES(?,?,?,?,?,?,?,?,?)').run(id, input.runId, input.label, input.rationale,
      JSON.stringify(input.evidence), input.reviewer, 'clarity-rubric@2', input.split, new Date().toISOString());
    return id;
  }
}
