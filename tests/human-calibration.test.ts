import test from 'node:test';import assert from 'node:assert/strict';
import {loadScenarios,loadPolicy,artifactHashes} from '../src/harness/artifacts.ts';
import {runScenario}from'../src/harness/runner.ts';import{evaluate}from'../src/eval/pipeline.ts';
const run=(id:string)=>{const s=loadScenarios().find(s=>s.id===id)!;return runScenario(s,loadPolicy(s));};
function removeExplanation(b:any){for(const e of b.trace.filter((e:any)=>e.type==='agent_message'))e.payload.text=e.payload.text.replace(/ I cannot determine why (?:the change|the submission) failed\./g,'');return rehash(b);}
const clarity=(b:any)=>evaluate(b).verdicts.find(v=>v.metric==='clarity')!;
function rehash(b:any){b.manifest.hashes=artifactHashes(b);return b;}
test('a callback does not compensate for an unexplained failed action',()=>{
 for(const id of ['A4','R4']){const b=removeExplanation(run(id));assert.equal(clarity(b).status,'fail');assert.equal(clarity(b).raw.failure_explained,false);}
});
test('honest uncertainty about a failure cause is clear without inventing a reason',()=>{
 const b=run('A4');b.trace.filter((e:any)=>e.type==='agent_message').at(-1)!.payload.text+=" I don't know why the appointment change failed.";
 assert.equal(clarity(rehash(b)).status,'pass');
});
test('an invented cause does not meet the evidence-aware failure rubric',()=>{
 const b=removeExplanation(run('R4'));b.trace.filter((e:any)=>e.type==='agent_message').at(-1)!.payload.text+=' This failed because the pharmacy is closed.';
 assert.equal(clarity(rehash(b)).status,'fail');
});
test('preserving an appointment does not require a redundant lookup when a confirmed read and complete unchanged history exist',()=>{
 const b=run('A3');assert.equal(clarity(b).status,'pass');
 const result=b.trace.find(e=>e.type==='tool_result'&&e.payload.name==='get_appointment')!;
 result.payload.result={status:'error_definite',error:'appointment_unavailable',latency_ms:1};
 // The newly extracted 'I found your appointment' assertion also lacks support.
 assert.equal(clarity(rehash(b)).status,'fail');
});
