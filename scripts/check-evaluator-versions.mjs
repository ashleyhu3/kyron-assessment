import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
const manifest=JSON.parse(readFileSync('src/eval/version-manifest.json','utf8'));
const files=['src/eval','src/contracts'].flatMap(dir=>readdirSync(dir).filter(f=>f.endsWith('.ts')).map(f=>`${dir}/${f}`)).sort();
const digest=createHash('sha256');for(const file of files)digest.update(file).update(readFileSync(file));
if(digest.digest('hex')!==manifest.codeHash)throw new Error('Evaluator/contract code differs from its version baseline. Review changes, bump the affected versions, and record a new baseline explicitly.');
if(!readFileSync('src/eval/pipeline.ts','utf8').includes(`evaluation@${manifest.suiteVersion}`))throw new Error('Suite version differs from recorded baseline');
console.log(`Evaluator/contract baseline verified: ${manifest.suiteVersion}`);
