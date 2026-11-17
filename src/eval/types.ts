import type { Event, State } from '../contracts/types.ts';
export const METRICS = ['outcome', 'identity_access', 'entities', 'claim_support', 'escalation_decision', 'handoff_integrity', 'clarity'] as const;
export type Metric = typeof METRICS[number];
export type Status = 'pass' | 'fail' | 'unknown' | 'not_applicable';
export type Severity = 'critical' | 'major' | 'minor';
export type EvidenceRef = { kind: 'event'; id: string } | { kind: 'state'; snapshotId: string; path: string }
  | { kind: 'policy'; ruleId: string } | { kind: 'expectation'; key: string };
export interface ItemResult {
  id: string; status: string; reason: string; evidence: EvidenceRef[]; details?: any;
}
export interface Verdict {
  metric: Metric; evaluatorVersion: string; status: Status; severity?: Severity;
  reasonCode: string; explanation: string; evidence: EvidenceRef[]; items: ItemResult[]; raw?: any;
}
export type EvidenceProfile = 'full' | 'no_final_state' | 'transcript_only';
export interface EvalInput {
  expected: Record<string, any>; policy: Record<string, any>; trace: Event[];
  snapshots: { id: string; phase: string; at_seq: number; state: State }[];
  coverage: Record<string, string>;
}
export interface Claim {
  id: string; eventId: string; seq: number; text: string; type: string;
  entities: Record<string, string>; status?: 'supported' | 'unsupported' | 'contradicted' | 'premature' | 'unknown';
  reason?: string; evidence: EvidenceRef[];
}
export interface Facts {
  input: EvalInput;
  initial?: EvalInput['snapshots'][number]; final?: EvalInput['snapshots'][number];
  changes: { path: string; before: any; after: any; evidence: EvidenceRef[] }[];
  calls: { event: Event; result?: Event; commit?: Event }[];
  intents: { seq: number; values: Record<string, any>; event: Event }[];
  claims: Claim[];
  handoffs: Event[]; callbacks: Event[]; closing?: Event;
}
export interface EvalResult {
  suiteVersion: string; evidenceProfile: EvidenceProfile; verdicts: Verdict[];
  gate: 'FAIL' | 'WARN' | 'INCOMPLETE' | 'CLEAR';
  counts: Record<Status, number>; diagnostics: string[]; facts: { claims: Claim[]; changes: Facts['changes'] };
}
export const eventRef = (e: Event): EvidenceRef => ({ kind: 'event', id: e.id });
