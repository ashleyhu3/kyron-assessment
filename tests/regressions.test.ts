import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScenarios, loadPolicy, artifactHashes } from '../src/harness/artifacts.ts';
import { runScenario } from '../src/harness/runner.ts';
import { evaluate } from '../src/eval/pipeline.ts';
import type { RunBundle } from '../src/contracts/types.ts';
const scenario=(id:string)=>loadScenarios().find(s=>s.id===id)!;
const run=(id:string)=>runScenario(scenario(id),loadPolicy(scenario(id)),{runId:`regression-${id}`});
function changed(b:RunBundle){b.backend_log=b.trace.filter(e=>e.actor==='backend');b.manifest.hashes=artifactHashes(b);return b;}
const status=(b:RunBundle,metric='claim_support')=>evaluate(changed(b)).verdicts.find(v=>v.metric===metric)!;

test('reported wrong-slot counterexample fails claim support, not only task outcome',()=>{
 const b=JSON.parse(readFileSync('artifacts/quality/before-improvements/counterexample-state-disagreement.json','utf8'));
 assert.equal(status(b).status,'fail');
});
test('successful responses with wrong pharmacy or medication cannot substantiate a request claim',()=>{
 for(const field of ['pharmacy_id','medication_id']){
  const b=run('R1');b.trace.find(e=>e.type==='tool_result'&&e.payload.name==='submit_refill_request')!.payload.result.data[field]='different';
  assert.equal(status(b).status,'fail',field);
 }
});
test('missing successful-response details abstain rather than use requested arguments as proof',()=>{
 const b=run('A1');b.trace.find(e=>e.type==='tool_result'&&e.payload.name==='reschedule_appointment')!.payload.result.data={};
 assert.equal(status(b).status,'unknown');
});
test('state conflicts without causal history abstain rather than falsely confirming success',()=>{
 const b=run('A1');b.state_snapshots.find(s=>s.phase==='final')!.state.appointments.apt_104.slot='2026-12-04T14:00:00-05:00';
 assert.equal(status(b).status,'unknown');assert.equal(status(b,'outcome').status,'unknown');
});
test('later state changes do not rewrite the truth of an earlier statement',()=>{
 const b=run('A1');const tail=b.trace.splice(-2);
 const original=structuredClone(b.state_snapshots[1].state.appointments.apt_104);
 const next={...original,slot:'2026-12-04T14:00:00-05:00'};
 const template=structuredClone(b.trace.at(-1)!);const callId='later-call';
 for(const [actor,type,payload] of [
  ['agent','tool_call',{call_id:callId,name:'reschedule_appointment',mutating:true,args:{patient_id:'patient_001',appointment_id:'apt_104',new_slot:next.slot}}],
  ['backend','backend_operation',{call_id:callId,name:'reschedule_appointment',committed:true}],
  ['backend','state_change',{call_id:callId,path:'appointments.apt_104',before:original,after:next}],
  ['tool','tool_result',{call_id:callId,name:'reschedule_appointment',result:{status:'ok',latency_ms:1,data:{appointment:{id:'apt_104',...next}}}}],
 ] as const)b.trace.push({...template,actor,type,payload});
 b.trace.push(...tail);b.trace.forEach((e,i)=>{e.seq=i+1;e.id=`${b.run_id}:event:${i+1}`;e.sim_time=new Date(Date.parse(b.scenario_snapshot.simulated_now)+i).toISOString();});
 b.state_snapshots[1].state.appointments.apt_104=next;
 assert.equal(status(b).status,'pass');
});
test('nested malformed payloads, unknown event types, and invalid message bounds never crash or pass',()=>{
 for(const mutation of ['null','missing','wrong_status','empty','oversized','unknown_type']){
  const b=run('A1'),e=b.trace.find(e=>e.type==='tool_result'&&e.payload.name==='reschedule_appointment')!;
  if(mutation==='null')e.payload.result=null;
  if(mutation==='missing')delete e.payload.result;
  if(mutation==='wrong_status')e.payload.result.status='probably';
  if(mutation==='empty')b.trace.filter(e=>e.type==='agent_message').at(-1)!.payload.text='  ';
  if(mutation==='oversized')b.trace.filter(e=>e.type==='agent_message').at(-1)!.payload.text='x'.repeat(32001);
  if(mutation==='unknown_type')e.type='unrecognized';
  const result=evaluate(changed(b));assert.equal(result.counts.unknown,7,mutation);
 }
});
test('lost, invented, or misattributed state changes cannot establish a successful outcome',()=>{
 for(const mutation of ['remove','before','call']){
  const b=run('A1');const e=b.trace.find(e=>e.type==='state_change')!;
  if(mutation==='remove')b.trace=b.trace.filter(x=>x!==e);
  if(mutation==='before')e.payload.before.slot='invented';
  if(mutation==='call')e.payload.call_id='orphan';
  b.trace.forEach((e,i)=>{e.seq=i+1;e.id=`${b.run_id}:event:${i+1}`;});
  assert.equal(status(b,'outcome').status,'unknown',mutation);
 }
});
test('casing, spacing, and unavailable handoff evidence are handled consistently across the full suite',()=>{
 for(const s of loadScenarios()){
  const b=run(s.id),original=evaluate(b).verdicts.map(v=>v.status);
  for(const e of b.trace)if(e.type==='agent_message')e.payload.text='  '+e.payload.text.toUpperCase().replaceAll(' ','   ')+'  ';
  // Space normalization is relevant for policy language as well as sentence matching.
  assert.deepEqual(evaluate(changed(b)).verdicts.map(v=>v.status),original,s.id);
  const mask=run(s.id);mask.manifest.coverage.handoff_requests='unavailable';
  assert.equal(status(mask,'handoff_integrity').status,'unknown');
  assert.equal(status(mask,'escalation_decision').status,'unknown');
 }
});
