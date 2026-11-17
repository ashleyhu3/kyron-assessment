import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scenarioCount = ['scheduling','refills'].reduce((n,folder)=>n+readdirSync(`scenarios/${folder}`).filter(f=>f.endsWith('.json')).length,0);
const dir = mkdtempSync(join(tmpdir(), 'kyron-browser-'));
const base = 'http://127.0.0.1:4174';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', 'src/server/main.ts'], {
  env: { ...process.env, PORT: '4174', KYRON_DB: join(dir, 'test.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
let log = ''; server.stdout.on('data', chunk => { log += chunk; }); server.stderr.on('data', chunk => { log += chunk; });
const checks = [];
const record = text => { checks.push(text); console.log("PASS:", text); };
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
    if (server.exitCode !== null) throw new Error('Server stopped: ' + log);
    if (i === 99) throw new Error('Server not ready: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Scenarios',exact:true }).waitFor();
  await page.locator('tbody tr').nth(scenarioCount-1).waitFor();
  assert.equal(await page.locator('tbody tr').count(),scenarioCount);
  const switcher=page.getByRole('combobox',{name:'Switch evaluation'});
  assert.equal(await switcher.locator('option').count(),2);
  const latest=(await (await page.request.get(base+'/api/batches')).json())[0];
  assert.equal(await switcher.inputValue(),latest.id);
  assert.equal(await page.locator('.stats-grid').count(),0);
  assert.equal(await page.getByText('MEASURE WHAT MATTERS',{exact:true}).count(),0);
  await switcher.selectOption({index:1});
  assert.notEqual(await switcher.inputValue(),latest.id);
  record('latest evaluation table and history switcher without summary cards');
  await page.getByRole('button', { name: 'New evaluation', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run evaluation', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('heading',{name:'Scenarios',exact:true}).waitFor();
  assert.equal(await page.locator('tbody tr').count(),scenarioCount);
  await page.getByRole('button',{name:'Open conversation →'}).first().click();
  await page.getByRole('combobox',{name:'Scenario in this evaluation'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Scenario in this evaluation'}).locator('option').count(),scenarioCount);
  await page.getByRole('link',{name:'Evaluation runs',exact:true}).click();
  await page.locator('tbody tr').nth(scenarioCount-1).waitFor();
  assert.equal(await page.locator('tbody tr').count(),scenarioCount);
  assert.equal(await page.getByRole('combobox',{name:'Switch evaluation'}).locator('option').count(),4); record('run report exposes all scenarios and conversation navigation');
  await page.getByRole('link', { name: 'Compare versions' }).click();
  await page.getByRole('heading', { name: 'Scenario comparison' }).waitFor();
  const row = page.locator('tbody tr').filter({ hasText: 'Commit followed by timeout' });
  await row.getByRole('button', { name: /Improved/ }).first().click();
  await page.getByRole('heading', { name: 'Commit followed by timeout', exact: true }).waitFor();
  const originalRun = decodeURIComponent(new URL(page.url()).hash.slice('#/runs/'.length));
  const original = await (await page.request.get(`${base}/api/runs/${encodeURIComponent(originalRun)}`)).json();
  await page.getByRole('button',{name:'Inspect Claim support',exact:true}).first().click();
  await page.getByRole('button', { name: '↗ Event', exact: false }).first().click();
  assert.equal(await page.locator('.event.highlight').count(), 1); record('comparison to trace with evidence highlighting');
  await page.getByLabel('Reviewer', { exact: true }).fill('Automated browser test');
  await page.getByLabel('Review action').selectOption('unknown');
  await page.getByLabel('Reason', { exact: true }).fill('Test-only override to verify immutable history.');
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Review saved' }).waitFor();
  const reviewed = await (await page.request.get(`${base}/api/runs/${encodeURIComponent(originalRun)}`)).json();
  assert.equal(reviewed.passes[0].verdicts.find(v => v.metric === 'claim_support').effectiveStatus, 'unknown');
  assert.equal(reviewed.passes[0].verdicts.find(v => v.metric === 'claim_support').status, 'pass');
  record('review override preserves automated verdict');
  await page.getByText('Evaluation history & advanced rescoring',{exact:true}).click();
  await page.getByRole('combobox', { name: 'Evidence profile' }).selectOption('transcript_only');
  await page.getByRole('button', { name: 'Rescore', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'New evaluation pass' }).waitFor();
  const rescored = await (await page.request.get(`${base}/api/runs/${encodeURIComponent(originalRun)}`)).json();
  assert.equal(rescored.passes.length, 2);
  assert.deepEqual(rescored.bundle, original.bundle);
  assert.equal(rescored.passes[0].result.gate, 'INCOMPLETE'); record('masked rescoring preserves artifacts and prior pass');
  await page.getByRole('link', { name: 'Human review', exact: true }).click();
  await page.locator('.label-list>button').first().click();
  await page.getByRole('heading', { name: 'Review the recorded evidence' }).waitFor();
  assert.equal(await page.getByText('Raw evaluator output', { exact: true }).count(), 0);
  await page.locator('.label-event input[type=checkbox]').last().check();
  await page.getByLabel('Clarity label', { exact: true }).selectOption('clear');
  await page.getByLabel('Reviewer', { exact: true }).fill('Automated browser test');
  await page.getByLabel('Rationale', { exact: true }).fill('Test-only label for workflow verification, not a human reference judgment.');
  await page.getByRole('button', { name: 'Save independent label', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Label saved' }).waitFor();
  const calibration = await (await page.request.get(`${base}/api/calibration`)).json();
  assert.equal(calibration.labeled, 1); record('blind labeling and calibration persistence');
  await page.getByRole('link', { name: 'Evaluator controls', exact: true }).click();
  await page.getByRole('button', { name: 'Run control matrix', exact: true }).click();
  await page.locator('tbody tr').first().waitFor(); assert.equal(await page.locator('tbody tr').count(), scenarioCount*5); record('control matrix runs all scenario interactions');
  await page.getByRole('link', { name: 'Scenario library', exact: true }).click();
  await page.locator('.scenario-card').first().waitFor();
  assert.equal(await page.locator('.scenario-card').count(), scenarioCount);
  await page.locator('.scenario-card').first().click(); await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Close scenario', exact: true }).click(); record('scenario library and definition');
  const freshBatches=await (await page.request.get(base+'/api/batches')).json();
  const candidate=freshBatches.find(b=>b.agent==='candidate'&&b.cohort==='experiment');
  const refill=candidate.runs.find(r=>r.scenarioId==='R1');
  await page.goto(base+'/#/runs/'+encodeURIComponent(refill.id));
  await page.getByRole('heading',{name:'Ordinary refill request',exact:true}).waitFor();
  assert.ok((await page.locator('.event p').allTextContents()).some(text=>text.includes('Maple Pharmacy')));
  assert.ok((await page.locator('.event p').allTextContents()).every(text=>!/(?:med|pharmacy)_\d+/.test(text)));
  record('refill trace uses medication/pharmacy names rather than internal identifiers');
  for (const [id, title, expected] of [
    ['A6','Relative weekday with date confirmation','Do you mean Thursday, December 3, 2026?'],
    ['R6','Uncertain medication resolved against existing history','I found my medication list. It says Examplemed 10 mg tablets.'],
    ['R7','Existing medication history remains ambiguous','Would you like me to ask the refill team to review this and call you?'],
  ]) {
    await page.goto(base+'/#/runs/'+encodeURIComponent(candidate.runs.find(r=>r.scenarioId===id).id));
    await page.getByRole('heading',{name:title,exact:true}).waitFor();
    assert.ok((await page.locator('.event p').allTextContents()).includes(expected));
  }
  record('uncertainty traces show date confirmation, history clarification, and unresolved-medication callback');
  for (const [id,title,expected] of [
    ['U1','Clarify which of two requests to handle now','Which request would you like to handle now?'],
    ['U2','Uncertain confirmation before scheduling','I have not changed your appointment.'],
    ['U3','Affirmation with an appointment correction','Yes, but actually'],
  ]) {
    await page.goto(base+'/#/runs/'+encodeURIComponent(candidate.runs.find(r=>r.scenarioId===id).id));
    await page.getByRole('heading',{name:title,exact:true}).waitFor();
    assert.ok((await page.locator('.event p').allTextContents()).some(text=>text.includes(expected)));
  }
  record('unfamiliar conversation scenarios show clarification and correction');
  const urgent=candidate.runs.find(r=>r.scenarioId==='R5');
  await page.goto(base+'/#/runs/'+encodeURIComponent(urgent.id));
  await page.getByText('handoff pending — human acceptance unobserved',{exact:false}).waitFor();
  record('clinical handoff is visibly pending rather than presented as accepted');
  await page.goto(base+'/#/runs/'+encodeURIComponent(candidate.runs.find(r=>r.scenarioId==='I3').id));
  await page.getByRole('heading',{name:'Failed identity verification blocks access',exact:true}).waitFor();
  assert.ok((await page.locator('.event p').allTextContents()).some(text=>text.includes('could not uniquely verify')));
  assert.ok(await page.getByText('Identity and access:',{exact:true}).count());
  await page.getByText('Evaluation history & advanced rescoring',{exact:true}).click();
  assert.ok(await page.getByText('Unresolved or insufficient evidence',{exact:true}).count());
  assert.ok(await page.getByText('The original appointment is unchanged, but the requested change remains unresolved because identity was not verified.',{exact:false}).count());
  await page.getByRole('button',{name:'View evidence',exact:true}).click();
  await page.getByRole('heading',{name:'Identity and access',exact:true}).waitFor();
  assert.ok(await page.getByText('No protected access was attempted; the unresolved identity was handled through the available next step.',{exact:false}).count());
  record('failed identity verification includes a separate identity verdict and evidence');
  const demo=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types','src/server/refill-handoff-demo.ts','--no-artifacts'],{encoding:'utf8',env:{...process.env,KYRON_DB:join(dir,'test.sqlite')}});
  assert.equal(demo.status,0,demo.stderr);
  await page.goto(base+'/#/runs/'+encodeURIComponent('workflow-inspection-R4-summary'));
  await page.getByRole('heading',{name:'Definite request failure',exact:true}).waitFor();
  const history=page.locator('.notice').filter({hasText:'Handoff check after rescoring'});
  assert.equal(await history.getByText('pass',{exact:true}).count(),1);
  assert.equal(await history.getByText('fail',{exact:true}).count(),1);
  await history.getByRole('button',{name:'View evidence'}).click();
  await page.getByRole('heading',{name:'Handoff integrity',exact:true}).waitFor();
  assert.ok(await page.getByText('The callback summary omits or mismatches the caller-confirmed medication or pharmacy.',{exact:false}).count());
  record('original and rescored handoff verdicts appear side by side with evidence');
  const single=await (await page.request.post(base+'/api/batches',{data:{agent:'candidate',scenarioId:'A1'}})).json();
  await page.getByRole('link',{name:'Compare versions'}).click();
  await page.reload();
  await page.getByRole('combobox',{name:'Before batch'}).locator(`option[value="${single.ids[0]}"]`).waitFor({state:'attached'});
  await page.getByRole('combobox',{name:'Before batch'}).selectOption(single.ids[0]);
  await page.getByRole('combobox',{name:'After batch'}).selectOption(candidate.id);
  await page.getByText(/after_only/).first().waitFor();
  assert.equal(await page.locator('tbody').first().locator('tr').count(),scenarioCount);
  await page.locator('tbody tr').filter({hasText:'after_only'}).first().getByRole('button').first().click();
  await page.getByRole('combobox',{name:'Scenario in this evaluation'}).waitFor();
  assert.ok(!page.url().includes('undefined'));
  record('after-only comparison rows remain visible and open their available trace');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Evaluation runs', exact: true }).click();
  await page.getByRole('heading', { name: 'Scenarios',exact:true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); record('mobile layout without page overflow');
  const target = process.env.KYRON_SCREENSHOTS;
  if (target) {
    mkdirSync(target, { recursive: true }); await page.screenshot({ path: join(target, 'mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: join(target, 'runs.png'), fullPage: true });
  }
  assert.deepEqual(errors, []); record('no browser runtime errors');
  console.log(JSON.stringify({ checks, passed: checks.length }, null, 2));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
}
