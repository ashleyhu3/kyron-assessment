import { proposedDate, medicationMatches } from './language.ts';
import { pharmacyName } from '../contracts/catalog.ts';
import { dateKey, parseDate, parseTime, parseSlot, timeKey, formatSlot, formatTime } from '../contracts/calendar.ts';
import type { Action, Agent, AgentConfig, Observation, Policy, ToolName } from './types.ts';

export const CONFIGURATIONS = {
  baseline: { id: 'baseline', version: '1.6.0', verify_writes: false },
  candidate: { id: 'candidate', version: '1.6.0', verify_writes: true },
};

// This adapter receives only visible observations and the visible policy. Prompt
// codes drive a deterministic caller; they are not hidden claim labels in traces.
export class FixtureAgent implements Agent {
  private phase = 'start';
  private verifiedPatient = '';
  private identityName = '';
  private opening = '';
  private identityAttempted = false;
  private workflow = '';
  private otherRequestPending = false;
  private entities: Record<string, string> = {};
  private medicationRecords: any[] = [];
  private medicationDescription = '';
  private pendingDate = '';
  private medicationLabel = '';
  private pharmacyLabel = '';
  private pharmacyQuery = '';
  private urgentSummary = '';
  private failureReason = '';
  private operationId = '';
  private options: string[] = [];
  private currentSlot = '';
  private checkingCorrection = false;
  private urgentHandled = false;
  private random: number;
  private config: AgentConfig;
  private policy: Policy;
  constructor(config: AgentConfig, policy: Policy) {
    this.config = config; this.policy = policy; this.random = config.seed >>> 0;
  }
  private phrase(...options: string[]): string {
    this.random = (Math.imul(this.random, 1664525) + 1013904223) >>> 0;
    return options[this.random % options.length];
  }
  private say(text: string, phase: string, prompt?: any): Action {
    this.phase = phase;
    return { type: 'say', text, ...(prompt ? { prompt } : {}) };
  }
  private tool(name: ToolName, args: Record<string, any>, phase: string): Action {
    this.phase = phase;
    return { type: 'tool', name, args };
  }
  private confirm(): Action {
    return this.workflow === 'scheduling'
      ? this.say(`Just to confirm, should I move your appointment to ${formatSlot(this.entities.slot,this.policy.timezone)}?`, 'confirmation', 'confirmation')
      : this.say(`Just to confirm, should I request ${this.medicationLabel} through ${this.pharmacyLabel}?`, 'confirmation', 'confirmation');
  }
  private offerReview(reason: string): Action {
    this.failureReason = reason;
    return this.say(this.phrase(`Would you like me to ask the ${this.workflow==='scheduling'?'scheduling':'refill'} team to review this and call you?`,
      `May I ask the ${this.workflow==='scheduling'?'scheduling':'refill'} team to call you about this?`), 'review_consent', 'review');
  }
  private closeSuccess(): Action {
    if(this.otherRequestPending)return this.workflow==='scheduling'
      ? this.say(`Your appointment is moved to ${formatSlot(this.entities.slot,this.policy.timezone)}. Please contact the clinic if you still need help with your refill.`, 'end')
      : this.say(`I submitted the refill request for ${this.medicationLabel} through ${this.pharmacyLabel}. It is pending clinician review; approval and pickup are not confirmed. Please contact the clinic if you still need help with your appointment.`, 'end');
    return this.workflow === 'scheduling'
      ? this.say(this.phrase(`Your appointment is moved to ${formatSlot(this.entities.slot,this.policy.timezone)}. No further action is needed.`,
        `You are booked for ${formatSlot(this.entities.slot,this.policy.timezone)}. You do not need to do anything else.`), 'end')
      : this.say(this.phrase(`I submitted the refill request for ${this.medicationLabel} through ${this.pharmacyLabel}. It is pending clinician review; approval and pickup are not confirmed. The refill team reviews it next.`,
        `Your refill request for ${this.medicationLabel} through ${this.pharmacyLabel} is recorded. The refill team handles review next; the prescription is not yet approved or ready for pickup.`), 'end');
  }
  next(o: Observation): Action {
    if(this.verifiedPatient)o={...o,session:{...o.session,patient_id:this.verifiedPatient,identity_verified:true}};
    const lastCaller = o.messages.filter(m => m.actor === 'caller').at(-1)?.text ?? '';
    const result = o.lastTool?.result;
    if (!this.urgentHandled && this.policy.routing.trigger_phrases.some(p => lastCaller.toLowerCase().includes(p))) {
      this.urgentHandled = true;
      this.urgentSummary=`Caller reported: ${lastCaller}. Request before disclosure: ${o.messages.filter(m=>m.actor==='caller').map(m=>m.text).join(' ')}. Refill has not been submitted; clinical review required.`;
      return this.say("I'll try to connect you with the clinical team about the symptoms you described now. I'll pause the refill request.", 'urgent_connect');
    }
    if(this.phase==='urgent_connect')return this.tool('request_handoff',{...(o.session.identity_verified ? {patient_id:o.session.patient_id} : {}),route:this.policy.routing.route,reason_code:this.policy.routing.reason_code,summary:this.urgentSummary},'urgent_result');
    if(!o.session.identity_verified && !this.identityAttempted && this.phase==='start') {
      this.identityAttempted=true;this.opening=lastCaller;
      return this.say('Before I access your records, what is your full name?', 'identity_name','identity_name');
    }
    if(this.phase==='identity_name') {this.identityName=lastCaller;return this.tool('lookup_patient',{name:lastCaller},'identity_lookup');}
    if(this.phase==='identity_lookup')return this.say('What is your date of birth, as year, month and day?', 'identity_dob','identity_dob');
    if(this.phase==='identity_dob' && !/^\d{4}-\d{2}-\d{2}$/.test(lastCaller))return this.say('Your request remains unresolved because I could not uniquely verify your identity. Please contact the clinic office to continue.', 'end');
    if(this.phase==='identity_dob')return this.tool('verify_patient',{name:this.identityName,dob:lastCaller},'identity_result');
    if(this.phase==='identity_result') {
      if(result?.status!=='ok'||!result.data?.verified)return this.say('Your request remains unresolved because I could not uniquely verify your identity. Please contact the clinic office to verify your details before we access or change records.', 'end');
      this.verifiedPatient=result.data.patient_id;this.phase='start';
      return this.next({...o,session:{...o.session,patient_id:this.verifiedPatient,identity_verified:true},messages:[...o.messages,{actor:'caller',text:this.opening}]});
    }
    if (this.phase === 'start' || this.phase === 'workflow_choice') {
      const opening = lastCaller.toLowerCase();
      const scheduling = /appointment|reschedule/.test(opening);
      const refills = /refill|medication/.test(opening);
      if(scheduling && refills){this.otherRequestPending=true;return this.say('I can help with an appointment or a refill. Which request would you like to handle now?', 'workflow_choice','workflow_choice');}
      this.workflow = scheduling ? 'scheduling' : refills ? 'refills' : '';
      if (!this.workflow) return this.say('This agent supports appointment changes and refill requests. Please contact the clinic office for other requests.', 'end');
      return this.workflow === 'scheduling' ? this.say('Of course. When is your current appointment?', 'appointment_lookup', 'appointment_lookup') : this.say('Of course. What is the name and strength of the medication you need refilled?', 'medication_name', 'medication_name');
    }
    if(this.phase==='appointment_lookup') {
      const date=parseDate(lastCaller);
      if(!date)return this.say('What is the date of your current appointment, including the year?', 'appointment_lookup','appointment_lookup');
      return this.tool('get_appointment',{patient_id:o.session.patient_id,current_date:date},'appointment_read');
    }
    if(this.phase==='preferred_date'||this.phase==='date_confirmation') {
      if(this.phase==='date_confirmation' && /^yes\b/i.test(lastCaller) && (!parseDate(lastCaller)||parseDate(lastCaller)===this.pendingDate)) {
        this.entities.date=this.pendingDate;
        return this.tool('list_available_slots',{patient_id:o.session.patient_id,date:this.pendingDate},'availability_read');
      }
      const date=proposedDate(lastCaller,o.session.reference_time,this.policy.timezone);
      if(!date)return this.say('What calendar date would you prefer? You can give the month, day and year.', 'preferred_date','preferred_date');
      if(!parseDate(lastCaller)||this.phase==='date_confirmation') {
        this.pendingDate=date;
        return this.say(`Do you mean ${formatSlot(date+'T12:00:00Z',this.policy.timezone).split(' at ')[0]}?`, 'date_confirmation','date_confirmation');
      }
      this.entities.date=date;
      return this.tool('list_available_slots',{patient_id:o.session.patient_id,date},'availability_read');
    }
    if(this.phase==='time_selection') {
      const time=parseTime(lastCaller);
      const choice=this.options.find(slot=>timeKey(slot,this.policy.timezone)===time);
      if(!choice) {
        if(/\b(none|neither|different date)\b/i.test(lastCaller))return this.say('Would you like to try a different date?', 'alternative','alternative');
        let options=this.options;
        if(/\bmorning\b/i.test(lastCaller))options=options.filter(slot=>Number(timeKey(slot,this.policy.timezone).slice(0,2))<12);
        else if(/\bafternoon\b/i.test(lastCaller))options=options.filter(slot=>Number(timeKey(slot,this.policy.timezone).slice(0,2))>=12);
        return this.say(`Please choose a specific time. ${options.length?'We have '+options.map(slot=>formatTime(slot,this.policy.timezone)).join(' or ')+'.':'There are no openings in that part of the day.'} Which time would you like?`, 'time_selection','time_selection');
      }
      this.entities.slot=choice;return this.confirm();
    }
    if(this.phase==='medication_name') {
      this.medicationDescription=lastCaller;
      return this.tool('get_medications',{patient_id:o.session.patient_id},'medications_read');
    }
    if(this.phase==='medication_clarification') {
      this.medicationDescription+=' '+lastCaller;
      const matches=medicationMatches(lastCaller,this.medicationRecords);
      if(matches.length!==1)return this.offerReview('medication_unverified');
      this.entities.medication_id=matches[0].id;this.medicationLabel=matches[0].label;
      return this.say(`You identified ${this.medicationLabel} from your chart. Which pharmacy would you like us to use?`, 'pharmacy','pharmacy');
    }
    if(this.phase==='pharmacy'||this.phase==='pharmacy_location') {
      this.pharmacyQuery=this.phase==='pharmacy_location'?`${this.pharmacyQuery} ${lastCaller}`:lastCaller;
      return this.tool('find_pharmacies',{patient_id:o.session.patient_id,query:this.pharmacyQuery},'pharmacies_read');
    }
    if(this.phase==='pharmacies_read') {
      const matches=result?.status==='ok'?result.data?.pharmacies??[]:[];
      if(matches.length===0)return this.offerReview('pharmacy_unverified');
      if(matches.length>1)return this.say('There is more than one location with that name. What street is your pharmacy on?', 'pharmacy_location','pharmacy_location');
      this.entities.pharmacy_id=matches[0].id;this.pharmacyLabel=pharmacyName(matches[0]);
      return this.confirm();
    }
    if (this.phase === 'appointment_read') {
      if (result?.status !== 'ok') return this.offerReview('appointment_not_found');
      this.entities.appointment_id=result.data!.appointment.id;
      this.currentSlot=result.data!.appointment.slot;
      return this.say(`I found your appointment on ${formatSlot(this.currentSlot,this.policy.timezone)}. What date would you like to reschedule to?`, 'preferred_date','preferred_date');

    }
    if (this.phase === 'medications_read') {
      this.medicationRecords=result?.status==='ok'?result.data?.medications??[]:[];
      const matches=medicationMatches(this.medicationDescription,this.medicationRecords);
      if(matches.length!==1)return this.say(this.medicationRecords.length
        ? `Your chart lists ${this.medicationRecords.map(m=>m.label).join(' and ')}. I need to verify which one you take. Can you confirm the name and strength from your bottle or medication list?`
        : "I couldn't identify that medication in your chart. Do you have the name and strength on the prescription bottle?",'medication_clarification','medication_clarification');
      this.entities.medication_id=matches[0].id;this.medicationLabel=matches[0].label;
      return this.say(`I found ${this.medicationLabel} in your chart. Which pharmacy would you like us to use?`, 'pharmacy','pharmacy');
    }
    if (this.phase === 'availability_read') {
      if (result?.status !== 'ok') return this.offerReview('availability_unavailable');
      this.options=result.data!.slots;
      if(!this.options.length)return this.say('There are no openings on that date. Would you like me to check another date?', 'alternative','alternative');
      if(this.checkingCorrection && this.options.some(slot=>Date.parse(slot)===Date.parse(this.entities.slot))) {
        this.checkingCorrection=false;
        this.entities.slot=this.options.find(slot=>Date.parse(slot)===Date.parse(this.entities.slot))!;
        return this.say(`That time is available. Just to confirm, should I move your appointment to ${formatSlot(this.entities.slot,this.policy.timezone)}?`,'confirmation','confirmation');
      }
      this.checkingCorrection=false;
      return this.say(`On that date, we have ${this.options.map(slot=>formatTime(slot,this.policy.timezone)).join(' or ')} available. Which time works for you?`, 'time_selection','time_selection');
    }
    if (this.phase === 'alternative') {
      const date=parseDate(lastCaller);
      if(!date)return this.say('Your original appointment is unchanged. No callback has been requested; contact the scheduling team if you want more options.', 'end');
      this.entities.date=date;return this.tool('list_available_slots',{patient_id:o.session.patient_id,date},'availability_read');
    }
    if (this.phase === 'confirmation') {
      // Only an unqualified affirmation authorizes a write. A correction or
      // ambiguous response requires another explicit confirmation.
      const hasCorrection=/\b(?:but|however|actually|instead|except|wait|change|not sure|don't|cancel|maybe|unsure|different)\b/i.test(lastCaller);
      const explicitSlot=this.workflow==='scheduling'?parseSlot(lastCaller,this.policy.timezone):undefined;
      const differentSlot=!!explicitSlot&&Date.parse(explicitSlot)!==Date.parse(this.entities.slot);
      const possibleRefillChange=this.workflow==='refills'&&/\b(?:pharmacy|medication|medicine)\b/i.test(lastCaller);
      const affirmative=/^(?:yes|yeah|yep|correct|that's right|that is right)\b/i.test(lastCaller) && !hasCorrection && !differentSlot && !possibleRefillChange && !/\b(?:no|not)\b/i.test(lastCaller);
      if (!affirmative) {
        const oldSlot=this.entities.slot;
        if(this.workflow==='scheduling') {
          const revised=parseSlot(lastCaller,this.policy.timezone);if(revised)this.entities.slot=revised;
          if(oldSlot!==this.entities.slot) {
            this.checkingCorrection=true;
            this.entities.date=dateKey(this.entities.slot,this.policy.timezone);
            return this.tool('list_available_slots',{patient_id:o.session.patient_id,date:this.entities.date},'availability_read');
          }
          if(/^no\b/i.test(lastCaller)&&!hasCorrection)return this.say('Your original appointment is unchanged. No further action is needed.', 'end');
          return this.say('I have not changed your appointment. Should I make the change I just described, or would you like a different time?', 'confirmation','confirmation');
        }
        if(/^no\b/i.test(lastCaller)&&!hasCorrection)return this.say('I have not submitted a refill request. Please contact the clinic if you would like to continue later.', 'end');
        if(/\b(?:pharmacy|use|send|instead|change)\b/i.test(lastCaller) && !/not sure|unsure/i.test(lastCaller)) {
          this.pharmacyQuery=lastCaller;
          return this.tool('find_pharmacies',{patient_id:o.session.patient_id,query:lastCaller},'pharmacies_read');
        }
        return this.say('I have not submitted the request. Should I use the medication and pharmacy I just described, or would you like to change them?', 'confirmation','confirmation');
      }
      return this.workflow === 'scheduling'
        ? this.tool('reschedule_appointment', { patient_id: o.session.patient_id,
          appointment_id: this.entities.appointment_id, new_slot: this.entities.slot,
          idempotency_key: `move:${this.entities.appointment_id}:${this.entities.slot}` }, 'write_result')
        : this.tool('submit_refill_request', { patient_id: o.session.patient_id,
          medication_id: this.entities.medication_id, pharmacy_id: this.entities.pharmacy_id,
          idempotency_key: `refill:${o.session.patient_id}:${this.entities.medication_id}:${this.entities.pharmacy_id}` }, 'write_result');
    }
    if (this.phase === 'write_result') {
      if (!this.config.verify_writes || result?.status === 'ok') return this.closeSuccess();
      if (result?.status === 'timeout_unknown' && result.operation_id) {
        this.operationId = result.operation_id;
        return this.say('Let me check whether that went through before trying again.', 'check_operation');
      }
      return this.say(this.workflow==='scheduling'?'I could not complete the appointment change. Your original appointment is unchanged. I cannot determine why the change failed.':'I could not submit the refill request. It has not been sent for review. I cannot determine why the submission failed.', 'offer_after_failure');
    }
    if(this.phase==='check_operation')return this.tool('get_operation_status',{patient_id:o.session.patient_id,operation_id:this.operationId},'status_result');
    if (this.phase === 'offer_after_failure') return this.offerReview('write_failed');
    if (this.phase === 'status_result') {
      if (result?.status === 'ok' && result.data?.status === 'committed') return this.closeSuccess();
      if (result?.status === 'ok' && result.data?.status === 'failed') {
        return this.say('I checked, and the request did not complete.', 'offer_after_failure');
      }
      return this.say('I cannot confirm whether the request went through.', 'offer_after_uncertainty');
    }
    if (this.phase === 'offer_after_uncertainty') return this.offerReview('write_uncertain');
    if (this.phase === 'review_consent') {
      if (!/^yes\b/i.test(lastCaller)) return this.say('No callback was requested. Please contact the clinic team to follow up on the unresolved request.', 'end');
      const cb = this.policy.callbacks[this.workflow];
      return this.tool('create_review_task', { patient_id: o.session.patient_id, owner: cb.owner,
        reason_code: this.failureReason, callback_sla: cb.sla,
        summary: `Caller requested ${this.workflow}: ${JSON.stringify(this.entities)}. Caller description: ${this.medicationDescription}. Reason: ${this.failureReason}.`,
      }, 'review_result');
    }
    if (this.phase === 'review_result') {
      const cb = this.policy.callbacks[this.workflow];
      return result?.status === 'ok'
        ? this.say(`I have recorded a callback request. The ${cb.owner.replaceAll("_"," ")} will call within ${cb.sla} to review the unresolved request. No further action is required from you while awaiting the call.`, 'end')
        : this.say('I could not confirm a callback request. Please contact the clinic office; no callback is confirmed.', 'end');
    }
    if (this.phase === 'urgent_result') return result?.status === 'ok'
      ? this.say("I've requested a clinical handoff and included what you told me. Your refill has not been submitted. The clinical team is the next responsible party; I'm still waiting for a clinician to accept the handoff.", 'handoff_pending')
      : this.say('I could not confirm the clinical connection. Your request remains unresolved; no clinician connection or refill submission is confirmed.', 'end');
    if(this.phase==='handoff_pending')return {type:'end',reason:'handoff_pending'};
    return { type: 'end' };
  }
}
