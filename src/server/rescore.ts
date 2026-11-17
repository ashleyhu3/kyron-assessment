import { Store } from './store.ts';
import { evaluate, suiteVersion } from '../eval/pipeline.ts';
const store=new Store(process.env.KYRON_DB??'data/kyron.sqlite');
let added=0;
try {store.transaction(()=>{for(const batch of store.batches())for(const run of batch.runs){
 if(run.evaluation.suiteVersion!==suiteVersion('v2')){store.addPass(run.id,evaluate(store.bundle(run.id)!));added++;}
}});console.log(JSON.stringify({appendedPasses:added,suiteVersion:suiteVersion('v2'),originalsPreserved:true}));}finally{store.close();}
