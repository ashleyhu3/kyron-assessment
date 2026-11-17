import { hash } from '../contracts/artifacts.ts';
import type { RunBundle } from '../contracts/types.ts';
import type { EvalResult, Metric } from './types.ts';
import { METRICS } from './types.ts';

export interface ScoredRun { bundle: RunBundle; evaluation: EvalResult }
export function compareRuns(a: ScoredRun[], b: ScoredRun[]) {
  const key = (r: ScoredRun) => JSON.stringify([r.bundle.scenario_snapshot.id,r.bundle.trial]);
  const keys = [...new Set([...a,...b].map(key))];
  return keys.map(k => {
    const left = a.find(r=>key(r)===k), right = b.find(r=>key(r)===k);
    const ambiguous = a.filter(r=>key(r)===k).length>1 || b.filter(r=>key(r)===k).length>1;
    const source = left ?? right!;
    const compatible = !!left && !!right && !ambiguous && hash(left.bundle.scenario_snapshot) === hash(right.bundle.scenario_snapshot)
      && hash(left.bundle.policy_snapshot) === hash(right.bundle.policy_snapshot)
      && left.bundle.seed === right.bundle.seed && left.evaluation.suiteVersion === right.evaluation.suiteVersion
      && left.evaluation.evidenceProfile === right.evaluation.evidenceProfile;
    const metrics = METRICS.map(metric => {
      const va = left?.evaluation.verdicts.find(v => v.metric === metric)!;
      const vb = right?.evaluation.verdicts.find(v => v.metric === metric);
      const label = !compatible || !va || !vb || va.status === 'unknown' || vb.status === 'unknown' ? 'incomparable'
        : va.status === 'not_applicable' || vb.status === 'not_applicable' ? va.status === vb.status ? 'unchanged' : 'applicability_changed'
          : va.status === vb.status ? 'unchanged' : va.status === 'fail' ? 'improved' : 'regressed';
      return { metric, before: va?.status ?? 'unknown', after: vb?.status ?? 'unknown', change: label };
    });
    return { scenarioId: source.bundle.scenario_snapshot.id, title: source.bundle.scenario_snapshot.title, trial: source.bundle.trial,
      matchStatus: ambiguous ? 'ambiguous' : !left ? 'after_only' : !right ? 'before_only' : compatible ? 'matched' : 'incompatible',
      beforeRunId: left?.bundle.run_id, afterRunId: right?.bundle.run_id, compatible, metrics,
      beforeGate: left?.evaluation.gate ?? 'INCOMPLETE', afterGate: right?.evaluation.gate ?? 'INCOMPLETE',
      operations: { before: left ? operations(left.bundle) : null, after: right ? operations(right.bundle) : null } };
  });
}
function operations(b: RunBundle) {
  return { toolCalls: b.trace.filter(e => e.type === 'tool_call').length,
    staffRequests: b.trace.filter(e => ['handoff_requested', 'callback_requested'].includes(e.type)).length,
    callerTurns: b.trace.filter(e => e.type === 'caller_message').length };
}
export function flipTables(rows: ReturnType<typeof compareRuns>) {
  return Object.fromEntries(METRICS.map((metric: Metric) => {
    const counts = { pass_pass: 0, pass_fail: 0, fail_pass: 0, fail_fail: 0, excluded: 0 };
    for (const row of rows) {
      const m = row.metrics.find(x => x.metric === metric)!;
      const key = `${m.before}_${m.after}`;
      if (row.compatible && ['pass_pass', 'pass_fail', 'fail_pass', 'fail_fail'].includes(key)) counts[key as 'pass_pass']++;
      else counts.excluded++;
    }
    return [metric, counts];
  }));
}
