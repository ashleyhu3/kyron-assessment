import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadPolicy, loadScenarios, PROJECT_ROOT, validateReplay } from './artifacts.ts';
import { CONFIGURATIONS } from './agent.ts';
import { runScenario } from './runner.ts';

function main() {
  const [command = 'run', ...args] = process.argv.slice(2);
  if (command === 'replay') {
    if (args.length !== 1) throw new Error('Usage: npm run harness -- replay <bundle.json>');
    const b = validateReplay(JSON.parse(readFileSync(resolve(args[0]), 'utf8')));
    console.log(`${b.scenario_snapshot.id} / ${b.agent_config.id} / ${b.status} (${b.end_reason})`);
    for (const e of b.trace) console.log(`${String(e.seq).padStart(3)} cycle=${e.response_cycle} ${e.actor} ${e.type} ${JSON.stringify(e.payload)}${e.ground_truth ? ' [evaluator-only annotations]' : ''}`);
    console.log('Final state:', JSON.stringify(b.state_snapshots.find(s => s.phase === 'final')?.state, null, 2));
    return;
  }
  if (command !== 'run' && command !== 'list') throw new Error('Commands: run, list, replay');
  const flags: Record<string, string> = {};
  const allowed = new Set(['--agent', '--scenario', '--seed', '--out', '--max-turns', '--max-steps']);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid option: ${args[i]}`);
    flags[args[i]] = args[i + 1];
  }
  let scenarios = loadScenarios();
  if (command === 'list') {
    for (const s of scenarios) console.log(`${s.id}: ${s.title}`);
    return;
  }
  if (flags['--scenario']) scenarios = scenarios.filter(s => s.id === flags['--scenario']);
  if (!scenarios.length) throw new Error('No matching scenario');
  const agent = flags['--agent'] ?? 'both';
  if (!['both', ...Object.keys(CONFIGURATIONS)].includes(agent)) throw new Error('Agent must be baseline, candidate, or both');
  function numeric(flag: string, fallback: number) {
    const value = flags[flag] === undefined ? fallback : Number(flags[flag]);
    if (!Number.isSafeInteger(value) || value < (flag === '--seed' ? 0 : 1)) throw new Error(`Invalid number: ${flag}`);
    return value;
  }
  const seed = numeric('--seed', 17);
  if (seed > 0xffffffff) throw new Error('Seed must be an unsigned 32-bit integer');
  const maxTurns = numeric('--max-turns', 12), maxSteps = numeric('--max-steps', 100);
  const output = resolve(flags['--out'] ?? join(PROJECT_ROOT, 'artifacts', 'runs', `local-${randomUUID()}`));
  // A run directory is append-only: explicitly refuse an existing output target.
  mkdirSync(resolve(output, '..'), { recursive: true });
  mkdirSync(output);
  const batchId = randomUUID();
  const entries = [];
  for (const s of scenarios) for (const configuration of agent === 'both' ? ['baseline', 'candidate'] as const : [agent as 'baseline' | 'candidate']) {
    const filename = `${configuration}-${s.id}.json`;
    const runId = `${batchId}:${configuration}-${s.id}`;
    const b = runScenario(s, loadPolicy(s), { configuration, seed, runId, maxResponseCycles: maxTurns, maxSteps });
    validateReplay(b);
    writeFileSync(join(output, filename), JSON.stringify(b, null, 2) + '\n', { flag: 'wx' });
    entries.push({ run_id: runId, file: filename, scenario_id: s.id, agent: configuration, status: b.status, end_reason: b.end_reason, events: b.trace.length });
    console.log(`${configuration}-${s.id}: ${b.status}, ${b.trace.length} events`);
  }
  writeFileSync(join(output, 'index.json'), JSON.stringify({ schema_version: '1.0.0', batch_id: batchId, seed, entries }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Saved artifacts to ${output}`);
  if (entries.some(e => e.status !== 'completed')) process.exitCode = 2;
}
try { main(); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
