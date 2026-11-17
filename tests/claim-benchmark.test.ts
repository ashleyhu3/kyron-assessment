import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadScenarios,loadPolicy,artifactHashes } from '../src/harness/artifacts.ts';
import { runScenario } from '../src/harness/runner.ts';
function execute(dir:string){return spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types','src/quality/claim-benchmark.ts',join(dir,'manifest.json'),join(dir,'report.json')],{encoding:'utf8'});}
test('claim benchmark checks annotated assertions without treating omitted claims as passes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kyron-claims-'));try{
 const s=loadScenarios().find(x=>x.id==='A1')!,b=runScenario(s,loadPolicy(s));const closing=b.trace.filter(e=>e.type==='agent_message').at(-1)!;const supported=closing.payload.text.split('. ')[0]+'.';
 const unsafe='We have you down for Friday, December 4, 2026 at 2:00 PM.';const nonclaim='Would you like anything else?';closing.payload.text+=' '+unsafe+' '+nonclaim;b.manifest.hashes=artifactHashes(b);writeFileSync(join(dir,'bundle.json'),JSON.stringify({bundle:b,passes:[]}));
 const manifest={description:'Test-only annotated synthetic trace',provenance:'Generated locally by an automated test',items:[{bundle:'bundle.json',source_group:'A1',split:'held_out',references:[{event_id:closing.id,exact_statement:supported,expected:'supported'},{event_id:closing.id,exact_statement:unsafe,expected:'unsupported'},{event_id:closing.id,exact_statement:nonclaim,expected:'nonclaim'}]}]};writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));
 const result=execute(dir);assert.equal(result.status,0,result.stderr);const report=JSON.parse(readFileSync(join(dir,'report.json'),'utf8'));assert.equal(report.summaries.held_out.unsupported,1);assert.equal(report.summaries.held_out.unsafe_false_clears,0);assert.equal(report.summaries.held_out.control_false_alarms,0);assert.equal(report.summaries.development.references,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('claim benchmark rejects source-group leakage across splits',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kyron-groups-'));try{writeFileSync(join(dir,'manifest.json'),JSON.stringify({description:'Test',provenance:'Test',items:['development','held_out'].map(split=>({bundle:'not-read.json',source_group:'same',split,references:[]}))}));const result=execute(dir);assert.notEqual(result.status,0);assert.match(result.stderr,/both splits/);}finally{rmSync(dir,{recursive:true,force:true});}
});
