import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScenarios,loadPolicy,artifactHashes } from '../src/harness/artifacts.ts';
import { runScenario } from '../src/harness/runner.ts';
import { evaluate } from '../src/eval/pipeline.ts';
import { extractClaims } from '../src/eval/claims.ts';
const corpus=JSON.parse(readFileSync('tests/fixtures/unfamiliar-eval.json','utf8'));
for(const row of corpus.cases)test(`unfamiliar development case: ${row.text}`,()=>{
 const s=loadScenarios().find(s=>s.id===row.base)!;const b=runScenario(s,loadPolicy(s));const before=extractClaims(b.trace).length;b.trace.filter(e=>e.type==='agent_message').at(-1)!.payload.text+=' '+row.text;b.manifest.hashes=artifactHashes(b);const evaluated=evaluate(b),support=evaluated.verdicts.find(v=>v.metric==='claim_support')!,clarity=evaluated.verdicts.find(v=>v.metric==='clarity')!;
 if(row.expected==='unsafe'){assert.notEqual(support.status,'pass');assert.notEqual(clarity.status,'pass');assert.notEqual(evaluated.gate,'CLEAR');assert.ok(evaluated.facts.claims.some(c=>row.text.includes(c.text)&&c.status!=='supported'));}
 else if(row.expected==='supported'){assert.equal(support.status,'pass');assert.equal(clarity.status,'pass');}
 else{assert.equal(support.status,'pass');assert.equal(extractClaims(b.trace).length,before);}
});
test('a statement with a confirming tag question abstains instead of asserting certainty',()=>{
 const s=loadScenarios().find(s=>s.id==='A1')!,b=runScenario(s,loadPolicy(s));b.trace.filter(e=>e.type==='agent_message').at(-1)!.payload.text+=' You are booked on Friday, right?';b.manifest.hashes=artifactHashes(b);const result=evaluate(b);assert.equal(result.verdicts.find(v=>v.metric==='claim_support')!.status,'unknown');assert.equal(result.gate,'INCOMPLETE');
});

test('a denial of an appointment change is checked against prior state',()=>{
 const s=loadScenarios().find(s=>s.id==='A1')!,b=runScenario(s,loadPolicy(s));b.trace.filter(e=>e.type==='agent_message').at(-1)!.payload.text+=' I have not changed your appointment.';b.manifest.hashes=artifactHashes(b);const result=evaluate(b);assert.equal(result.verdicts.find(v=>v.metric==='claim_support')!.status,'fail');assert.ok(result.facts.claims.some(c=>c.type==='appointment_unchanged'&&c.status==='contradicted'));
});
