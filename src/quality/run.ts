import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadScenarios, loadPolicy, artifactHashes } from '../harness/artifacts.ts';
import { runScenario } from '../harness/runner.ts';
import { evaluate, evidenceResolves } from '../eval/pipeline.ts';
import { REASONS } from '../eval/evaluators.ts';
import { CONTROLS, runControl } from '../testing/controls.ts';
import type { RunBundle } from '../harness/types.ts';
const out='artifacts/quality'; mkdirSync(out,{recursive:true});
const scenarios=loadScenarios();
const base=scenarios.flatMap(s=>['baseline','candidate'].map(configuration=>runScenario(s,loadPolicy(s),{configuration:configuration as any,runId:`quality-${configuration}-${s.id}`})));
const controls=scenarios.flatMap(s=>CONTROLS.map(c=>runControl(s,c)));
const results:any[]=[];
function check(id:string,name:string,status:string,details:any){results.push({id,name,status,details});}
function mutate(name:string,id:string,fn:(b:RunBundle)=>void){const b=structuredClone(base.find(b=>b.scenario_snapshot.id===id&&b.agent_config.id==='candidate')!);fn(b);b.backend_log=b.trace.filter(e=>e.actor==='backend');b.manifest.hashes=artifactHashes(b);writeFileSync(join(out,name+'.json'),JSON.stringify(b,null,2));return b;}
let stable=true;for(const b of base){const s=b.scenario_snapshot;const repeat=runScenario(s,loadPolicy(s),{configuration:b.agent_config.id as any,runId:b.run_id});if(JSON.stringify(b)!==JSON.stringify(repeat)||JSON.stringify(evaluate(b))!==JSON.stringify(evaluate(b)))stable=false;}
check('A1','Determinism and rescoring idempotence',stable?'pass':'fail',{interactions:base.length});
const stored:any[]=[];const db=new DatabaseSync('data/kyron.sqlite',{readOnly:true});
for(const row of db.prepare('SELECT p.result_json,r.bundle_json FROM evaluation_passes p JOIN runs r ON r.id=p.run_id').all() as any[])stored.push({bundle:JSON.parse(row.bundle_json),evaluation:JSON.parse(row.result_json)});db.close();
let refs=0;const violations:any[]=[];
for(const {bundle,evaluation} of stored){const input={expected:bundle.scenario_snapshot.expected,policy:bundle.policy_snapshot,trace:bundle.trace,snapshots:bundle.state_snapshots,coverage:bundle.manifest.coverage};for(const v of evaluation.verdicts){refs++;if(['pass','fail'].includes(v.status)&&!v.evidence.length)violations.push({metric:v.metric,error:'no_evidence'});for(const ref of [...v.evidence,...v.items.flatMap((i:any)=>i.evidence)])if(!evidenceResolves(ref,input))violations.push({metric:v.metric,ref});if(!REASONS[v.metric as keyof typeof REASONS].includes(v.reasonCode)&&!['missing_required_evidence','invalid_run_artifacts','evaluator_error','invalid_evaluator_output'].includes(v.reasonCode))violations.push({metric:v.metric,reason:v.reasonCode});}}
check('A2','Stored evidence references and reason enums',violations.length?'fail':'partial',{verdicts:refs,violations,manual_remaining:'Explanation semantic faithfulness has not been independently audited.'});
const seen=new Set([...base,...controls].flatMap(b=>evaluate(b).verdicts.map(v=>`${v.metric}:${v.reasonCode}`)));
const missing=Object.entries(REASONS).flatMap(([metric,reasons])=>reasons.map(r=>`${metric}:${r}`)).filter(x=>!seen.has(x));
check('A3','Reason-code reachability',missing.length?'partial':'pass',{scope:'Fresh baseline/candidate and control outputs only; some missing reasons are covered by existing mutation tests. Full reason coverage is not established.',covered:seen.size,total:Object.values(REASONS).flat().length,missing});

const signature=(b:RunBundle)=>evaluate(b).verdicts.map(v=>({metric:v.metric,status:v.status,reason:v.reasonCode}));
const equivalence:any[]=[];
for(const original of base){
 const renamed=JSON.parse(JSON.stringify(original).split(original.run_id).join('opaque-renamed-run')) as RunBundle;
 renamed.manifest.hashes=artifactHashes(renamed);
 equivalence.push({run:original.run_id,mutation:'rename_run_event_call_ids',same:JSON.stringify(signature(original))===JSON.stringify(signature(renamed))});
 const wording=structuredClone(original);for(const e of wording.trace)if(e.type==='agent_message')e.payload.text='  '+e.payload.text.toUpperCase()+'  ';
 wording.manifest.hashes=artifactHashes(wording);
 equivalence.push({run:original.run_id,mutation:'case_and_whitespace',same:JSON.stringify(signature(original))===JSON.stringify(signature(wording))});
}
check('A4-equivalence','Identity and casing equivalence',equivalence.every(r=>r.same)?'pass':'fail',{cases:equivalence.length,failures:equivalence.filter(r=>!r.same)});

