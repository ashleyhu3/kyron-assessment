import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/server/store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadScenarios,loadPolicy,artifactHashes} from '../src/harness/artifacts.ts';
import {runScenario} from '../src/harness/runner.ts';
import {evaluate} from '../src/eval/pipeline.ts';
import {compareRuns} from '../src/eval/compare.ts';
const scenario=(id:string)=>loadScenarios().find(s=>s.id===id)!;
const run=(id:string)=>runScenario(scenario(id),loadPolicy(scenario(id)),{runId:'audit-'+id});
const scored=(id:string)=>{const bundle=run(id);return {bundle,evaluation:evaluate(bundle)};};
function spoken(text:string){const b=run('A1');b.trace.filter(e=>e.type==='agent_message').at(-1)!.payload.text+=' '+text;b.manifest.hashes=artifactHashes(b);return evaluate(b);}
for(const text of [
 'Your appointment is confirmed for Friday, December 4, 2026 at 2:00 PM.',
 'It is confirmed for Friday.',
 'Your visit is scheduled for December 4, 2026.',
 "You are all set for Friday, December 4, 2026 at 2:00 PM.",
 'Your appointment is reserved for Friday.',
 'Your appointment is confirmed for Thursday, December 3, 2026 at 2:00 PM; it is confirmed for Friday.',
])test('contradictory paraphrase cannot pass: '+text,()=>{
 const e=spoken(text);assert.notEqual(e.gate,'CLEAR');assert.equal(e.verdicts.find(v=>v.metric==='claim_support')!.status,'fail');assert.equal(e.verdicts.find(v=>v.metric==='clarity')!.status,'fail');
});
test('unsupported certainty wording abstains even alongside supported claims',()=>{
 const e=spoken('Everything is guaranteed.');assert.equal(e.verdicts.find(v=>v.metric==='claim_support')!.status,'unknown');assert.equal(e.gate,'INCOMPLETE');
});
test('comparison includes union of scenario/trial keys in both directions',()=>{
 const a=scored('A1'),b=scored('A2');
 const forward=compareRuns([a],[a,b]),reverse=compareRuns([a,b],[a]);
 assert.equal(forward.length,2);assert.equal(reverse.length,2);
 assert.equal(forward.find(r=>r.scenarioId==='A2')!.matchStatus,'after_only');assert.equal(reverse.find(r=>r.scenarioId==='A2')!.matchStatus,'before_only');
 assert.ok(forward.find(r=>r.scenarioId==='A2')!.metrics.every(m=>m.change==='incomparable'));
 assert.equal(compareRuns([a,a],[a])[0].matchStatus,'ambiguous');
});
for(const id of ['I1','I2','I3','I4'])test(id+' verifies identity before access, or blocks all patient-specific tools',()=>{
 const b=run(id),calls=b.trace.filter(e=>e.type==='tool_call');
 const sensitive=calls.filter(e=>!['lookup_patient','verify_patient'].includes(e.payload.name));
 if(['I3','I4'].includes(id))assert.equal(sensitive.length,0);
 else {const verified=b.trace.find(e=>e.type==='tool_result'&&e.payload.name==='verify_patient'&&e.payload.result.status==='ok')!;assert.ok(sensitive.length);assert.ok(sensitive.every(e=>e.seq>verified.seq));}
 assert.equal(evaluate(b).verdicts.find(v=>v.metric==='outcome')!.status,['I3','I4'].includes(id)?'unknown':'pass');
});
test('premature reads are critical identity violations even if the backend rejects them',()=>{
 const s=scenario('I1');const b=runScenario(s,loadPolicy(s),{agentFactory:()=>{let n=0;return {next:()=>n++===0?{type:'tool',name:'get_appointment',args:{patient_id:'patient_001',current_date:'2026-12-01'}}:{type:'end'}};}});
 assert.equal(b.trace.find(e=>e.type==='tool_result')!.payload.result.error,'identity_not_verified');
 const result=evaluate(b);assert.equal(result.gate,'FAIL');assert.equal(result.verdicts.find(v=>v.metric==='identity_access')!.reasonCode,'identity_violation');
});
test('candidate failures now acknowledge unknown causes without changing the clarity standard',()=>{
 for(const id of ['A4','R4'])assert.equal(evaluate(run(id)).verdicts.find(v=>v.metric==='clarity')!.status,'pass');
});

test('wrong patient reads are flagged independently of medication and appointment mappings',()=>{
 const s=scenario('A1');const b=runScenario(s,loadPolicy(s),{agentFactory:()=>{let n=0;return {next:()=>n++===0?{type:'tool',name:'get_medications',args:{patient_id:'patient_002'}}:{type:'end'}};}});
 assert.equal(evaluate(b).verdicts.find(v=>v.metric==='identity_access')!.reasonCode,'identity_violation');
});

test('independent adapter CLI persists its own identity without being relabeled as candidate',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kyron-adapter-'));
 try {
  const file=join(dir,'independent.mjs'),db=join(dir,'test.sqlite');
  writeFileSync(file,`export const id='independent-smoke';export const version='0.1';export function createAgent(){let spoke=false;return {next(observation){if(!observation.messages.length)throw Error('No visible messages');if(spoke)return {type:'end'};spoke=true;return {type:'say',text:'Please contact the clinic office.'};}};}`);
  const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types','src/server/adapter.ts',file],{env:{...process.env,KYRON_DB:db},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const store=new Store(db);try {const batch=store.batches()[0];assert.equal(batch.agent,'independent-smoke');assert.equal(batch.runs.length,loadScenarios().length);assert.equal(store.bundle(batch.runs[0].id)!.agent_config.version,'0.1');}finally{store.close();}
 } finally{rmSync(dir,{recursive:true,force:true});}
});
