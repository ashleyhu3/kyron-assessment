export function normalizeWords(text:string):string {return text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
export function catalogMatches(text:string, records:Record<string,any>): {id:string;[key:string]:any}[] {
 const query=normalizeWords(text);
 const named=Object.entries(records).filter(([,r])=>r.label&&query.includes(normalizeWords(r.label)));
 const located=named.filter(([,r])=>!r.address||query.includes(normalizeWords(String(r.address).split(',')[0])));
 return (located.length?located:named).map(([id,r])=>({id,...r}));
}
export function pharmacyName(record:any):string {return `${record.label}${record.address?` at ${record.address}`:''}`;}
