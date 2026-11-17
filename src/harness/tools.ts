import { catalogMatches } from '../contracts/catalog.ts';
import { dateKey } from '../contracts/calendar.ts';
import type { Scenario, State, ToolName, ToolResult, Policy } from './types.ts';
import { Recorder } from './recorder.ts';

export const TOOL_DEFINITIONS: Record<ToolName, { mutating: boolean; required: string[] }> = {
  lookup_patient: {mutating:false,required:['name']},
  verify_patient: {mutating:false,required:['name','dob']},
  get_appointment: { mutating: false, required: ['patient_id'] },
  list_available_slots: { mutating: false, required: ['patient_id', 'date'] },
  find_pharmacies: { mutating: false, required: ['patient_id', 'query'] },
  get_medications: { mutating: false, required: ['patient_id'] },
  get_operation_status: { mutating: false, required: ['patient_id', 'operation_id'] },
  reschedule_appointment: { mutating: true, required: ['patient_id', 'appointment_id', 'new_slot', 'idempotency_key'] },
  submit_refill_request: { mutating: true, required: ['patient_id', 'medication_id', 'pharmacy_id', 'idempotency_key'] },
  create_review_task: { mutating: true, required: ['patient_id', 'owner', 'reason_code', 'summary', 'callback_sla'] },
  request_handoff: { mutating: true, required: ['route', 'reason_code', 'summary'] },
};

