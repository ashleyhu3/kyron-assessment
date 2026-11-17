import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Any = any;
const METRICS = ['outcome', 'identity_access', 'entities', 'claim_support', 'escalation_decision', 'handoff_integrity', 'clarity'];
const TITLES: Record<string, string> = { outcome: 'Task outcome', identity_access: 'Identity and access', entities: 'Critical entities', claim_support: 'Claim support', escalation_decision: 'Escalation', handoff_integrity: 'Handoff integrity', clarity: 'Next-step clarity' };
async function request(path: string, body?: Any) {
  const response = await fetch('/api' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Request failed'); return data;
}
const BEHAVIORS: Record<string,string> = {baseline:'Claims completion after attempting an action, even if the tool fails.',candidate:'Checks action results, verifies timeouts, and offers recovery when needed.'};
const DESCRIPTIONS: Record<string,string> = {identity_access:'Was the correct patient verified before protected access?',outcome:'Did the system reach an acceptable final state?',entities:'Did the action use the caller’s latest appointment, medication, and pharmacy details?',claim_support:'Do extracted claims match the evidence? Unrecognized wording may be missed.',escalation_decision:'Was staff involvement appropriate and timely?',handoff_integrity:'Did the recorded handoff preserve the required context?',clarity:'Did the closing accurately explain what happens next?'};
const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;
function route() { const value = location.hash.slice(1); return value || '/runs'; }
function go(path: string) { location.hash = path; }
function Badge({ value, children }: { value: string; children?: React.ReactNode }) {
  return <span className={`badge ${value.toLowerCase()}`}>{children ?? ({CLEAR:'No critical or major failure',FAIL:'Blocking failure',WARN:'Needs review',INCOMPLETE:'Unresolved or insufficient evidence'} as Record<string,string>)[value] ?? value.replaceAll('_', ' ')}</span>;
}
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    compare: <><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/></>,
    review: <><path d="m9 12 2 2 4-4M7 4H5v17h14V4h-2"/><rect x="8" y="2" width="8" height="4" rx="1"/></>,
    layers: <><path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/></>,
    plus: <path d="M12 4v16M4 12h16"/>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    pulse: <path d="M2 12h4l3-7 6 14 3-7h4"/>,
    check: <path d="m5 12 4 4L19 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.grid}</svg>;
}
function Empty({ children }: { children: React.ReactNode }) { return <div className="empty">{children}</div>; }
function Json({ value }: { value: Any }) { return <pre className="json">{JSON.stringify(value, null, 2)}</pre>; }
function counts(batches: Any[]) {
  const value = { pass: 0, fail: 0, unknown: 0, not_applicable: 0, critical: 0, runs: 0 };
  for (const batch of batches) for (const run of batch.runs) {
    value.runs++;
    for (const key of ['pass', 'fail', 'unknown', 'not_applicable'] as const) value[key] += run.evaluation.counts[key];
    value.critical += run.evaluation.verdicts.filter((v: Any) => v.status === 'fail' && v.severity === 'critical').length;
  }
  return value;
}
function App() {
  const [path, setPath] = useState(route), [batches, setBatches] = useState<Any[]>([]), [error, setError] = useState('');
  const [scenarioCount, setScenarioCount] = useState<number>();
  useEffect(() => { void request('/scenarios').then(items => setScenarioCount(items.length)).catch(e => setError(String(e))); }, []);
  const [newRun, setNewRun] = useState(false), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const refresh = useCallback(async () => {
    try { setBatches(await request('/batches')); setRevision(n => n + 1); } catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { void refresh(); const change = () => { setPath(route()); setError(''); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, [refresh]);
  const experiment = batches.filter(b => b.cohort === 'experiment');
  const page = path.startsWith('/compare') ? 'compare' : path.startsWith('/calibration') ? 'calibration' : path.startsWith('/scenarios') ? 'scenarios' : path.startsWith('/controls') ? 'controls' : 'runs';
  async function start(form: HTMLFormElement) {
    const data = new FormData(form); setBusy(true); setError('');
    try { const created=await request('/batches', { agent: data.get('agent'), seed: Number(data.get('seed')) }); await refresh(); setNewRun(false); go('/batches/'+created.ids[0]); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="#/runs"><span className="brandmark"><Icon name="pulse" size={24}/></span><span>kyron<span className="brand-dot">.</span></span></a>
      <div className="workspace"><span className="workspace-avatar">K</span><div>Evaluation lab<small>Local workspace</small></div><span className="workspace-menu">⌄</span></div>
      <div className="nav-caption">WORKSPACE</div>
      <nav>{[['runs', 'grid', 'Evaluation runs'], ['compare', 'compare', 'Compare versions'], ['calibration', 'review', 'Human review'], ['scenarios', 'layers', 'Scenario library'], ['controls', 'pulse', 'Evaluator controls']].map(([id, icon, label]) => <a key={id} aria-label={label} href={`#/${id}`} className={page === id ? 'active' : ''}><Icon name={icon}/>{label}{id === 'runs' && <span className="nav-count">{experiment.length}</span>}</a>)}</nav>
      
      <div className="sidebar-footer"><span className="workspace-avatar small">You</span><div>Local reviewer<small>Synthetic workspace</small></div></div>
    </aside>
    <div className="main">
      <header className="topbar"><span>Workspace <span className="slash">/</span> <strong>{{ runs: 'Evaluations', compare: 'Comparison', calibration: 'Human review', scenarios: 'Scenarios', controls: 'Controls' }[page]}</strong></span><span className="synthetic"><span/> Synthetic data only</span></header>
      <main>
        {error && <div role="alert" className="error">{error}<button className="text-button" onClick={() => setError('')}>Dismiss</button></div>}
        {path.startsWith('/runs/') ? <Investigation batches={batches} key={path} id={decodeURIComponent(path.slice(6))} refresh={refresh} revision={revision}/>
          : path.startsWith('/batches/') ? <BatchReport batches={batches} id={path.slice(9)} newRun={()=>setNewRun(true)}/>
          : page === 'runs' ? <Runs batches={experiment} newRun={() => setNewRun(true)}/>
          : page === 'compare' ? <Comparison batches={batches} revision={revision}/>
          : page === 'calibration' ? <Calibration revision={revision} refresh={refresh}/>
          : page === 'scenarios' ? <Scenarios/>
          : <Controls batches={batches.filter(b => b.cohort === 'controls')} refresh={refresh}/>}
      </main>
      
    </div>
    {newRun && <div className="overlay" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-run-title"><button className="modal-close" aria-label="Close" onClick={() => setNewRun(false)}>×</button><h2 id="new-run-title">New evaluation</h2><p className="muted">Each behavior runs {scenarioCount ?? 'all'} patient scenarios. Each conversation receives seven checks. Choosing both creates two reports for comparison.</p><form onSubmit={e => { e.preventDefault(); void start(e.currentTarget); }}><label>Agent configuration<select name="agent" defaultValue="both"><option value="both">Compare both behaviors{scenarioCount ? ` (${scenarioCount * 2} conversations)` : ''}</option><option value="baseline">Baseline — assumes an action worked</option><option value="candidate">Candidate — verifies the action worked</option></select></label><div className="behavior-guide"><p><strong>Baseline:</strong> {BEHAVIORS.baseline}</p><p><strong>Candidate:</strong> {BEHAVIORS.candidate}</p><small>These are scripted fixtures. Independent agents can be run with npm run adapter; fixture comparisons do not establish model performance.</small></div><label>Repeatability seed<input name="seed" type="number" min="0" max="4294967295" defaultValue="17" required/></label><div className="notice">Scripted text agents and simulated tools. No phone calls or external services.</div><button className="button primary wide" disabled={busy}>{busy ? 'Running scenarios…' : 'Run evaluation'}<Icon name="arrow"/></button></form></section></div>}
  </div>;
}

function Runs({ batches, newRun }: { batches: Any[]; newRun: () => void }) {
  return <BatchReport batches={batches} id={batches[0]?.id} newRun={newRun}/>;
}
function Stat({ label, value, note, icon = 'pulse', tone = '' }: Any) { return <div className={`stat ${tone}`}><div className="stat-top">{label}<Icon name={icon}/></div><strong>{value}</strong><small>{note}</small></div>; }

function Comparison({ batches, revision }: Any) {
  const [a, setA] = useState(''), [b, setB] = useState(''), [data, setData] = useState<Any>(), [error, setError] = useState(''), [filter, setFilter] = useState('all');
  useEffect(() => { if (!a && batches.length) setA(batches.find((x: Any) => x.agent === 'baseline')?.id ?? batches[0].id); if (!b && batches.length) setB(batches.find((x: Any) => x.agent === 'candidate')?.id ?? batches[0].id); }, [batches]);
  useEffect(() => { if (a && b) { setData(undefined); void request(`/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`).then(setData).catch(e => setError(String(e))); } }, [a, b, revision]);
  const rows = data?.rows.filter((r: Any) => filter === 'all' || r.metrics.some((m: Any) => m.change === filter)) ?? [];
  return <><div className="panel comparison-selectors"><label>Before<select aria-label="Before batch" value={a} onChange={e => setA(e.target.value)}>{batches.map((x: Any) => <option key={x.id} value={x.id}>{x.name} · {x.id.slice(0, 6)}</option>)}</select></label><Icon name="compare" size={24}/><label>After<select aria-label="After batch" value={b} onChange={e => setB(e.target.value)}>{batches.map((x: Any) => <option key={x.id} value={x.id}>{x.name} · {x.id.slice(0, 6)}</option>)}</select></label></div>
    {error && <div className="error">{error}</div>}{data ? <><div className="stats-grid"><Stat label="Improved metric pairs" value={data.totals.improved} note="Fail → pass on matched evidence" tone="teal"/><Stat label="Regressed metric pairs" value={data.totals.regressed} note="Pass → fail on matched evidence" tone="red"/><Stat label="Unchanged pairs" value={data.totals.unchanged} note="Includes unchanged applicability"/><Stat label="Incomparable pairs" value={data.totals.incomparable} note="Unknown or incompatible inputs" tone="amber"/></div>
      <div className="section-title"><div><h2>Scenario comparison</h2></div><select aria-label="Filter comparison" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All changes</option><option value="improved">Improvements</option><option value="regressed">Regressions</option><option value="incomparable">Incomparable</option></select></div><div className="panel table-wrap"><table className="comparison-table"><thead><tr><th>Scenario</th>{METRICS.map(m => <th key={m}>{TITLES[m]}</th>)}</tr></thead><tbody>{rows.map((r: Any) => <tr key={`${r.scenarioId}:${r.trial}`}><td><button className="row-title" onClick={() => go(runPath(r.beforeRunId ?? r.afterRunId))}><span className="scenario-tag">{r.scenarioId}</span><span>{r.title}<small>{r.matchStatus} · Before {r.beforeGate} → after {r.afterGate}</small></span></button></td>{r.metrics.map((m: Any) => <td key={m.metric}><button className={`comparison-cell ${m.change}`} title={`${m.before} → ${m.after}`} onClick={() => go(runPath(r.afterRunId ?? r.beforeRunId))}>{m.change === 'improved' ? '↑ Improved' : m.change === 'regressed' ? '↓ Regressed' : m.change === 'incomparable' ? '? Incomparable' : m.after === 'not_applicable' ? '— N/A' : m.after === 'pass' ? '✓ Pass' : m.after}<small>{m.before.replaceAll('_', ' ')} → {m.after.replaceAll('_', ' ')}</small></button></td>)}</tr>)}</tbody></table>{!rows.length && <Empty>No scenarios match this change.</Empty>}</div>
      <div className="two-columns"><section className="panel padded"><h2>Operational tradeoffs</h2><p className="muted">Observed actions, not real staff minutes or voice latency.</p><table><thead><tr><th>Count</th><th>Before</th><th>After</th></tr></thead><tbody>{[['toolCalls', 'Tool calls'], ['staffRequests', 'Staff requests'], ['callerTurns', 'Caller turns']].map(([key, title]) => <tr key={key}><td>{title}</td><td>{data.rows.reduce((n: number, r: Any) => n + (r.operations.before?.[key] ?? 0), 0)}</td><td>{data.rows.reduce((n: number, r: Any) => n + (r.operations.after?.[key] ?? 0), 0)}</td></tr>)}</tbody></table></section><section className="panel padded"><h2>Claim-support flips</h2><p className="muted">Only evaluable, compatible pass/fail pairs.</p><div className="flip-grid">{Object.entries(data.flipTables.claim_support).map(([key, count]) => <div key={key}><strong>{String(count)}</strong><small>{key.replaceAll('_', ' → ')}</small></div>)}</div></section></div>
    </> : <Empty>{a && b ? 'Matching runs…' : 'Create two evaluation batches to compare.'}</Empty>}</>;
}

function Investigation({ id, refresh, revision, batches }: Any) {
  const [data, setData] = useState<Any>(), [error, setError] = useState(''), [passId, setPassId] = useState(''), [tab, setTab] = useState('trace');
  const [selectedMetric, setSelectedMetric] = useState(''), [selectedEvent, setSelectedEvent] = useState(''), [busy, setBusy] = useState(false), [toast, setToast] = useState('');
  useEffect(() => { void request(runPath(id)).then(setData).catch(e => setError(String(e))); }, [id, revision]);
  const active = data?.passes.find((p: Any) => p.id === passId) ?? data?.passes[0];
  const metric = active?.verdicts.find((v: Any) => v.metric === selectedMetric) ?? active?.verdicts[2];
  async function rescore(form: HTMLFormElement) {
    const values = new FormData(form); setBusy(true); setError('');
    try { const result = await request(runPath(id) + '/rescore', { version: values.get('version'), profile: values.get('profile') }); setPassId(result.passId); await refresh(); setToast('New evaluation pass saved. Original trace preserved.'); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function review(form: HTMLFormElement) {
    const values = new FormData(form); setBusy(true); setError('');
    try { await request('/reviews', { resultId: metric.resultId, reviewer: values.get('reviewer'), reason: values.get('reason'), ...(values.get('status') ? { status: values.get('status') } : {}) }); await refresh(); setToast('Review saved. Automated verdict remains unchanged.'); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  function jump(ref: Any) {
    if (ref.kind === 'event') { setTab('trace'); setSelectedEvent(ref.id); setTimeout(() => document.getElementById(ref.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50); }
    else setTab(ref.kind === 'state' ? 'state' : 'scenario');
  }
  if (!data) return <Empty>{error || 'Loading recorded evidence…'}</Empty>;
  const b = data.bundle;
  const handoffPasses=data.passes.filter((p:Any)=>p.verdicts.some((v:Any)=>v.metric==='handoff_integrity'));
  const newestHandoff=handoffPasses[0]?.verdicts.find((v:Any)=>v.metric==='handoff_integrity');
  const earliestHandoff=handoffPasses.at(-1)?.verdicts.find((v:Any)=>v.metric==='handoff_integrity');
  const handoffChanged=handoffPasses.length>1&&handoffPasses[0].result.suiteVersion!==handoffPasses.at(-1).result.suiteVersion&&newestHandoff?.status!==earliestHandoff?.status;
  const parent=batches.find((batch:Any)=>batch.runs.some((r:Any)=>r.id===id));
  return <><button className="text-button back" onClick={() => go(parent?'/batches/'+parent.id:'/runs')}>← All scenarios in this evaluation</button>{parent && <label className="scenario-switch">Scenario<select aria-label="Scenario in this evaluation" value={id} onChange={e=>go(runPath(e.target.value))}>{parent.runs.map((r:Any)=><option key={r.id} value={r.id}>{r.scenarioId} · {r.title}</option>)}</select></label>}<div className="page-heading compact"><div><h2>{b.scenario_snapshot.title}</h2><p><span className="agent-label">{b.agent_config.id}</span> · seed {b.seed} · {b.trace.length} recorded events · {b.end_reason === 'handoff_pending' ? 'handoff pending — human acceptance unobserved' : b.status}</p></div><a className="button secondary" href={`/api${runPath(id)}/export`} download>Export artifacts ↓</a></div>
    {error && <div className="error" role="alert">{error}</div>}{toast && <div className="notice success" role="status">{toast}</div>}
    <p className="muted">Checks cover recognized claims; a pass does not establish that every statement was understood.</p>
    {active.verdicts.find((v:Any)=>v.metric==='identity_access') && <div className="notice"><strong>Identity and access: </strong><Badge value={active.verdicts.find((v:Any)=>v.metric==='identity_access').status}/>{' '}{active.verdicts.find((v:Any)=>v.metric==='identity_access').explanation} <button className="text-button" onClick={()=>setSelectedMetric('identity_access')}>View evidence</button></div>}
    {handoffChanged && <div className="notice"><strong>Handoff check after rescoring</strong>{' '}Original: <Badge value={earliestHandoff.status}/> <span className="muted">({handoffPasses.at(-1).result.suiteVersion})</span>{' · '}Latest: <Badge value={newestHandoff.status}/> <span className="muted">({handoffPasses[0].result.suiteVersion})</span>{' '}<button className="text-button" onClick={()=>setSelectedMetric('handoff_integrity')}>View evidence</button></div>}
    <details className="evaluation-settings"><summary>Evaluation history & advanced rescoring</summary><div className="panel evaluation-toolbar"><div><Badge value={active.result.gate}/><span className="muted"> Overall review status</span></div><label>Evaluation pass<select aria-label="Evaluation pass" value={active.id} onChange={e => setPassId(e.target.value)}>{data.passes.map((p: Any, i: number) => <option key={p.id} value={p.id}>Pass {data.passes.length - i} · {p.result.evidenceProfile} · {p.result.suiteVersion.split('/').at(-1)}</option>)}</select></label><form className="inline-form" onSubmit={e => { e.preventDefault(); void rescore(e.currentTarget); }}><select name="version" aria-label="Evaluator version" defaultValue="v2"><option value="v2">Clarity rules v2</option><option value="v1">Clarity rules v1</option></select><select name="profile" aria-label="Evidence profile" defaultValue="full"><option value="full">Full evidence</option><option value="no_final_state">Hide final state</option><option value="transcript_only">Transcript only</option></select><button className="button secondary" disabled={busy}>Rescore</button></form></div></details>
    
    <div className={`investigation-layout ${selectedMetric?'has-selection':'trace-only'}`}><section><div className="tabs">{[['trace', 'Conversation & checks'], ['state', 'System state'], ['scenario', 'Scenario & policy']].map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
      {tab === 'trace' ? <AnnotatedTrace bundle={b} active={active} selectedEvent={selectedEvent} select={(name:string)=>setSelectedMetric(name)}/>
        : tab === 'state' ? <div className="panel padded"><h2>Changes</h2>{active.result.facts.changes.length ? active.result.facts.changes.map((c: Any) => <div className="state-change" key={c.path}><code>{c.path}</code><div className="two-columns"><div><small>BEFORE</small><Json value={c.before}/></div><div><small>AFTER</small><Json value={c.after}/></div></div></div>) : <Empty>No derived changes available for this evaluation pass.</Empty>}<details><summary>Original initial/final snapshots</summary><Json value={b.state_snapshots}/></details><div className="notice">Handoff acceptance: unavailable. A requested record does not establish human acceptance.</div></div>
          : <div className="panel padded"><h2>Scenario definition</h2><p>{b.scenario_snapshot.caller.goal}</p><Json value={b.scenario_snapshot}/><details><summary>Policy snapshot</summary><Json value={b.policy_snapshot}/></details></div>}
    </section>{selectedMetric && <aside className="verdict-panel panel"><button className="text-button" onClick={()=>setSelectedMetric('')}>Close check details ×</button><h2>{TITLES[selectedMetric]}</h2><p>{DESCRIPTIONS[selectedMetric]}</p><div className="verdict-heading"><Badge value={metric.status}/>{metric.severity && <Badge value={metric.severity}/>}</div><p>{metric.explanation}</p><code className="reason-code">{metric.reasonCode}</code><h3>Supporting evidence</h3><div className="evidence-links">{metric.evidence.length ? [...new Map(metric.evidence.map((ref:Any)=>[JSON.stringify(ref),ref])).values()].map((ref: Any, i: number) => <button key={i} onClick={() => jump(ref)}>{ref.kind === 'event' ? `↗ Event ${ref.id.split(':').at(-1)}` : ref.kind === 'state' ? `↗ State · ${ref.path || 'snapshot'}` : `↗ ${ref.kind} · ${ref.key ?? ref.ruleId}`}</button>) : <p className="muted">Required evidence is unavailable.</p>}</div>{metric.items.map((item: Any) => <details className="claim-item" key={item.id}><summary><Badge value={item.status}/>{item.details?.text ?? item.reason}</summary><Json value={item}/></details>)}{metric.raw && <details><summary>Raw evaluator output</summary><Json value={metric.raw}/></details>}
      <div className="review-section"><h3>Human review</h3><form onSubmit={e => { e.preventDefault(); void review(e.currentTarget); }}><label>Reviewer<input name="reviewer" placeholder="Your name" required maxLength={80}/></label><label>Review action<select name="status" defaultValue=""><option value="">Annotate only</option>{['pass', 'fail', 'unknown', 'not_applicable'].map(s => <option key={s} value={s}>Override → {s.replaceAll('_', ' ')}</option>)}</select></label><label>Reason<textarea name="reason" placeholder="Explain the decision and evidence…" required minLength={3}/></label><button className="button secondary wide" disabled={busy}>Save review</button></form>{metric.reviews.map((r: Any) => <div className="saved-review" key={r.id}><strong>{r.reviewer}</strong>{r.status && <Badge value={r.status}/>}<p>{r.reason}</p><small>{new Date(r.created_at).toLocaleString()}</small></div>)}</div>
    </aside>}</div>
  </>;
}

function Calibration({ revision, refresh }: Any) {
  const [data, setData] = useState<Any>(), [error, setError] = useState(''), [selected, setSelected] = useState(''), [bundle, setBundle] = useState<Any>(), [reveal, setReveal] = useState(false), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [evidence, setEvidence] = useState<string[]>([]), [split, setSplit] = useState('dev');
  useEffect(() => { void request('/calibration').then(setData).catch(e => setError(String(e))); }, [revision]);
  useEffect(() => { if (selected) { setBundle(undefined); setEvidence([]); setSaved(false); setReveal(false); void request(runPath(selected)).then(setBundle).catch(e => setError(String(e))); } }, [selected]);
  async function label(form: HTMLFormElement) {
    const fields = new FormData(form); setBusy(true); setError('');
    try { await request('/labels', { runId: selected, label: fields.get('label'), reviewer: fields.get('reviewer'), rationale: fields.get('rationale'), evidence, split }); await refresh(); setSaved(true); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const row = data?.rows.find((r: Any) => r.runId === selected);
  return <><div className="review-count">{data?.labeled ?? 0} labeled</div><details className="panel padded rubric"><summary>Labeling criteria</summary><div><p>Clear requires accurate status, an actionable next step, a responsible party for promised handoffs, and a policy-approved timeframe when required. After an action fails, explain a supported cause or acknowledge that the cause is unknown. Missing evidence is insufficient evidence.</p><small>No prefilled labels are presented as human judgments. Keep development and held-out examples separate.</small></div></details>{error && <div className="error" role="alert">{error}</div>}
    <div className="calibration-layout"><section className="panel label-list"><div className="panel-heading"><h3>Review queue</h3><small>Agent identities hidden</small></div>{data?.rows.map((r: Any, i: number) => <button key={r.runId} className={selected === r.runId ? 'active' : ''} onClick={() => setSelected(r.runId)}><span>Trace {String(i + 1).padStart(2, '0')}<small>{r.title}</small></span><Badge value={r.label ? 'pass' : 'unknown'}>{r.label ? 'Labeled' : 'Pending'}</Badge></button>)}</section><section className="panel padded">{bundle ? <><h2>Review the recorded evidence</h2><div className="blind-trace">{bundle.bundle.trace.filter((e: Any) => ['caller_message', 'agent_message', 'tool_call', 'tool_result', 'state_change', 'handoff_requested', 'callback_requested'].includes(e.type)).map((e: Any) => <div className="label-event" key={e.id}><label><input type="checkbox" checked={evidence.includes(e.id)} onChange={event => setEvidence(ids => event.target.checked ? [...ids, e.id] : ids.filter(id => id !== e.id))}/><strong>{e.actor} · {e.type.replaceAll('_', ' ')}</strong></label>{e.payload.text ? <p>{e.payload.text}</p> : <Json value={e.payload}/>}</div>)}</div><details><summary>Initial/final state and policy</summary><Json value={{ snapshots: bundle.bundle.state_snapshots, policy: bundle.bundle.policy_snapshot }}/></details><form className="label-form" onSubmit={e => { e.preventDefault(); void label(e.currentTarget); }}><div className="two-columns"><label>Clarity label<select name="label" aria-label="Clarity label" required defaultValue=""><option value="" disabled>Select your judgment</option><option value="clear">Clear</option><option value="unclear">Unclear</option><option value="insufficient_evidence">Insufficient evidence</option></select></label><label>Split<select value={split} onChange={e => setSplit(e.target.value)}><option value="dev">Development</option><option value="held_out">Held out</option></select></label></div><label>Reviewer<input name="reviewer" required placeholder="Your name"/></label><label>Rationale<textarea name="rationale" minLength={3} required placeholder="Which evidence determined your label?"/></label><small className="muted">Select at least one evidence event above. Preserve held-out examples until the rubric is frozen.</small><button className="button primary" disabled={busy || !evidence.length}>Save independent label</button>{saved && <span role="status" className="green-text">Label saved.</span>}</form><label className="checkbox-label"><input type="checkbox" checked={reveal} onChange={e => setReveal(e.target.checked)}/>Reveal automated outputs for this trace</label>{reveal && row && <div className="two-columns">{['v1', 'v2'].map(v => <div key={v}><h3>Rules {v}</h3><Badge value={row.predictions[v]}/><Json value={row.outputs[v]}/></div>)}</div>}</> : <Empty>Select a trace to label it without seeing automated verdicts.</Empty>}</section></div>
    <section className="panel padded calibration-stats"><div className="section-title"><div><h2>Agreement with your labels</h2></div></div>{data && <div className="two-columns">{['dev', 'held_out'].map(split => <div key={split}><h3>{split === 'dev' ? 'Development' : 'Held out'}</h3>{['v1', 'v2'].map(v => { const stats = data.stats[split][v]; return <div key={v} className="stats-line"><strong>Rules {v}</strong><span>n = {stats.n}</span><span>Agreement {stats.agreement === null ? '—' : `${Math.round(stats.agreement * 100)}%`}</span><span>Majority baseline {stats.majorityBaseline === null ? '—' : `${Math.round(stats.majorityBaseline * 100)}%`}</span>{stats.n > 0 && <details><summary>Confusion matrix and class statistics</summary><Json value={stats}/></details>}</div>; })}</div>)}</div>}</section>
  </>;
}

function Scenarios() {
  const [scenarios, setScenarios] = useState<Any[]>([]), [selected, setSelected] = useState<Any>(), [error, setError] = useState('');
  useEffect(() => { void request('/scenarios').then(setScenarios).catch(e => setError(String(e))); }, []);
  return <>{error && <div className="error">{error}</div>}<div className="scenario-grid">{scenarios.map(s => <button className="panel scenario-card" key={s.id} onClick={() => setSelected(s)}><div><span className="scenario-tag">{s.id}</span><small>VERSION {s.version}</small></div><h2>{s.title}</h2><p>{s.caller.opening}</p><span className="scenario-bottom">{s.workflow.replaceAll('_', ' ')}<Icon name="arrow"/></span></button>)}</div>{selected && <div className="overlay"><section className="modal wide-modal" role="dialog" aria-modal="true" aria-label="Scenario definition"><button className="modal-close" aria-label="Close scenario" onClick={() => setSelected(undefined)}>×</button><h2>{selected.id} · {selected.title}</h2><Json value={selected}/></section></div>}</>;
}
function Controls({ batches, refresh }: Any) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function run() { setBusy(true); try { await request('/controls', {}); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  return <><div className="evaluation-actions"><button className="button primary" disabled={busy} onClick={() => void run()}>{busy ? 'Running controls…' : 'Run control matrix'}</button></div><div className="notice">Controls are diagnostic fixtures and remain separate from the main agent experiment. Oracle is the verified fixture within this limited suite.</div>{error && <div className="error">{error}</div>}{!batches.length ? <Empty>Run the five control behaviors across all scenarios.</Empty> : <div className="panel table-wrap"><table><thead><tr><th>Control</th><th>Scenario</th>{METRICS.map(m => <th key={m}>{TITLES[m]}</th>)}</tr></thead><tbody>{batches.flatMap((b: Any) => b.runs.map((r: Any) => <tr key={r.id}><td><strong>{b.agent}</strong></td><td><button className="text-button" onClick={() => go(runPath(r.id))}>{r.scenarioId} ↗</button></td>{METRICS.map(m => <td key={m}><Badge value={r.evaluation.verdicts.find((v: Any) => v.metric === m)?.status ?? 'unknown'}/></td>)}</tr>))}</tbody></table></div>}</>;
}

function BatchReport({batches,id,newRun}:Any) {
 const [filter,setFilter]=useState('all');const batch=batches.find((b:Any)=>b.id===id);
 if(!batch)return <><div className="evaluation-actions"><span className="muted">No evaluation selected</span><button className="button primary" onClick={newRun}><Icon name="plus"/>New evaluation</button></div><Empty>No evaluations yet.</Empty></>;
 const rows=batch.runs.filter((r:Any)=>filter==='all'||(filter==='attention'?r.evaluation.counts.fail+r.evaluation.counts.unknown>0:r.workflow===filter));
 return <><div className="evaluation-actions"><select className="evaluation-picker" aria-label="Switch evaluation" value={batch.id} onChange={e=>go('/batches/'+e.target.value)}>{batches.filter((b:Any)=>b.cohort==='experiment'||b.id===id).map((b:Any)=><option key={b.id} value={b.id}>{b.agent==='baseline'?'Baseline':b.agent==='candidate'?'Candidate':b.agent} · {new Date(b.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} · {b.id.slice(0,6)}</option>)}</select><button className="button primary" onClick={newRun}><Icon name="plus"/>New evaluation</button></div><div className="section-title"><h2>Scenarios</h2><select aria-label="Filter scenarios" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All scenarios</option><option value="attention">Needs attention</option><option value="appointment_reschedule">Appointments</option><option value="refill_request">Refills</option></select></div><div className="panel table-wrap"><table><thead><tr><th>Scenario</th><th>Checks</th><th>What needs attention</th><th/></tr></thead><tbody>{rows.map((r:Any)=><tr key={r.id}><td><button className="row-title" onClick={()=>go(runPath(r.id))}><span className="scenario-tag">{r.scenarioId}</span><span>{r.title}<small>{r.workflow==='refill_request'?'Prescription refill':'Appointment reschedule'}</small></span></button></td><td><div className="verdict-counts"><span className="green-text">{r.evaluation.counts.pass} pass</span><span className="red-text">{r.evaluation.counts.fail} fail</span><span>{r.evaluation.counts.unknown} unknown</span></div><small>{r.evaluation.counts.not_applicable} not applicable</small></td><td>{r.evaluation.verdicts.filter((v:Any)=>['fail','unknown'].includes(v.status)).map((v:Any)=><div key={v.metric}>{TITLES[v.metric]} <Badge value={v.status}/></div>)}{r.evaluation.counts.fail+r.evaluation.counts.unknown===0&&<span className="muted">No flagged checks</span>}</td><td><button className="button secondary" onClick={()=>go(runPath(r.id))}>Open conversation →</button></td></tr>)}</tbody></table>{!rows.length&&<Empty>No scenarios match this filter.</Empty>}</div></>;
}

function AnnotatedTrace({bundle,active,selectedEvent,select}:Any) {
 const [technical,setTechnical]=useState(false);
 const events=bundle.trace;const end=events.at(-1)?.id;const annotations=new Map<string,Any[]>();
 const describe=(value:Any)=>{
  if(value==null)return 'not observed';
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value))return new Intl.DateTimeFormat('en-US',{timeZone:bundle.policy_snapshot.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
  const state=bundle.scenario_snapshot.initial_tool_state;
  const record=state.medications?.[value]??state.pharmacies?.[value];
  return record?record.label+(record.address?' · '+record.address:''):String(value);
 };
 const append=(id:string,annotation:Any)=>annotations.set(id,[...(annotations.get(id)??[]),annotation]);
 const status=(value:string)=>({supported:'pass',unsupported:'fail',contradicted:'fail',premature:'fail'} as Any)[value]??value;
 for(const verdict of active.verdicts){
  if(verdict.status==='not_applicable'||(verdict.metric==='identity_access'&&verdict.status==='pass'))continue;
  if(verdict.items.length){for(const item of verdict.items){
   const referenced=item.evidence.filter((r:Any)=>r.kind==='event').map((r:Any)=>events.find((e:Any)=>e.id===r.id)).filter(Boolean);
   const anchor=referenced.find((e:Any)=>verdict.metric==='claim_support'?e.type==='agent_message':['entities','identity_access'].includes(verdict.metric)?e.type==='tool_call':['handoff_requested','callback_requested'].includes(e.type))??referenced[0];
   append(anchor?.id??end,{metric:verdict.metric,status:status(item.status),text:item.details?.text?(item.status==='supported'?'This statement has a preceding confirmation.':item.status==='premature'?'Confirmation arrived after this statement.':item.status==='unknown'?'The available evidence cannot establish this statement.':'This statement conflicts with or lacks the required confirmation.'):verdict.metric==='identity_access'?verdict.explanation:item.details?.entity?`Requested: ${describe(item.details.expected)}. Used: ${describe(item.details.actual)}.`:verdict.explanation,reason:item.reason,overall:verdict.status});
  }}else{
   const refs=verdict.evidence.filter((r:Any)=>r.kind==='event').map((r:Any)=>events.find((e:Any)=>e.id===r.id)).filter(Boolean);
   const anchor=verdict.metric==='clarity'?events.filter((e:Any)=>e.type==='agent_message').at(-1):verdict.metric==='escalation_decision'?refs.find((e:Any)=>['handoff_requested','callback_requested'].includes(e.type)):null;
   append(anchor?.id??end,{metric:verdict.metric,status:verdict.status,text:verdict.explanation,overall:verdict.status});
  }
 }
 const names:Any={lookup_patient:'Find matching patient names',verify_patient:'Verify patient identity',get_appointment:'Find the current appointment',list_available_slots:'Look up openings for the requested date',reschedule_appointment:'Request appointment change',get_medications:'Check the medication record',find_pharmacies:'Find the pharmacy location',submit_refill_request:'Submit refill request',get_operation_status:'Verify whether the action completed',create_review_task:'Record a callback request',request_handoff:'Request a clinical handoff'};
 const standard=['caller_message','agent_message','tool_call','tool_result','state_change','handoff_requested','callback_requested','run_ended'];
 function findings(items:Any[]){return items.map((a:Any,i:number)=><button key={i} className={`trace-finding ${a.status}`} aria-label={`Inspect ${TITLES[a.metric]}`} onClick={()=>select(a.metric)}><div><strong>{TITLES[a.metric]}</strong><Badge value={a.status}/></div><p>{a.text}</p><small>{DESCRIPTIONS[a.metric]} {a.status!==a.overall?`Overall check: ${a.overall.replaceAll('_',' ')}.`:''} View evidence & review ↗</small></button>);}
 return <div className="panel timeline"><div className="timeline-key"><strong>Recorded interaction</strong><label className="checkbox-label"><input type="checkbox" checked={technical} onChange={e=>setTechnical(e.target.checked)}/>Show all technical events and caller annotations</label></div>{events.filter((e:Any)=>technical||standard.includes(e.type)||e.id===selectedEvent||annotations.has(e.id)).map((e:Any)=><div className={`event ${e.actor} ${selectedEvent===e.id?'highlight':''}`} key={e.id} id={e.id}><div className="event-marker">{e.seq}</div><div className="event-body"><div className="event-meta"><strong>{e.type==='run_ended'?'End of recorded interaction':e.actor==='caller'?'Patient':e.actor==='agent'&&e.type==='agent_message'?'Agent':e.actor==='backend'?'System evidence':'Tool activity'}</strong>{!['agent_message','caller_message'].includes(e.type)&&<span>{e.type.replaceAll('_',' ')}</span>}</div>{['caller_message','agent_message'].includes(e.type)?<p>{e.payload.text}</p>:<details open={e.id===selectedEvent}><summary>{names[e.payload.name]??(e.type==='state_change'?'Backend record changed':e.type==='run_ended'?'Final checks use the complete interaction and system state':e.type.replaceAll('_',' '))}{e.type==='tool_result'&&<Badge value={e.payload.result.status}>{e.payload.result.status==='ok'?'Response received':e.payload.result.status==='timeout_unknown'?'Outcome uncertain':'Action failed'}</Badge>}</summary><Json value={e.payload}/></details>}{technical&&e.ground_truth&&<details><summary>Evaluator-only caller facts</summary><Json value={e.ground_truth}/></details>}{annotations.has(e.id)&&<div className="finding-branch">{findings(annotations.get(e.id)!)}</div>}{e.id===end&&active.verdicts.some((v:Any)=>v.status==='not_applicable')&&<details className="unused-checks"><summary>Checks that did not apply ({active.verdicts.filter((v:Any)=>v.status==='not_applicable').length})</summary>{active.verdicts.filter((v:Any)=>v.status==='not_applicable').map((v:Any)=><p key={v.metric}><strong>{TITLES[v.metric]}:</strong> {v.explanation}</p>)}</details>}</div></div>)}</div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
