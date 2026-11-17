// Deliberately bounded language support: explicit month/day/year and AM/PM,
// plus ISO input. The backend retains canonical timestamps and identifiers.
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
export function parseDate(text:string):string|undefined {
 const iso=text.match(/\b(\d{4}-\d{2}-\d{2})\b/);if(iso)return iso[1];
 const match=text.match(new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`,'i'));if(!match)return;
 const month=MONTHS.indexOf(match[1].toLowerCase())+1,day=Number(match[2]),year=Number(match[3]);
 const date=new Date(Date.UTC(year,month-1,day));if(date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return;
 return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
export function parseTime(text:string):string|undefined {
 const m=text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);if(!m)return;
 const hour=Number(m[1]),minute=Number(m[2]??0);if(hour<1||hour>12||minute>59)return;
 return `${String(hour%12+(m[3].toLowerCase()==='pm'?12:0)).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}
export function dateKey(slot:string,zone:string):string {
 const p=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(slot));
 const get=(type:string)=>p.find(x=>x.type===type)!.value;return `${get('year')}-${get('month')}-${get('day')}`;
}
export function timeKey(slot:string,zone:string):string {
 return new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(slot));
}
export function formatDate(slot:string,zone:string):string {return new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(new Date(slot));}
export function formatTime(slot:string,zone:string):string {return new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit'}).format(new Date(slot));}
export function formatSlot(slot:string,zone:string):string {return `${formatDate(slot,zone)} at ${formatTime(slot,zone)}`;}
export function parseSlot(text:string,zone:string):string|undefined {
 const iso=text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/i);if(iso)return iso[0];
 const date=parseDate(text),time=parseTime(text);if(!date||!time)return;
 const local=Date.parse(`${date}T${time}:00Z`);let instant=local;
 for(let i=0;i<3;i++) {
  const offset=new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'longOffset'}).formatToParts(new Date(instant)).find(p=>p.type==='timeZoneName')!.value;
  const m=offset.match(/GMT([+-])(\d{2}):(\d{2})/);const minutes=m?(Number(m[2])*60+Number(m[3]))*(m[1]==='+'?1:-1):0;
  instant=local-minutes*60000;
 }
 const result=new Date(instant).toISOString();
 return dateKey(result,zone)===date&&timeKey(result,zone)===time?result:undefined;
}
