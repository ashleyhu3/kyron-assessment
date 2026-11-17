import { pharmacyName } from '../contracts/catalog.ts';
import { formatDate, formatSlot, formatTime, parseTime } from '../contracts/calendar.ts';
import type { Prompt, Scenario, Event } from './types.ts';

export class ScriptedCaller {
  private responses: Partial<Record<Prompt, number>> = {};
  private corrected = false;
  private intendedSlot = "";
  private scenario: Scenario;
  private zone: string;
  constructor(scenario: Scenario, zone='America/New_York') { this.scenario = scenario; this.zone=zone; }
  opening(): { text: string; truth: Event['ground_truth'] } {
    // Nothing is annotated before it is actually spoken. Detailed entity intent is
    // attached to the response that discloses it, not copied from the final goal.
    return { text: this.scenario.caller.opening, truth: {
      discloses: this.scenario.caller.disclosure ? [] : this.scenario.caller.annotations.discloses,
    } };
  }
  respond(prompt: Prompt, agentText = ""): { text: string; truth: Event['ground_truth'] } | null {
    const { caller, workflow } = this.scenario;
    const zone=this.zone;
    if(prompt==='identity_name')return {text:caller.facts.identity_name,truth:{}};
    if(prompt==='identity_dob')return {text:caller.facts.identity_dob ?? 'I cannot provide my date of birth.',truth:{}};
    const sequence=caller.utterances?.[prompt];
    if(sequence) {
      const index=this.responses[prompt]??0;this.responses[prompt]=index+1;
      const text=sequence[Math.min(index,sequence.length-1)];
      // Uncertain medicine identity remains ambiguous until the caller supplies
      // the recorded name/strength. This truth is evaluator-only.
      const medicationPrompt=prompt==='medication_name'||prompt==='medication_clarification';
      const truth: Event['ground_truth']=medicationPrompt
        ? prompt==='medication_clarification'&&caller.facts.medication_id
          ? {intent_updates:{medication_id:caller.facts.medication_id}}
          : {ambiguous_entities:['medication_id']}
        : prompt==='time_selection'?{intent_updates:{slot:caller.facts.desired_slot}}:{};
      return {text,truth};
    }
    if(prompt==='workflow_choice')return {text:workflow==='appointment_reschedule'?'The appointment first, please.':'The refill first, please.',truth:{}};
    if(prompt==='date_confirmation')return {text:'Yes, that is the date I mean.',truth:{intent_updates:{date:caller.facts.desired_slot.slice(0,10)}}};
    if (prompt==='appointment_lookup') {
      if(!caller.behavior.disclose_details_when_asked)return null;
      const appointment=this.scenario.initial_tool_state.appointments[caller.facts.appointment_id];
      return {text:`It's on ${formatSlot(caller.facts.current_slot??appointment.slot,zone)}.`,truth:{intent_updates:{appointment_id:caller.facts.appointment_id}}};
    }
    if(prompt==='preferred_date') {
      const desired=caller.correction?.previous??caller.facts.desired_slot;
      return {text:`Could we do ${formatDate(desired,zone)}?`,truth:{intent_updates:{date:desired.slice(0,10)}}};
    }
    if(prompt==='time_selection') {
      const desired=this.corrected?caller.facts.desired_slot:caller.correction?.previous??caller.facts.desired_slot;
      if(!agentText.toLowerCase().includes(formatTime(desired,zone).toLowerCase()))return {text:'None of those times work for me.',truth:{}};
      const truth=this.intendedSlot===desired?{}:{intent_updates:{slot:desired}};this.intendedSlot=desired;
      return {text:`${formatTime(desired,zone)} works for me.`,truth};
    }
    if (prompt==='medication_name'||prompt==='details') {
      if(!caller.behavior.disclose_details_when_asked)return null;
      const label=caller.facts.medication_label??'My usual medication';
      return {text:label+(caller.disclosure?`${/[.!?]$/.test(label)?' ':'. '}${caller.disclosure.text}`:''),truth:{
        intent_updates:{medication_id:caller.facts.medication_id},
        ...(caller.facts.medication_id?{}:{ambiguous_entities:['medication_id']}),
        ...(caller.disclosure?{discloses:caller.disclosure.concepts}:{})}};
    }
    if(prompt==='medication_clarification')return {text:"No, I don't have the bottle with me, so I can't check the name.",truth:{}};
    if(prompt==='pharmacy'||prompt==='pharmacy_location') {
      const id=this.corrected?caller.facts.pharmacy_id:caller.correction?.previous??caller.facts.pharmacy_id;
      const profile=caller.facts.known_pharmacies[id];
      return {text:prompt==='pharmacy_location'?`It's the one at ${profile.address}.`:`Please use ${caller.behavior.pharmacy_name_only?profile.label:pharmacyName(profile)}.`,truth:{intent_updates:{pharmacy_id:id}}};
    }
    if (prompt === 'confirmation' && caller.correction && !this.corrected) {
      this.corrected = true;
      if(caller.correction.entity==='slot')this.intendedSlot=caller.correction.corrected;
      return { text: caller.correction.text,
        truth: { intent_updates: { [caller.correction.entity]: caller.correction.corrected } } };
    }
    if (prompt === 'confirmation') return { text: 'Yes, please do that.', truth: {} };
    if (prompt === 'alternative') {
      if(!caller.behavior.reject_alternatives&&caller.facts.alternative_date)return {text:`Could you check ${formatDate(caller.facts.alternative_date,zone)} instead?`,truth:{intent_updates:{date:caller.facts.alternative_date.slice(0,10)}}};
      return {text:'No. Keep my original appointment.',truth:{}};
    }
    return { text: caller.behavior.accept_review_offer ? 'Yes, please ask the team to call me.' : 'No callback, thank you.', truth: {} };
  }
}
