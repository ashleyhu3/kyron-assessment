import type { RunBundle } from '../contracts/types.ts';
import { validateReplay } from '../contracts/artifacts.ts';
import { expectedSchema, atPath } from './predicates.ts';
import { deriveFacts } from './facts.ts';
import { REGISTRY, REASONS } from './evaluators.ts';
import { METRICS } from './types.ts';
import type { EvalInput, EvalResult, EvidenceProfile, EvidenceRef, Metric, Verdict } from './types.ts';
import { EXTRACTOR_VERSION } from './claims.ts';
import { provenanceComplete } from '../contracts/validation.ts';

export function suiteVersion(version: 'v1' | 'v2') { return `evaluation@1.12.0/${EXTRACTOR_VERSION}/clarity.${version}`; }
export function evidenceResolves(ref: EvidenceRef, input: EvalInput): boolean {
  if (ref.kind === 'event') return input.trace.some(e => e.id === ref.id);
  if (ref.kind === 'state') {
    const snapshot = input.snapshots.find(s => s.id === ref.snapshotId);
    return !!snapshot && atPath(snapshot.state, ref.path) !== undefined;
  }
  if (ref.kind === 'policy') return ref.ruleId in (input.policy.rules ?? {});
  if (ref.kind === 'expectation') return atPath(input.expected, ref.key) !== undefined;
  return false;
}
export function unknown(metric: Metric, reason: string, explanation: string, version: 'v1' | 'v2' = 'v2'): Verdict {
  return { metric, evaluatorVersion: metric === 'handoff_integrity' ? 'handoff_integrity@1.8.0' : metric === 'identity_access' ? 'identity_access@1.0.2' : metric === 'outcome' ? 'outcome@1.8.0' : metric === 'clarity' ? `clarity.rules@${version === 'v1' ? '1.0.0' : '2.3.0'}` : `${metric}@1.7.0`, status: 'unknown', reasonCode: reason, explanation, evidence: [], items: [] };
}
export function aggregate(verdicts: Verdict[]) {
  const counts = { pass: 0, fail: 0, unknown: 0, not_applicable: 0 };
  verdicts.forEach(v => counts[v.status]++);
  const gate: EvalResult['gate'] = verdicts.some(v => v.status === 'fail' && v.severity === 'critical') ? 'FAIL'
    : verdicts.some(v => v.status === 'unknown') ? 'INCOMPLETE'
      : verdicts.some(v => v.status === 'fail' && v.severity === 'major') ? 'WARN' : 'CLEAR';
  return { counts, gate };
}
export function evaluate(bundle: RunBundle, options: { version?: 'v1' | 'v2'; profile?: EvidenceProfile } = {}): EvalResult {
  const version = options.version ?? 'v2', profile = options.profile ?? 'full';
  const diagnostics: string[] = [];
  let input: EvalInput;
  try {
    validateReplay(bundle);
    expectedSchema.parse(bundle.scenario_snapshot.expected);
    input = structuredClone({ expected: bundle.scenario_snapshot.expected, policy: bundle.policy_snapshot,
      trace: bundle.trace, snapshots: bundle.state_snapshots, coverage: { ...bundle.manifest.coverage, state_provenance: provenanceComplete(bundle) ? 'complete' : 'unavailable' } });
    if (profile === 'no_final_state') { input.snapshots = input.snapshots.filter(s => s.phase !== 'final'); input.coverage.final_state = 'unavailable'; }
    if (profile === 'transcript_only') {
      input.trace = input.trace.filter(e => ['caller_message', 'agent_message', 'run_ended', 'run_started'].includes(e.type)).map(e => { delete e.ground_truth; return e; });
      input.snapshots = [];
      input.coverage = Object.fromEntries(Object.keys(input.coverage).map(key => [key, key === 'conversation' ? 'complete' : 'unavailable']));
    }
  } catch (e) {
    diagnostics.push(e instanceof Error ? e.message : String(e));
    const verdicts = METRICS.map(id => unknown(id, 'invalid_run_artifacts', diagnostics[0], version));
    return { suiteVersion: suiteVersion(version), evidenceProfile: profile, verdicts, ...aggregate(verdicts), diagnostics, facts: { claims: [], changes: [] } };
  }
  let facts;
  try { facts = deriveFacts(input); } catch (e) {
    const verdicts = METRICS.map(id => unknown(id, 'fact_derivation_error', String(e), version));
    return { suiteVersion: suiteVersion(version), evidenceProfile: profile, verdicts, ...aggregate(verdicts), diagnostics: [String(e)], facts: { claims: [], changes: [] } };
  }
  const verdicts = REGISTRY.map(registry => {
    const missing = registry.requires.filter(key => input.coverage[key] !== 'complete');
    if (missing.length) return unknown(registry.id, 'missing_required_evidence', `Required complete evidence unavailable: ${missing.join(', ')}.`, version);
    try {
      const result = registry.evaluate(facts, version);
      const observed = result.evidence.some(ref => ref.kind === 'event' || ref.kind === 'state');
      if (!REASONS[registry.id].includes(result.reasonCode) || result.evidence.some(ref => !evidenceResolves(ref, input))
        || result.items.some(item => item.evidence.some(ref => !evidenceResolves(ref, input)))
        || (['pass', 'fail'].includes(result.status) && (!observed || !result.evidence.length))) {
        return unknown(registry.id, 'invalid_evaluator_output', 'Evaluator returned an illegal reason or unresolved/missing observed evidence.', version);
      }
      return result;
    } catch (e) { return unknown(registry.id, 'evaluator_error', e instanceof Error ? e.message : String(e), version); }
  });
  return { suiteVersion: suiteVersion(version), evidenceProfile: profile, verdicts, ...aggregate(verdicts), diagnostics,
    facts: { claims: facts.claims, changes: facts.changes } };
}
