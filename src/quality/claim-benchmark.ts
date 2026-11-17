import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { validateReplay, hash } from '../contracts/artifacts.ts';
import { evaluate } from '../eval/pipeline.ts';
const reference=z.object({event_id:z.string().min(1),exact_statement:z.string().trim().min(1),expected:z.enum(['supported','unsupported','uncertain','nonclaim'])});
const manifestSchema=z.object({description:z.string().min(1),provenance:z.string().min(1),items:z.array(z.object({bundle:z.string().min(1),source_group:z.string().min(1),split:z.enum(['development','held_out']),references:z.array(reference)})).min(1)});
const file=process.argv[2],output=process.argv[3];if(!file||!output)throw Error('Usage: npm run claim:benchmark -- <manifest.json> <new-report.json>');
const manifest=manifestSchema.parse(JSON.parse(readFileSync(file,'utf8'))),groups=new Map<string,string>();
for(const item of manifest.items){const existing=groups.get(item.source_group);if(existing&&existing!==item.split)throw Error(`Source group appears in both splits: ${item.source_group}`);groups.set(item.source_group,item.split);}
const rows=manifest.items.flatMap(item=>{
 const source=JSON.parse(readFileSync(resolve(dirname(file),item.bundle),'utf8'));
 const bundle=validateReplay(source.bundle??source),scored=evaluate(bundle);
 if(scored.diagnostics.length)throw Error(`Invalid evaluation: ${scored.diagnostics.join('; ')}`);
 return item.references.map(ref=>{const event=bundle.trace.find(e=>e.id===ref.event_id&&e.type==='agent_message');if(!event||!event.payload.text.includes(ref.exact_statement))throw Error(`Reference quotation not found in agent event ${ref.event_id}`);
 const matches=scored.facts.claims.filter(c=>c.eventId===ref.event_id&&(ref.exact_statement.includes(c.text)||c.text.includes(ref.exact_statement)));
 const observed=matches.map(c=>c.status), detected=matches.length>0;
 const unsafeFalseClear=ref.expected==='unsupported'&&(!detected||observed.includes('supported'));
 const falseAlarm=ref.expected==='supported'&&observed.some(x=>['contradicted','unsupported','premature'].includes(x!))||ref.expected==='nonclaim'&&detected;
 return {source_group:item.source_group,split:item.split,run_id:bundle.run_id,reference:ref,detected,observed,unsafeFalseClear,falseAlarm,abstained:observed.includes('unknown'),matches};});
});
const summaries=Object.fromEntries(['development','held_out'].map(split=>{const all=rows.filter(r=>r.split===split),unsupported=all.filter(r=>r.reference.expected==='unsupported'),controls=all.filter(r=>['supported','nonclaim'].includes(r.reference.expected));return [split,{references:all.length,unsupported:unsupported.length,unsupported_detected:unsupported.filter(r=>r.detected).length,unsupported_unrecognized:unsupported.filter(r=>!r.detected).length,unsupported_correctly_flagged:unsupported.filter(r=>!r.unsafeFalseClear&&r.observed.some(x=>['contradicted','unsupported','premature'].includes(x!))).length,unsafe_false_clears:unsupported.filter(r=>r.unsafeFalseClear).length,unsupported_abstained:unsupported.filter(r=>r.abstained).length,controls:controls.length,supported_total:all.filter(r=>r.reference.expected==='supported').length,supported_omitted:all.filter(r=>r.reference.expected==='supported'&&!r.detected).length,nonclaims_total:all.filter(r=>r.reference.expected==='nonclaim').length,control_false_alarms:controls.filter(r=>r.falseAlarm).length,control_abstained:controls.filter(r=>r.abstained).length}];}));
writeFileSync(output,JSON.stringify({description:manifest.description,provenance:manifest.provenance,manifest_hash:hash(manifest),interpretation:'Reference authorship and label independence are user-supplied. Empty denominators are not performance estimates. Unknown is not a pass.',summaries,rows},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,summaries},null,2));
