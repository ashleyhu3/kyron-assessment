import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { Store } from './store.ts';
import { loadScenarios, loadPolicy, PROJECT_ROOT, validateReplay } from '../harness/artifacts.ts';
import { runScenario } from '../harness/runner.ts';

// Explicitly selected local executable code. No provider calls or credentials
// are supplied by the platform. The factory receives config/policy only.
const file=process.argv[2];
if(!file)throw new Error('Usage: npm run adapter -- /absolute/path/adapter.ts');
const adapter=await import(pathToFileURL(resolve(file)).href);
if(typeof adapter.createAgent!=='function'||typeof adapter.id!=='string'||typeof adapter.version!=='string')throw new Error('Adapter must export id, version and createAgent(config, policy)');
if(['baseline','candidate'].includes(adapter.id))throw new Error('Use an independent adapter ID');
const bundles=loadScenarios().map(s=>runScenario(s,loadPolicy(s),{
  agentConfig:{id:adapter.id,version:adapter.version}, agentFactory:adapter.createAgent,
}));
bundles.forEach(validateReplay);
const store=new Store(process.env.KYRON_DB??join(PROJECT_ROOT,'data/kyron.sqlite'));
try{console.log(JSON.stringify({batch:store.addBatch(`${adapter.id} · adapter ${adapter.version}`,adapter.id,bundles),runs:bundles.length,incomplete:bundles.filter(b=>b.status!=='completed').length}));}finally{store.close();}