const inconsistent=mutate('counterexample-state-disagreement','A5',b=>{b.state_snapshots.find(s=>s.phase==='final')!.state.appointments.apt_104.slot='2026-12-04T14:00:00-05:00';b.trace.find(e=>e.type==='state_change')!.payload.after.slot='2026-12-04T14:00:00-05:00';const status=b.trace.find(e=>e.type==='tool_result'&&e.payload.name==='get_operation_status')!;status.payload.result.data.data.appointment.slot='2026-12-04T14:00:00-05:00';});
const stateResult=evaluate(inconsistent);writeFileSync(join(out,'counterexample-state-disagreement-result.json'),JSON.stringify(stateResult,null,2));
check('A4-state','Claim versus contradictory observed state',stateResult.verdicts.find(v=>v.metric==='claim_support')!.status==='pass'?'fail':'pass',{claimSupport:stateResult.verdicts.find(v=>v.metric==='claim_support'),outcome:stateResult.verdicts.find(v=>v.metric==='outcome'),expected:'Claim support must fail or abstain when the status-read payload and preceding state change disagree with the claimed slot.'});
const dropped=mutate('counterexample-missing-provenance','A1',b=>{b.trace=b.trace.filter(e=>e.type!=='state_change');b.trace.forEach((e,i)=>{e.seq=i+1;e.id=`${b.run_id}:event:${i+1}`;});});
check('A4-provenance','Dropped state-change provenance',evaluate(dropped).verdicts.find(v=>v.metric==='outcome')!.status==='pass'?'fail':'pass',{actual:evaluate(dropped).verdicts.find(v=>v.metric==='outcome')!.status,expected:'Detect incomplete provenance; current check does not cross-validate state diffs against event coverage.'});
check('A5','Full pre-written control signature matrix','partial',{executed:controls.length,existing_asserted_cells:7,missing:'No full frozen expected_signatures matrix or edit history. Existing selected signatures remain in tests/evaluation.test.ts; observed signatures were not promoted to expectations.'});
const maskResults:any[]=[];for(const b of base)for(const kind of ['final_state','tool_events','intent_annotations','backend_log','handoff_requests']){const masked=structuredClone(b);masked.manifest.coverage[kind]='unavailable';masked.manifest.hashes=artifactHashes(masked);const after=evaluate(masked);const before=evaluate(b);maskResults.push({scenario:b.scenario_snapshot.id,agent:b.agent_config.id,kind,beforePasses:before.counts.pass,afterPasses:after.counts.pass,statuses:Object.fromEntries(after.verdicts.map(v=>[v.metric,v.status]))});}
check('A6','Evidence masking','partial',{cases:maskResults.length,pass_increases:maskResults.filter(r=>r.afterPasses>r.beforePasses),handoffCoverageIgnored:maskResults.filter(r=>r.kind==='handoff_requests'&&r.statuses.handoff_integrity==='pass'),limitation:'Coverage-bit tests; full removal/reconstruction combinations are not exhaustively generated.'});
const malformed=mutate('counterexample-null-tool-result','A1',b=>{b.trace.find(e=>e.type==='tool_result'&&e.payload.name==='reschedule_appointment')!.payload.result=null;});
let nullResult:any;try{nullResult={crashed:false,statuses:evaluate(malformed).verdicts.map(v=>v.status)};}catch(e){nullResult={crashed:true,error:String(e)};}
check('A7-null','Malformed nested tool-result payload',nullResult.crashed?'fail':'pass',nullResult);
for(const mode of ['truncate','duplicate_sequence','orphan_result','missing_end','empty_close','huge_close']){const b=mutate('fuzz-'+mode,'A1',b=>{if(mode==='truncate')b.trace=b.trace.slice(0,5);if(mode==='duplicate_sequence')b.trace[4].seq=b.trace[3].seq;if(mode==='orphan_result')b.trace.find(e=>e.type==='tool_result')!.payload.call_id='orphan';if(mode==='missing_end')b.trace.pop();if(mode==='empty_close'||mode==='huge_close')b.trace.filter(e=>e.type==='agent_message').at(-1)!.payload.text=mode==='empty_close'?'':'x'.repeat(200000);});try{const e=evaluate(b);check('A7-'+mode,mode,e.verdicts.every(v=>v.status==='unknown')?'pass':'fail',{statuses:e.verdicts.map(v=>[v.metric,v.status])});}catch(e){check('A7-'+mode,mode,'fail',{crash:String(e)});}}
const imports:any[]=[];for(const file of ['pipeline.ts','compare.ts','types.ts','claims.ts','evaluators.ts','facts.ts','predicates.ts','calibration.ts']){const source=readFileSync(join('src/eval',file),'utf8');for(const line of source.split('\n').filter(line=>line.includes('from ')&&line.includes('harness/')))imports.push({file,line});}
check('A8','Evaluation module boundary',imports.length?'fail':'pass',{imports,qualification:'Imports are shared types/hash/replay validation, not agent execution. Still fails the supplied literal zero-harness-import boundary.'});
const versionCheck=spawnSync(process.execPath,['scripts/check-evaluator-versions.mjs'],{encoding:'utf8'});
check('A9','Code hash/version baseline',versionCheck.status===0?'partial':'fail',{output:versionCheck.stdout+versionCheck.stderr,remaining:'Baseline check is part of npm run check; remote CI is not configured.'});
const flips=base.map(b=>({run:b.run_id,before:evaluate(b,{version:'v1'}).verdicts.find(v=>v.metric==='clarity')!,after:evaluate(b,{version:'v2'}).verdicts.find(v=>v.metric==='clarity')!})).filter(r=>r.before.status!==r.after.status);
check('B4','Calibration credibility','pending_human',{independent_labels:0,flips:flips.map(r=>({run:r.run,before:r.before.status,after:r.after.status,reason:r.after.reasonCode})),missing:['independent claim recall audit','human verdict audit','right-reason agreement','label balance/unsure flags/intra-rater reliability','frozen held-out process']});
const coverage=scenarios.map(s=>({scenario:s.id,workflow:s.workflow,complication:s.title,escalation:s.expected.escalation,oracleOutcome:evaluate(runControl(s,'oracle')).verdicts.find(v=>v.metric==='outcome')!.status,signatures:CONTROLS.map(c=>({control:c,statuses:evaluate(runControl(s,c)).verdicts.map(v=>v.status)}))}));
check('B3','Scenario diagnostic coverage','partial',{rows:coverage,allOracleOutcomesPass:coverage.every(r=>r.oracleOutcome==='pass'),allDiscriminate:coverage.every(r=>new Set(r.signatures.map(x=>JSON.stringify(x.statuses))).size>1),missing:'Second-reader ambiguity audit and independent leakage review.'});
const start=performance.now();for(let i=0;i<500;i++)evaluate(base[i%base.length]);const first=performance.now()-start;const again=performance.now();for(let i=0;i<500;i++)evaluate(base[i%base.length]);
check('D-performance','500-trace rescoring','partial',{first_ms:first,second_ms:performance.now()-again,ms_per_trace:first/500,cache:'No derived-fact cache is implemented; a faster second pass is not a cache hit.'});
for(const [id,name] of [['B1','Independent trace-first verdict audit'],['B2','Independent actual-run extractor precision/recall'],['C1','Unassisted five-minute investigation'],['C2','Independent product decision test'],['C4','Human explanation readability'],['D-clean','Clean-clone setup drill'],['D-extension','Timed metric and scenario extension drill'],['D-failure','Forced evaluator exception, process kill, and DB-lock drills'],['E','Full documentation/number/ambiguity audit']])check(id,name,'not_run',{reason:'Not established by existing tests or this automated assessment.'});
check('C3','Override and rescoring audit trail','covered_by_tests',{source:'tests/product.test.ts and tests/browser.mjs; fresh test execution is recorded separately.'});
const report={assessment_date:'2026-11-17',basis:'User-supplied quality checklist; engineering audit, not independent human validation',overall:results.some(r=>r.status==='fail')?'NO_GO_UNDER_SUPPLIED_GATES':'AUTOMATED_PROBES_PASS_FULL_ASSESSMENT_INCOMPLETE',results};
writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({overall:report.overall,checks:results.length,failures:results.filter(r=>r.status==='fail').map(r=>r.id),report:out+'/report.json'},null,2));
process.exitCode=results.some(r=>r.status==='fail')?1:0;
