import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScenarios,loadPolicy,artifactHashes,validateReplay } from '../src/harness/artifacts.ts';
import { runScenario } from '../src/harness/runner.ts';
import { evaluate } from '../src/eval/pipeline.ts';
import type { RunBundle } from '../src/contracts/types.ts';
const saved=()=>JSON.parse(readFileSync('artifacts/quality/R4-generic-callback-summary.json','utf8')) as RunBundle;
const score=(b:RunBundle)=>evaluate(b).verdicts.find(v=>v.metric==='handoff_integrity')!;
function summary(b:RunBundle,text:string){
 for(const e of b.trace){if(e.type==='tool_call'&&e.payload.name==='create_review_task')e.payload.args.summary=text;if(e.type==='callback_requested')e.payload.summary=text;if(e.type==='tool_result'&&e.payload.name==='create_review_task')e.payload.result.data.summary=text;if(e.type==='state_change'&&e.payload.path.startsWith('review_tasks.'))e.payload.after.summary=text;}
 for(const snap of b.state_snapshots.filter(s=>s.phase==='final'))for(const task of Object.values(snap.state.review_tasks))task.summary=text;
 b.backend_log=b.trace.filter(e=>e.actor==='backend');b.manifest.hashes=artifactHashes(b);validateReplay(b);return b;
}
test('original complete failed-refill callback preserves confirmed medication and pharmacy',()=>{
 const s=loadScenarios().find(s=>s.id==='R4')!,b=runScenario(s,loadPolicy(s));const v=score(b);assert.equal(v.status,'pass');assert.deepEqual(v.items[0].details.refillContext.expected,{medication_id:'med_001',pharmacy_id:'pharmacy_001'});assert.ok(v.evidence.some(r=>r.kind==='event'&&b.trace.find(e=>e.id===r.id)?.type==='caller_message'));
});
test('saved generic callback note fails with both missing confirmed entities',()=>{
 const v=score(saved());assert.equal(v.status,'fail');assert.equal(v.reasonCode,'invalid_payload');assert.deepEqual(v.items[0].details.missing,['missing_medication','missing_pharmacy']);
});
test('callback naming another location of the same pharmacy fails',()=>{
 const b=summary(saved(),'Please review Examplemed 10 mg tablets at Maple Pharmacy at 200 Example Way, Sampletown.');const v=score(b);assert.equal(v.status,'fail');assert.ok(v.items[0].details.missing.includes('wrong_pharmacy'));assert.ok(!v.items[0].details.missing.includes('missing_medication'));
});
test('callback can preserve confirmed names and correct street without internal IDs',()=>{
 const b=summary(saved(),'Review Examplemed 10 mg tablets for Maple Pharmacy at 100 Example Way, Sampletown.');assert.equal(score(b).status,'pass');
});
test('ambiguous pharmacy name and conflicting medication identifiers cannot pass',()=>{
 const b=summary(saved(),'Review med_001 at Maple Pharmacy.');assert.equal(score(b).status,'fail');assert.ok(score(b).items[0].details.missing.includes('missing_pharmacy'));
 summary(b,'Review med_001 and med_999 at pharmacy_001.');assert.equal(score(b).status,'fail');assert.ok(score(b).items[0].details.missing.includes('wrong_medication'));
});
test('missing caller intent or confirmation evidence abstains instead of inventing details',()=>{
 const b=saved();b.manifest.coverage.intent_annotations='unavailable';b.manifest.hashes=artifactHashes(b);assert.equal(score(b).status,'unknown');
});
test('unverified-medication review remains governed by its existing escalation requirements',()=>{
 const s=loadScenarios().find(s=>s.id==='R3')!,b=runScenario(s,loadPolicy(s));assert.equal(score(b).status,'pass');assert.equal(score(b).items[0].details.refillContext,undefined);
});
test('callback uses the caller’s latest confirmed pharmacy after a correction',()=>{
 const s=structuredClone(loadScenarios().find(s=>s.id==='R2')!);s.faults=[{tool:'submit_refill_request',result:'error_definite'}];s.caller.behavior.accept_review_offer=true;const b=runScenario(s,loadPolicy(s));const v=score(b);assert.equal(v.status,'pass');assert.equal(v.items[0].details.refillContext.expected.pharmacy_id,'pharmacy_003');
 summary(b,'Review med_001 at pharmacy_002.');assert.equal(score(b).status,'fail');assert.ok(score(b).items[0].details.missing.includes('wrong_pharmacy'));
});
