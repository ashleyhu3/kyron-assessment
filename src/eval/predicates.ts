import { z } from 'zod';

const count = z.object({ collection: z.string().min(1), where: z.record(z.unknown()).optional(), op: z.literal('count'),
  eq: z.number().optional(), gt: z.number().optional() }).refine(p => (p.eq === undefined) !== (p.gt === undefined), 'Exactly one count comparison required');
const equality = z.object({ path: z.string().min(1), op: z.literal('eq'), value: z.unknown() });
export const predicateSchema = z.union([count, equality]);
export const outcomeGroupSchema = z.object({ id: z.string(), all: z.array(predicateSchema).min(1).optional(), any: z.array(predicateSchema).min(1).optional() })
  .refine(g => Boolean(g.all) !== Boolean(g.any), 'One nonempty predicate group required');
export const expectedSchema = z.object({
  outcomes: z.object({ acceptable: z.array(outcomeGroupSchema).min(1), forbidden: z.array(outcomeGroupSchema) }),
  allowed_mutations: z.array(z.string()), critical_entities: z.array(z.object({ entity: z.string(), tool: z.string(), arg: z.string() })),
  escalation: z.enum(['required', 'permitted', 'unnecessary']),
}).passthrough();

export function atPath(object: any, path: string): any {
  if (!path) return object;
  return path.split('.').reduce((value, key) => value != null && Object.hasOwn(value, key) ? value[key] : undefined, object);
}
export function predicate(state: any, p: any): boolean {
  if (p.op === 'eq') return JSON.stringify(atPath(state, p.path)) === JSON.stringify(p.value);
  const collection = atPath(state, p.collection);
  if (!collection || typeof collection !== 'object') throw new Error(`Missing state collection: ${p.collection}`);
  const n = Object.values(collection).filter((row: any) => Object.entries(p.where ?? {}).every(([key, value]) => row[key] === value)).length;
  return p.eq !== undefined ? n === p.eq : n > p.gt;
}
export function groupMatches(state: any, group: any): boolean {
  return group.all ? group.all.every((p: any) => predicate(state, p)) : group.any.some((p: any) => predicate(state, p));
}
export function allowedPath(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const prefix = pattern.endsWith('.*') ? pattern.slice(0, -2) : pattern;
    return path === prefix || path.startsWith(prefix + '.');
  });
}
