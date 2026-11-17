import { readFileSync, writeFileSync } from 'node:fs';
import { evaluate } from './pipeline.ts';
const [file, output] = process.argv.slice(2);
if (!file) { console.error('Usage: npm run evaluate -- <bundle.json> [new-output.json]'); process.exit(1); }
const result = evaluate(JSON.parse(readFileSync(file, 'utf8')));
if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
