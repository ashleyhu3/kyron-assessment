import { normalizeWords } from '../contracts/catalog.ts';
import { intentAt } from './facts.ts';
import { eventRef } from './types.ts';
import type { Event } from '../contracts/types.ts';
import type { EvidenceRef, Facts } from './types.ts';

// Only enforce confirmed refill context when a definite submission failure
// preceded this callback. Other callbacks have their own policy requirements.
export function refillHandoffContext(f: Facts, callback: Event): { status: 'pass' | 'fail' | 'unknown'; issues: string[]; evidence: EvidenceRef[]; expected?: Record<string, string> } | undefined {
  const failed=f.calls.filter(c=>c.event.payload.name==='submit_refill_request' && c.result?.seq!<callback.seq && c.result?.payload.result.status==='error_definite').at(-1);
  if(!failed)return;
  const evidence:EvidenceRef[]=[eventRef(failed.event),eventRef(failed.result!),eventRef(callback)];
  if(f.input.coverage.intent_annotations!=='complete'||f.input.coverage.conversation!=='complete')return {status:'unknown',issues:['confirmed_refill_context_unavailable'],evidence};
  const medication=intentAt(f,failed.event.seq,'medication_id'),pharmacy=intentAt(f,failed.event.seq,'pharmacy_id');
  if(medication)evidence.push(eventRef(medication.event));if(pharmacy)evidence.push(eventRef(pharmacy.event));
  const latestCaller=f.input.trace.filter(e=>e.type==='caller_message'&&e.seq<failed.event.seq).at(-1);
  const confirmation=latestCaller && f.input.trace.filter(e=>e.type==='agent_message'&&e.seq<latestCaller.seq).at(-1);
  if(latestCaller)evidence.push(eventRef(latestCaller));if(confirmation)evidence.push(eventRef(confirmation));
  const medId=medication?.values.medication_id,pharmacyId=pharmacy?.values.pharmacy_id;
  if(!medId||!pharmacyId||!latestCaller||!/^\s*(?:yes|yeah|yep|correct|that's right|that is right)\b/i.test(latestCaller.payload.text)||/\b(?:but|however|actually|instead|except|not|no|maybe|unsure)\b/i.test(latestCaller.payload.text)||!confirmation||!/\bconfirm\b/i.test(confirmation.payload.text))return {status:'unknown',issues:['confirmed_refill_context_unavailable'],evidence};
  const expected={medication_id:String(medId),pharmacy_id:String(pharmacyId)};
  const meds=f.initial?.state.medications??{},pharmacies=f.initial?.state.pharmacies??{};
  const check=(text:string,kind:'medication'|'pharmacy',id:string,records:Record<string,any>)=>{
    const normalized=` ${normalizeWords(text)} `;
    const contains=(value:unknown)=>typeof value==='string' && !!normalizeWords(value) && normalized.includes(` ${normalizeWords(value)} `);
    const mentioned=new Set((text.match(new RegExp(`\\b${kind==='medication'?'med':'pharmacy'}_\\d+\\b`,'gi'))??[]).map(x=>x.toLowerCase()));
    for(const [recordId,record] of Object.entries(records)) {
      if(!contains(record.label))continue;
      if(kind==='pharmacy') {
        const sameName=Object.values(records).filter(r=>normalizeWords(String(r.label??''))===normalizeWords(String(record.label??'')));
        if(sameName.length>1 && !contains(String(record.address??'').split(',')[0]))continue;
      }
      mentioned.add(recordId.toLowerCase());
    }
    const wanted=id.toLowerCase();
    if([...mentioned].some(value=>value!==wanted))return `wrong_${kind}`;
    if(!mentioned.has(wanted))return `missing_${kind}`;
    return undefined;
  };
  if(check(confirmation.payload.text,'medication',expected.medication_id,meds)||check(confirmation.payload.text,'pharmacy',expected.pharmacy_id,pharmacies))return {status:'unknown',issues:['confirmed_refill_context_unavailable'],evidence,expected};
  const summary=String(callback.payload.summary??'');
  const issues=[check(summary,'medication',expected.medication_id,meds),check(summary,'pharmacy',expected.pharmacy_id,pharmacies)].filter((x):x is string=>!!x);
  return {status:issues.length?'fail':'pass',issues,evidence,expected};
}
