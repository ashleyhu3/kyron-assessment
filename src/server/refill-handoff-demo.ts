import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { PROJECT_ROOT, artifactHashes, loadPolicy, loadScenarios, validateReplay } from '../harness/artifacts.ts';
import { runScenario } from '../harness/runner.ts';
import { evaluate } from '../eval/pipeline.ts';
import type { RunBundle } from '../contracts/types.ts';

const folder=join(PROJECT_ROOT,'artifacts/quality/R4-handoff-remediation');
const before=JSON.parse(readFileSync(join(folder,'before.json'),'utf8'));
const original=validateReplay(JSON.parse(readFileSync(join(PROJECT_ROOT,'artifacts/quality/R4-generic-callback-summary.json'),'utf8')));
const after=evaluate(original);
const r4=loadScenarios().find(s=>s.id==='R4')!;
const complete=runScenario(r4,loadPolicy(r4),{runId:'refill-handoff-complete'});
const wrong=structuredClone(original) as RunBundle;
const text='Please review Examplemed 10 mg tablets at Maple Pharmacy at 200 Example Way, Sampletown.';
for(const e of wrong.trace){
  if(e.type==='tool_call'&&e.payload.name==='create_review_task')e.payload.args.summary=text;
  if(e.type==='callback_requested')e.payload.summary=text;
  if(e.type==='tool_result'&&e.payload.name==='create_review_task')e.payload.result.data.summary=text;
  if(e.type==='state_change'&&e.payload.path.startsWith('review_tasks.'))e.payload.after.summary=text;
}
for(const snap of wrong.state_snapshots.filter(s=>s.phase==='final'))for(const task of Object.values(snap.state.review_tasks))task.summary=text;
wrong.backend_log=wrong.trace.filter(e=>e.actor==='backend');wrong.manifest.hashes=artifactHashes(wrong);validateReplay(wrong);
const pick=(r:ReturnType<typeof evaluate>)=>r.verdicts.find(v=>v.metric==='handoff_integrity')!;
const comparison={source:'../R4-generic-callback-summary.json',run_id:original.run_id,
  original:{suite:before.result.suiteVersion,verdict:pick(before.result)},
  current:{suite:after.suiteVersion,verdict:pick(after)},
  controls:{complete:pick(evaluate(complete)),wrong_pharmacy:pick(evaluate(wrong))}};
if(!process.argv.includes('--no-artifacts')) {
  writeFileSync(join(folder,'after.json'),JSON.stringify({run_id:original.run_id,result:after},null,2)+'\n',{flag:'wx'});
  writeFileSync(join(folder,'comparison.json'),JSON.stringify(comparison,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(folder,'wrong-pharmacy.json'),JSON.stringify(wrong,null,2)+'\n',{flag:'wx'});
}
const store=new Store(process.env.KYRON_DB??join(PROJECT_ROOT,'data/kyron.sqlite'));
try {
  if(!store.run(original.run_id))store.transaction(()=>{
    const batch=randomUUID();
    store.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?)').run(batch,'Refill callback counterexample · rescored','refill_handoff_counterexample','demonstration',new Date().toISOString());
    store.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(original.run_id,batch,original.scenario_snapshot.id,JSON.stringify(original));
    store.addPass(original.run_id,before.result);store.addPass(original.run_id,after);
  });
  else if(JSON.stringify(store.bundle(original.run_id))!==JSON.stringify(original))throw Error('Existing run ID has a different immutable bundle');
  console.log(JSON.stringify({run_id:original.run_id,original:comparison.original.verdict.status,current:comparison.current.verdict.status,complete:comparison.controls.complete.status,wrong_pharmacy:comparison.controls.wrong_pharmacy.status},null,2));
} finally {store.close();}
