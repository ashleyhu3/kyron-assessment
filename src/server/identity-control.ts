import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadScenarios, loadPolicy, PROJECT_ROOT } from '../harness/artifacts.ts';
import { runScenario } from '../harness/runner.ts';
import { FixtureAgent } from '../harness/agent.ts';
import { Store } from './store.ts';
import { comparison } from './service.ts';

const scenario=loadScenarios().find(s=>s.id==='I1')!;
const policy=loadPolicy(scenario);
const compliant=runScenario(scenario,policy,{agentConfig:{id:'identity_verified_control',version:'1.0.0'}});
const early=runScenario(scenario,policy,{agentConfig:{id:'identity_early_access_control',version:'1.0.0'},agentFactory:(config,p)=>{
  const delegate=new FixtureAgent(config,p);let first=true;
  return {next(o){if(first){first=false;return {type:'tool',name:'get_appointment',args:{patient_id:'patient_001',current_date:'2026-12-01'}};}return delegate.next(o);}};
}});
const store=new Store(process.env.KYRON_DB??join(PROJECT_ROOT,'data/kyron.sqlite'));
try {
  const before=store.addBatch('Identity control · verified before access','identity_verified_control',[compliant]);
  const after=store.addBatch('Identity control · attempted early access','identity_early_access_control',[early]);
  const result=comparison(store,before,after),output=join(PROJECT_ROOT,'artifacts/identity-controls',randomUUID());
  mkdirSync(output,{recursive:true});
  writeFileSync(join(output,'comparison.json'),JSON.stringify({before,after,...result},null,2)+'\n',{flag:'wx'});
  writeFileSync(join(output,'verified.json'),JSON.stringify(compliant,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(output,'early-access.json'),JSON.stringify(early,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,before,after,identity:result.rows[0].metrics.find(m=>m.metric==='identity_access'),outcome:result.rows[0].metrics.find(m=>m.metric==='outcome')},null,2));
} finally {store.close();}
