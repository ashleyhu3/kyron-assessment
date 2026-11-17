import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios,loadPolicy } from '../src/harness/artifacts.ts';
import { runScenario } from '../src/harness/runner.ts';
const scenario=(id:string)=>structuredClone(loadScenarios().find(s=>s.id===id)!);
const run=(s:any)=>runScenario(s,loadPolicy(s));
const calls=(b:any,name:string)=>b.trace.filter((e:any)=>e.type==='tool_call'&&e.payload.name===name);
test('a caller naming both workflows is asked which to handle first',()=>{
 const s=scenario('A1');s.caller.opening='I need to reschedule my appointment and request a refill.';
 const b=run(s),question=b.trace.find((e:any)=>e.type==='agent_message'&&e.payload.text.includes('Which request would you like to handle now'))!;
 const reply=b.trace.find((e:any)=>e.type==='caller_message'&&e.payload.text.includes('appointment first'))!;
 assert.ok(question.seq<reply.seq&&reply.seq<calls(b,'get_appointment')[0].seq);assert.equal(calls(b,'submit_refill_request').length,0);assert.equal(b.status,'completed');assert.match(b.trace.filter((e:any)=>e.type==='agent_message').at(-1)!.payload.text,/contact the clinic.*refill/i);
});
test('out-of-scope clarification ends without accessing records',()=>{
 const s=scenario('A1');s.caller.opening='I have an appointment and need a refill.';s.caller.utterances={workflow_choice:['Neither; I have a billing question.']};
 const b=run(s);assert.equal(calls(b,'get_appointment').length,0);assert.equal(calls(b,'get_medications').length,0);assert.equal(b.status,'completed');
});
test('ambiguous confirmation requires a subsequent explicit yes before any write',()=>{
 const s=scenario('A1');s.caller.utterances={confirmation:["I'm not sure yet.",'Yes, please do that.']};
 const b=run(s),question=b.trace.find((e:any)=>e.type==='agent_message'&&e.payload.text.includes('I have not changed your appointment'))!,yes=b.trace.find((e:any)=>e.type==='caller_message'&&e.payload.text==='Yes, please do that.')!;
 assert.ok(question.seq<yes.seq&&yes.seq<calls(b,'reschedule_appointment')[0].seq);assert.equal(b.status,'completed');
});
test('an affirmative with a correction must recheck and reconfirm the new slot',()=>{
 const s=scenario('A2');s.caller.correction!.text='Yes, but actually could we make that Thursday, December 3, 2026 at 2:00 PM instead?';
 const b=run(s),correction=b.trace.find((e:any)=>e.type==='caller_message'&&e.payload.text.startsWith('Yes, but'))!;const write=calls(b,'reschedule_appointment')[0];
 assert.ok(b.trace.some((e:any)=>e.type==='tool_call'&&e.payload.name==='list_available_slots'&&e.seq>correction.seq&&e.seq<write.seq));assert.equal(write.payload.args.new_slot,s.caller.facts.desired_slot);assert.ok(b.trace.some((e:any)=>e.type==='caller_message'&&e.payload.text==='Yes, please do that.'&&e.seq>correction.seq&&e.seq<write.seq));
});
test('contradictory or tentative yes cannot authorize a refill',()=>{
 const s=scenario('R1');s.caller.utterances={confirmation:["Yes, no, I'm not sure.",'No.']};
 const b=run(s);assert.equal(calls(b,'submit_refill_request').length,0);assert.ok(b.trace.some((e:any)=>e.type==='agent_message'&&e.payload.text.includes('I have not submitted the request.')));assert.equal(b.status,'completed');
});
test('ambiguous refill corrections cannot silently replace a verified medication identifier',()=>{
 const s=scenario('R1');s.caller.utterances={confirmation:['Maybe med_002, I am unsure.','Yes, please do that.']};
 const b=run(s);const write=calls(b,'submit_refill_request')[0];assert.equal(write.payload.args.medication_id,'med_001');assert.ok(b.trace.some((e:any)=>e.type==='agent_message'&&e.payload.text.includes('I have not submitted the request.')));
});
test('an affirmative containing a different explicit slot still requires a new availability check',()=>{
 const s=scenario('A2');s.caller.correction!.text='Yes, I want Thursday, December 3, 2026 at 2:00 PM.';
 const b=run(s),change=b.trace.find((e:any)=>e.type==='caller_message'&&e.payload.text.startsWith('Yes, I want'))!;const write=calls(b,'reschedule_appointment')[0];
 assert.ok(calls(b,'list_available_slots').some((e:any)=>e.seq>change.seq&&e.seq<write.seq));assert.equal(write.payload.args.new_slot,s.caller.facts.desired_slot);
});
