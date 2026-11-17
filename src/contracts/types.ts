export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type State = Record<string, Record<string, Record<string, any>>>;
export type ToolStatus = 'ok' | 'error_definite' | 'timeout_unknown';
export type Prompt = 'workflow_choice' | 'identity_name' | 'identity_dob' | 'date_confirmation' | 'details' | 'medication_name' | 'medication_clarification' | 'pharmacy' | 'pharmacy_location' | 'appointment_lookup' | 'preferred_date' | 'time_selection' | 'confirmation' | 'alternative' | 'review';
export type ToolName = 'lookup_patient' | 'verify_patient' | 'get_appointment' | 'list_available_slots' | 'reschedule_appointment'
  | 'get_operation_status' | 'get_medications' | 'find_pharmacies' | 'submit_refill_request'
  | 'create_review_task' | 'request_handoff';
export interface Policy {
  id: string; synthetic: boolean; timezone: string;
  rules: Record<string, string>;
  callbacks: Record<string, { owner: string; sla: string }>;
  routing: { trigger_phrases: string[]; route: string; reason_code: string };
}
export interface Scenario {
  id: string; version: number; synthetic: boolean; title: string;
  workflow: 'appointment_reschedule' | 'refill_request';
  seed: number; simulated_now: string; policy_id: string;
  caller: {
    goal: string; opening: string; utterances?: Partial<Record<Prompt, string[]>>; facts: Record<string, any>;
    behavior: { disclose_details_when_asked: boolean; accept_review_offer: boolean; reject_alternatives: boolean; pharmacy_name_only?: boolean };
    annotations: { intent_updates: Record<string, any>; discloses: string[] };
    correction?: { checkpoint: string; entity: string; previous: string; corrected: string; text: string };
    disclosure?: { checkpoint: 'details'; text: string; concepts: string[] };
  };
  agent_visible_initial: { patient_id?: string; identity_verified: boolean; policy_id: string; reference_time?: string };
  initial_tool_state: State;
  availability: string[];
  faults: { tool: ToolName; result: ToolStatus; commit?: boolean; occurrence?: number; delay_ms?: number }[];
  expected: Record<string, any>;
  unavailable_evidence: string[];
}
export interface Event {
  id: string; seq: number; response_cycle: number; sim_time: string;
  actor: 'caller' | 'agent' | 'tool' | 'backend' | 'harness';
  type: string; visibility: 'agent' | 'evaluator_only'; payload: Record<string, any>;
  ground_truth?: { intent_updates?: Record<string, any>; discloses?: string[]; ambiguous_entities?: string[] };
}
export interface ToolResult {
  status: ToolStatus; operation_id?: string; data?: Record<string, any>; error?: string;
  latency_ms: number;
}
export interface Observation {
  session: Scenario['agent_visible_initial'];
  messages: { actor: 'caller' | 'agent'; text: string }[];
  lastTool?: { name: ToolName; args: Record<string, any>; result: ToolResult };
}
export type Action =
  | { type: 'say'; text: string; prompt?: Prompt }
  | { type: 'tool'; name: ToolName; args: Record<string, any> }
  | { type: 'end'; reason?: 'handoff_pending' };
export interface Agent { next(observation: Observation): Action }
export interface AgentConfig {
  id: string; version: string; verify_writes: boolean; seed: number;
}
export interface RunBundle {
  schema_version: string; harness_version: string; run_id: string;
  scenario_snapshot: Scenario; policy_snapshot: Policy; agent_config: AgentConfig;
  seed: number; trial: number;
  trace: Event[];
  state_snapshots: { id: string; phase: 'initial' | 'final'; at_seq: number; state: State }[];
  backend_log: Event[];
  status: 'completed' | 'incomplete'; end_reason: string;
  manifest: { coverage: Record<string, 'complete' | 'partial' | 'unavailable'>; hashes: Record<string, string> };
}