export class SimulatedTools {
  state: State;
  private verifiedPatient: string | undefined;
  private occurrences: Record<string, number> = {};
  private operations: Record<string, { patient_id: string | undefined; status: 'committed' | 'failed'; data?: Record<string, any> }> = {};
  private idempotent = new Map<string, { args: string; data: Record<string, any> }>();
  private counts: Record<string, number> = {};
  private scenario: Scenario;
  private zone: string;
  private recorder: Recorder;
  private policy?: Policy;
  constructor(scenario: Scenario, recorder: Recorder, zone='America/New_York', policy?: Policy) {
    this.policy=policy;
    this.scenario = scenario; this.recorder = recorder; this.zone=zone;
    this.verifiedPatient=scenario.agent_visible_initial.identity_verified?scenario.agent_visible_initial.patient_id:undefined;
    this.state = structuredClone(scenario.initial_tool_state);
  }
  call(name: ToolName, args: Record<string, any>): ToolResult {
    const definition = TOOL_DEFINITIONS[name];
    if (!definition) throw new Error(`Unsupported tool: ${name}`);
    const callId = `${this.recorder.runId}:call:${Object.values(this.occurrences).reduce((n, x) => n + x, 0) + 1}`;
    this.occurrences[name] = (this.occurrences[name] ?? 0) + 1;
    const fault = this.scenario.faults.find(f => f.tool === name && (f.occurrence ?? 1) === this.occurrences[name]);
    const latency = fault?.delay_ms ?? 80;
    this.recorder.append('agent', 'tool_call', { call_id: callId, name, args, mutating: definition.mutating }, 'agent');
    this.recorder.elapsedMs += latency;
    const operationId = definition.mutating ? callId : undefined;
    let committed = false;
    let data: Record<string, any> | undefined;
    let error: string | undefined;
    let replayed = false;
    const before = structuredClone(this.state);
    try {
      for (const field of definition.required) {
        if (typeof args[field] !== 'string' || !args[field].trim()) throw new Error(`missing_or_invalid:${field}`);
      }
      const anonymousUrgent=name==='request_handoff' && !args.patient_id && !this.verifiedPatient && !!this.policy?.rules.unverified_urgent && args.route===this.policy.routing.route && args.reason_code===this.policy.routing.reason_code;
      if (!['lookup_patient','verify_patient'].includes(name) && !anonymousUrgent && args.patient_id !== this.verifiedPatient) throw new Error('identity_not_verified');
      if (!['lookup_patient','verify_patient'].includes(name) && !anonymousUrgent && args.patient_id !== this.scenario.caller.facts.patient_id) throw new Error('patient_mismatch');
      if (fault?.result === 'error_definite' || (fault?.result === 'timeout_unknown' && !fault.commit)) {
        error = fault.result === 'error_definite' ? 'injected_definite_failure' : 'no_commit_before_timeout';
      } else {
        const key = args.idempotency_key ? `${name}:${args.patient_id}:${args.idempotency_key}` : undefined;
        const previous = key ? this.idempotent.get(key) : undefined;
        const argsHash = JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
        if (previous) {
          if (previous.args !== argsHash) throw new Error('idempotency_key_conflict');
          data = structuredClone(previous.data); replayed = true;
        } else {
          data = this.execute(name, args);
          if (key) this.idempotent.set(key, { args: argsHash, data: structuredClone(data) });
        }
        committed = definition.mutating;
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }

    if (definition.mutating) {
      this.operations[callId] = { patient_id: args.patient_id, status: committed ? 'committed' : 'failed', data };
      this.recorder.append('backend', 'backend_operation', {
        call_id: callId, name, committed, idempotent_replay: replayed, ...(error ? { error } : {}),
      });
      for (const collection of Object.keys(this.state)) {
        const ids = new Set([...Object.keys(before[collection] ?? {}), ...Object.keys(this.state[collection])]);
        for (const id of ids) {
          if (JSON.stringify(before[collection]?.[id]) !== JSON.stringify(this.state[collection][id])) {
            this.recorder.append('backend', 'state_change', {
              call_id: callId, path: `${collection}.${id}`,
              before: before[collection]?.[id] ?? null, after: this.state[collection][id] ?? null,
            });
          }
        }
      }
      if (committed && !replayed && (name === 'request_handoff' || name === 'create_review_task')) {
        this.recorder.append('backend', name === 'request_handoff' ? 'handoff_requested' : 'callback_requested', {
          call_id: callId, ...data,
        });
      }
    }
    const result: ToolResult = fault?.result === 'timeout_unknown'
      ? { status: 'timeout_unknown', operation_id: operationId, latency_ms: latency, error: 'response_timeout' }
      : error ? { status: 'error_definite', operation_id: operationId, latency_ms: latency, error }
        : { status: 'ok', operation_id: operationId, latency_ms: latency, data };
    this.recorder.append('tool', 'tool_result', { call_id: callId, name, result }, 'agent');
    return structuredClone(result);
  }
  private execute(name: ToolName, args: Record<string, any>): Record<string, any> {
    if(name==='lookup_patient')return {matches:Object.values(this.state.patients??{}).filter(p=>p.name.toLowerCase()===args.name.toLowerCase()).length};
    if(name==='verify_patient') {
      const matches=Object.entries(this.state.patients??{}).filter(([,p])=>p.name.toLowerCase()===args.name.toLowerCase()&&p.dob===args.dob);
      if(matches.length!==1)throw new Error(matches.length?'identity_ambiguous':'identity_not_found');
      this.verifiedPatient=matches[0][0];return {patient_id:this.verifiedPatient,verified:true};
    }
    if (name === 'get_appointment') {
      const matches=Object.entries(this.state.appointments).filter(([id,a])=>a.patient_id===args.patient_id && (args.appointment_id?id===args.appointment_id:args.current_date&&dateKey(a.slot,this.zone)===args.current_date));
      if(matches.length!==1)throw new Error(matches.length?'appointment_ambiguous':'appointment_not_found');
      const [id,a]=matches[0];return {appointment:{id,...a}};
    }
    if (name === 'list_available_slots') return {slots:this.scenario.availability.filter(slot=>dateKey(slot,this.zone)===args.date)};
    if (name === 'find_pharmacies') return { pharmacies: catalogMatches(args.query,this.state.pharmacies) };
    if (name === 'get_medications') return { medications: Object.entries(this.state.medications)
      .filter(([, m]) => m.patient_id === args.patient_id).map(([id, m]) => ({ id, ...m })) };
    if (name === 'get_operation_status') {
      const operation = this.operations[args.operation_id];
      if (!operation || operation.patient_id !== args.patient_id) throw new Error('operation_not_found');
      return structuredClone(operation);
    }
    if (name === 'reschedule_appointment') {
      const a = this.state.appointments[args.appointment_id];
      if (!a || a.patient_id !== args.patient_id) throw new Error('appointment_not_found');
      if (!this.scenario.availability.includes(args.new_slot)) throw new Error('slot_unavailable');
      a.slot = args.new_slot;
      return { appointment: { id: args.appointment_id, ...a } };
    }
    if (name === 'submit_refill_request') {
      if (this.state.medications[args.medication_id]?.patient_id !== args.patient_id) throw new Error('medication_unverified');
      if (!this.state.pharmacies[args.pharmacy_id]) throw new Error('pharmacy_not_found');
      const id = this.newId('refill');
      const record = { patient_id: args.patient_id, medication_id: args.medication_id,
        pharmacy_id: args.pharmacy_id, status: 'requested' };
      this.state.refill_requests[id] = record;
      return { id, ...record };
    }
    if (name === 'create_review_task') {
      const id = this.newId('review');
      const record = { patient_id: args.patient_id, owner: args.owner, reason_code: args.reason_code,
        summary: args.summary, callback_sla: args.callback_sla, status: 'requested' };
      this.state.review_tasks[id] = record;
      return { id, ...record };
    }
    const id = this.newId('handoff');
    const record = { ...(args.patient_id ? {patient_id:args.patient_id} : {identity_status:'unverified'}), route: args.route, reason_code: args.reason_code,
      summary: args.summary, status: 'requested' };
    this.state.handoffs[id] = record;
    return { id, ...record };
  }
  private newId(prefix: string): string {
    let id: string;
    do { this.counts[prefix] = (this.counts[prefix] ?? 0) + 1; id = `${prefix}_${this.counts[prefix]}`; }
    while (Object.values(this.state).some(collection => id in collection));
    return id;
  }
}
