import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScenarios, loadPolicy, artifactHashes } from '../src/harness/artifacts.ts';
import { runScenario } from '../src/harness/runner.ts';
import { evaluate } from '../src/eval/pipeline.ts';
import { extractClaims } from '../src/eval/claims.ts';
import type { Agent, Observation } from '../src/contracts/types.ts';
import { FixtureAgent } from '../src/harness/agent.ts';
const scenario=(id:string)=>structuredClone(loadScenarios().find(s=>s.id===id)!);
const corpus=JSON.parse(readFileSync('tests/fixtures/claim-recall.json','utf8'));
for(const row of corpus.cases)test(`${row.expect}: ${row.text}`,()=>{
  const s=scenario(row.base),b=runScenario(s,loadPolicy(s));
  const closing=b.trace.filter(e=>e.type==='agent_message').at(-1)!;
  const original=extractClaims(b.trace).length;
  closing.payload.text+=' '+row.text;b.manifest.hashes=artifactHashes(b);
  const result=evaluate(b),support=result.verdicts.find(v=>v.metric==='claim_support')!,clarity=result.verdicts.find(v=>v.metric==='clarity')!;
  if(row.expect==='reject_or_abstain') {
    assert.notEqual(support.status,'pass');assert.notEqual(clarity.status,'pass');assert.notEqual(result.gate,'CLEAR');
    assert.ok(result.facts.claims.some(c=>row.text.includes(c.text) && c.status!=='supported'));
  } else if(row.expect==='supported') {assert.equal(support.status,'pass');assert.equal(clarity.status,'pass');}
  else {assert.equal(extractClaims(b.trace).length,original);assert.equal(support.status,'pass');}
});
test('independent observation spy receives no patient ID until verification succeeds',()=>{
  for(const id of ['I1','I2','I3','I4']) {
    const s=scenario(id),observed:Observation[]=[];
    assert.equal('patient_id' in s.agent_visible_initial,false);
    const b=runScenario(s,loadPolicy(s),{agentFactory:(config,policy):Agent=>{
      const agent=new FixtureAgent(config,policy);
      return {next:o=>{observed.push(structuredClone(o));return agent.next(o);}};
    }});
    assert.equal(b.status,'completed');assert.equal('patient_id' in observed[0].session,false);
    for(const o of observed) {
      if(!o.session.identity_verified)assert.equal('patient_id' in o.session,false);
      else assert.equal(o.session.patient_id,s.caller.facts.patient_id);
      assert.equal(JSON.stringify(o).includes('expected'),false);
    }
    assert.equal(observed.some(o=>o.session.identity_verified),['I1','I2'].includes(id));
  }
});
test('a legacy unverified session containing an ID is redacted at the observation boundary',()=>{
  const s=scenario('I2');s.agent_visible_initial.patient_id=s.caller.facts.patient_id;
  const b=runScenario(s,loadPolicy(s),{agentFactory:()=>({next:o=>{assert.equal('patient_id' in o.session,false);return {type:'end'};}})});
  assert.equal(b.status,'completed');
});
