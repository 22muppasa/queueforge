'use client';

import {
  Activity, AlertTriangle, Boxes, Check, ChevronRight, CircleDot, Clock3,
  Database, Gauge, History, Menu, Play, Plus, RefreshCw, RotateCcw, Server,
  ShieldCheck, Skull, TerminalSquare, Workflow, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

type View = 'overview' | 'jobs' | 'workers' | 'retries' | 'dead';
type Mode = 'connecting' | 'live' | 'demo';
type JobState = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'dead_lettered' | 'cancelled';

type Job = {
  id: string; type: string; queue: string; status: JobState; attempts_started: number;
  max_attempts: number; created_at: string; updated_at: string; lease_owner_name?: string | null;
  result?: unknown; last_error?: { type?: string; message?: string } | null; attempts?: Attempt[]; events?: EventRecord[];
};
type Attempt = { attempt_no: number; worker_name?: string; outcome?: string | null; claimed_at: string; finished_at?: string | null; backoff_ms?: number | null };
type EventRecord = { id: string; type: string; occurred_at: string; attempt_no?: number; details?: Record<string, unknown> };
type WorkerRow = { id: string; name: string; queues: string[]; status: string; current_jobs: number; concurrency: number; heartbeat_age_ms: number; build_version: string };
type DeadLetter = { job_id: string; reason: string; final_attempt: number; dead_lettered_at: string; queue: string; type: string; error_snapshot?: { message?: string } };
type Summary = {
  serverTime: string;
  counts: { ready: number; scheduled: number; running: number; retry_wait: number; succeeded: number; dead_lettered: number; cancelled: number; oldest_ready_age_ms: number };
  rates: { completed_per_second: number; retries_5m: number; leases_expired_5m: number; dead_letters_5m: number };
  latency: { queue_wait_p50_ms: number; queue_wait_p95_ms: number; queue_wait_p99_ms: number; end_to_end_p50_ms: number; end_to_end_p95_ms: number; end_to_end_p99_ms: number };
  workers: { online: number; busy: number };
  timeline: { minute: string; completed: number; failed: number }[];
};

type ModelContext = { registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => void | Promise<void> };
declare global { interface Document { readonly modelContext?: ModelContext } }

const API_BASE = process.env.NEXT_PUBLIC_QUEUEFORGE_API ?? 'http://localhost:18080';
const now = Date.now();
const isoAgo = (seconds: number) => new Date(now - seconds * 1000).toISOString();

const demoJobs: Job[] = [
  { id: '8ab2f91c-2c50-4cb3-a7f2-81d7914ad02e', type: 'idempotent_counter', queue: 'default', status: 'running', attempts_started: 1, max_attempts: 5, created_at: isoAgo(2), updated_at: isoAgo(1), lease_owner_name: 'worker-a' },
  { id: '5d30c4a1-70c1-45f9-bbc9-b25f81397a12', type: 'flaky', queue: 'critical', status: 'retry_wait', attempts_started: 2, max_attempts: 5, created_at: isoAgo(9), updated_at: isoAgo(3) },
  { id: 'c114920e-687a-463e-8704-29ad4c7872d0', type: 'noop', queue: 'media', status: 'succeeded', attempts_started: 1, max_attempts: 3, created_at: isoAgo(14), updated_at: isoAgo(13), lease_owner_name: 'worker-c' },
  { id: 'f9021bc8-fc05-45e3-8ab5-106f32af35c4', type: 'noop', queue: 'default', status: 'queued', attempts_started: 0, max_attempts: 8, created_at: isoAgo(22), updated_at: isoAgo(22) },
];
const demoWorkers: WorkerRow[] = [
  { id: 'worker-a', name: 'worker-a', queues: ['default'], status: 'active', current_jobs: 1, concurrency: 4, heartbeat_age_ms: 700, build_version: 'demo' },
  { id: 'worker-b', name: 'worker-b', queues: ['critical'], status: 'active', current_jobs: 0, concurrency: 4, heartbeat_age_ms: 400, build_version: 'demo' },
  { id: 'worker-c', name: 'worker-c', queues: ['media'], status: 'active', current_jobs: 1, concurrency: 4, heartbeat_age_ms: 1100, build_version: 'demo' },
];
const demoDead: DeadLetter[] = [
  { job_id: 'aa5195c2-49e0-489d-b5fb-3f53dde1491b', reason: 'attempts_exhausted', final_attempt: 5, dead_lettered_at: isoAgo(184), queue: 'default', type: 'always_fail', error_snapshot: { message: 'Downstream connection refused' } },
  { job_id: 'b5808f99-62b3-4a9e-ac95-31c4f7bbd4c6', reason: 'non_retryable', final_attempt: 1, dead_lettered_at: isoAgo(614), queue: 'critical', type: 'always_fail', error_snapshot: { message: 'Payload rejected by handler' } },
];
const demoSummary: Summary = {
  serverTime: new Date().toISOString(),
  counts: { ready: 128, scheduled: 14, running: 24, retry_wait: 7, succeeded: 18240, dead_lettered: 2, cancelled: 11, oldest_ready_age_ms: 2300 },
  rates: { completed_per_second: 1842, retries_5m: 7, leases_expired_5m: 1, dead_letters_5m: 0 },
  latency: { queue_wait_p50_ms: 8, queue_wait_p95_ms: 42, queue_wait_p99_ms: 91, end_to_end_p50_ms: 24, end_to_end_p95_ms: 84, end_to_end_p99_ms: 143 },
  workers: { online: 3, busy: 2 },
  timeline: [720, 810, 760, 990, 920, 1120, 1080, 1270, 1190, 1390, 1340, 1510, 1460, 1730, 1842].map((completed, index) => ({ minute: new Date(now - (14 - index) * 60_000).toISOString(), completed, failed: index === 7 ? 3 : index === 11 ? 1 : 0 })),
};

const formatNumber = (value: unknown, digits = 0) => Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: digits });
const age = (date: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
};
const shortId = (id: string) => `qf_${id.replaceAll('-', '').slice(0, 8)}`;

function StateBadge({ state }: { state: JobState }) {
  const label = state === 'retry_wait' ? 'retrying' : state === 'dead_lettered' ? 'dead' : state;
  return <span className={`state state-${label}`}>{label}</span>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('X-Client-Id')) headers.set('X-Client-Id', 'dashboard');
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(3500) });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string'
      ? body.detail : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return body as T;
}

export default function QueueDashboard() {
  const [view, setView] = useState<View>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('connecting');
  const [summary, setSummary] = useState<Summary>(demoSummary);
  const [jobs, setJobs] = useState<Job[]>(demoJobs);
  const [workers, setWorkers] = useState<WorkerRow[]>(demoWorkers);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>(demoDead);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [crashOpen, setCrashOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [summaryResponse, jobsResponse, workersResponse, deadResponse] = await Promise.all([
        api<{ data: Summary }>('/v1/dashboard/summary'),
        api<{ data: Job[] }>('/v1/jobs?limit=50'),
        api<{ data: WorkerRow[] }>('/v1/workers'),
        api<{ data: DeadLetter[] }>('/v1/dead-letters?limit=50'),
      ]);
      setSummary(summaryResponse.data); setJobs(jobsResponse.data); setWorkers(workersResponse.data); setDeadLetters(deadResponse.data); setMode('live');
    } catch { setMode((current) => current === 'live' ? 'connecting' : 'demo'); }
  }, []);

  useEffect(() => { const initial = setTimeout(refresh, 0); const timer = setInterval(refresh, 2_000); return () => { clearTimeout(initial); clearInterval(timer); }; }, [refresh]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 3500); return () => clearTimeout(timer); }, [toast]);

  const submitJob = useCallback(async (input: { type: string; queue?: string; payload?: Record<string, unknown>; max_attempts?: number }) => {
    if (mode === 'live') {
      const response = await api<{ data: Job }>('/v1/jobs', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(input) });
      await refresh(); setToast(`Submitted ${shortId(response.data.id)}`); return response.data;
    }
    const created: Job = { id: crypto.randomUUID(), type: input.type, queue: input.queue ?? 'default', status: 'queued', attempts_started: 0, max_attempts: input.max_attempts ?? 5, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    setJobs((current) => [created, ...current]); setSummary((current) => ({ ...current, counts: { ...current.counts, ready: current.counts.ready + 1 } }));
    setToast(`Demo job ${shortId(created.id)} added`); return created;
  }, [mode, refresh]);

  const cancelJob = useCallback(async (job: Job) => {
    if (mode === 'live') await api(`/v1/jobs/${job.id}/cancel`, { method: 'POST' });
    else setJobs((items) => items.map((item) => item.id === job.id ? { ...item, status: 'cancelled' } : item));
    setSelectedJob(null); setToast(`${shortId(job.id)} cancellation ${job.status === 'running' ? 'requested' : 'completed'}`); await refresh();
  }, [mode, refresh]);

  const redrive = useCallback(async (letter: DeadLetter) => {
    if (mode === 'live') await api(`/v1/dead-letters/${letter.job_id}/redrive`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: '{}' });
    else {
      setDeadLetters((items) => items.filter((item) => item.job_id !== letter.job_id));
      await submitJob({ type: letter.type, queue: letter.queue, payload: {} });
    }
    setToast(`${shortId(letter.job_id)} redriven into a new job`); await refresh();
  }, [mode, refresh, submitJob]);

  const openJob = useCallback(async (job: Job) => {
    setSelectedJob(job);
    if (mode === 'live') {
      try { const response = await api<{ data: Job }>(`/v1/jobs/${job.id}`); setSelectedJob(response.data); } catch { /* retain list projection */ }
    }
  }, [mode]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool({
        name: 'submit_queueforge_job', title: 'Submit QueueForge job',
        description: 'Submit an allowlisted background job and update the visible queue.',
        inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['noop', 'flaky', 'always_fail', 'idempotent_counter'] }, queue: { type: 'string' }, payload: { type: 'object' }, max_attempts: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['type'], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input: unknown) => {
          const value = input as { type?: string; queue?: string; payload?: Record<string, unknown>; max_attempts?: number };
          if (!value?.type || !['noop', 'flaky', 'always_fail', 'idempotent_counter'].includes(value.type)) throw new Error('A supported job type is required');
          const job = await submitJob({ type: value.type, ...(value.queue ? { queue: value.queue } : {}), ...(value.payload ? { payload: value.payload } : {}), ...(value.max_attempts ? { max_attempts: value.max_attempts } : {}) });
          return { job_id: job.id, status: job.status, mode };
        },
      }, { signal: lifecycle.signal });
      await context.registerTool({
        name: 'read_queueforge_status', title: 'Read QueueForge status',
        description: 'Read the same queue and worker health summary visible on the dashboard.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: () => ({ mode, ready: Number(summary.counts.ready), running: Number(summary.counts.running), dead_lettered: Number(summary.counts.dead_lettered), workers_online: Number(summary.workers.online) }),
      }, { signal: lifecycle.signal });
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, [mode, submitJob, summary]);

  const visibleJobs = useMemo(() => view === 'retries' ? jobs.filter((job) => job.status === 'retry_wait') : jobs, [jobs, view]);
  const chartPoints = useMemo(() => {
    const values = summary.timeline.map((item) => Number(item.completed)); const max = Math.max(1, ...values);
    return values.map((value, index) => `${index * (360 / Math.max(1, values.length - 1))},${70 - (value / max) * 66}`).join(' ');
  }, [summary.timeline]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="topbar">
        <div className="brand-lockup"><button className="mobile-menu" aria-label="Toggle navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)}><Menu size={18}/></button><span className="brand-mark"><Workflow size={18}/></span><span className="brand-name">QueueForge</span><span className="edition">CONTROL PLANE</span></div>
        <div className="topbar-right"><span className={`connection mode-${mode}`}><i/> {mode === 'live' ? 'LIVE · 2s refresh' : mode === 'connecting' ? 'RECONNECTING' : 'DEMO TELEMETRY'}</span><a className="ghost-button" href={`${API_BASE}/`} target="_blank" rel="noreferrer"><TerminalSquare size={15}/> API</a><button className="primary-button" onClick={() => setSubmitOpen(true)}><Plus size={16}/> Submit job</button></div>
      </header>

      <div className="shell">
        <aside className={`sidebar ${mobileNavOpen ? 'mobile-open' : ''}`}><nav aria-label="Primary navigation">
          <NavButton active={view === 'overview'} onClick={() => setView('overview')} icon={<Gauge size={17}/>} label="Overview"/>
          <NavButton active={view === 'jobs'} onClick={() => setView('jobs')} icon={<Boxes size={17}/>} label="Jobs" count={jobs.length}/>
          <NavButton active={view === 'workers'} onClick={() => setView('workers')} icon={<Server size={17}/>} label="Workers" count={Number(summary.workers.online)} tone="good"/>
          <NavButton active={view === 'retries'} onClick={() => setView('retries')} icon={<RotateCcw size={17}/>} label="Retries" count={Number(summary.counts.retry_wait)} tone="warn"/>
          <NavButton active={view === 'dead'} onClick={() => setView('dead')} icon={<Skull size={17}/>} label="Dead letters" count={Number(summary.counts.dead_lettered)} tone="bad"/>
        </nav><div className="sidebar-foot"><div className="database-card"><Database size={16}/><div><strong>PostgreSQL</strong><small>{mode === 'live' ? 'connected' : 'local API offline'}</small></div><CircleDot size={13} className="db-dot"/></div><p>QUEUEFORGE v0.1.0 · AT-LEAST-ONCE</p></div></aside>

        <section className="workspace">
          <PageHeading view={view} mode={mode}/>
          {view === 'overview' && <>
            <MetricGrid summary={summary}/>
            <div className="content-grid"><ThroughputPanel summary={summary} points={chartPoints}/><RecoveryPanel onOpen={() => setCrashOpen(true)} summary={summary}/></div>
            <div className="lower-grid"><JobsPanel jobs={jobs.slice(0, 6)} title="Recent jobs" onOpen={openJob} onAll={() => setView('jobs')}/><WorkersPanel workers={workers.slice(0, 5)}/></div>
          </>}
          {(view === 'jobs' || view === 'retries') && <JobsPanel jobs={visibleJobs} title={view === 'retries' ? 'Jobs awaiting retry' : 'All recent jobs'} onOpen={openJob}/>} 
          {view === 'workers' && <WorkerGrid workers={workers}/>} 
          {view === 'dead' && <DeadLetterPanel letters={deadLetters} onRedrive={redrive}/>} 
        </section>
      </div>

      {submitOpen && <SubmitDialog onClose={() => setSubmitOpen(false)} onSubmit={async (input) => { await submitJob(input); setSubmitOpen(false); }}/>} 
      {crashOpen && <CrashDialog onClose={() => setCrashOpen(false)} summary={summary}/>} 
      {selectedJob && <JobDrawer job={selectedJob} onClose={() => setSelectedJob(null)} onCancel={() => void cancelJob(selectedJob)}/>} 
      {toast && <output className="toast"><Check size={15}/>{toast}</output>}
    </main>
  );
}

function NavButton({ active, onClick, icon, label, count, tone }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number; tone?: string }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}{label}{count !== undefined && <span className={tone}>{count}</span>}</button>;
}

function PageHeading({ view, mode }: { view: View; mode: Mode }) {
  const copy: Record<View, [string,string,string]> = {
    overview: ['OPERATIONS / OVERVIEW','Queue health','Every claim, lease, retry, and terminal transition—visible in one place.'],
    jobs: ['OPERATIONS / JOBS','Job ledger','Inspect durable state, attempts, ownership, results, and failure context.'],
    workers: ['OPERATIONS / WORKERS','Worker fleet','Every process incarnation, queue subscription, slot, and heartbeat.'],
    retries: ['OPERATIONS / RETRIES','Retry schedule','Transient failures waiting behind persisted exponential backoff and full jitter.'],
    dead: ['OPERATIONS / DEAD LETTERS','Dead-letter queue','Terminal failures stay immutable; redrive creates a traceable new job.'],
  };
  return <div className="page-heading"><div><p className="eyebrow">{copy[view][0]}</p><h1>{copy[view][1]}</h1><p>{copy[view][2]}</p></div><div className={`health-pill ${mode !== 'live' ? 'demo-health' : ''}`}>{mode === 'live' ? <ShieldCheck size={18}/> : <Activity size={18}/>}<div><strong>{mode === 'live' ? 'System healthy' : 'Exploration mode'}</strong><small>{mode === 'live' ? 'Database + workers reachable' : 'Start the stack for live telemetry'}</small></div></div></div>;
}

function MetricGrid({ summary }: { summary: Summary }) {
  return <section className="metric-grid" aria-label="Queue metrics">
    <article className="metric-card"><div className="metric-label"><span>READY</span><Clock3 size={16}/></div><strong>{formatNumber(summary.counts.ready)}</strong><small>oldest <b>{formatNumber(Number(summary.counts.oldest_ready_age_ms)/1000,1)}s</b></small></article>
    <article className="metric-card"><div className="metric-label"><span>IN FLIGHT</span><Activity size={16}/></div><strong>{formatNumber(summary.counts.running)}</strong><small>across <b>{formatNumber(summary.workers.online)} workers</b></small></article>
    <article className="metric-card"><div className="metric-label"><span>GOODPUT</span><Gauge size={16}/></div><strong>{formatNumber(summary.rates.completed_per_second,1)} <em>/s</em></strong><small>successful completions</small></article>
    <article className="metric-card danger-card"><div className="metric-label"><span>DEAD LETTERS</span><Skull size={16}/></div><strong>{formatNumber(summary.counts.dead_lettered)}</strong><small>{Number(summary.counts.dead_lettered) ? 'requires attention' : 'queue is clear'}</small></article>
  </section>;
}

function ThroughputPanel({ summary, points }: { summary: Summary; points: string }) {
  return <section className="panel throughput-panel"><div className="panel-head"><div><p className="panel-kicker">PROCESSING RATE</p><h2>Throughput</h2></div><div className="legend"><span><i className="lime"/> completed</span><span><i/> dead</span><button>15 min</button></div></div><div className="chart-wrap"><div className="chart-y"><span>max</span><span>75%</span><span>50%</span><span>25%</span><span>0</span></div><svg viewBox="0 0 360 72" preserveAspectRatio="none"><title>Completed jobs per minute over the last 15 minutes</title><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#a6ff62" stopOpacity=".32"/><stop offset="1" stopColor="#a6ff62" stopOpacity="0"/></linearGradient></defs><path d={`M ${points} L 360,72 L 0,72 Z`} fill="url(#area)"/><polyline points={points} fill="none" stroke="#a6ff62" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg></div><div className="chart-x"><span>15m ago</span><span>10m</span><span>5m</span><span>now</span></div><div className="latency-strip"><span>QUEUE P95 <b>{formatNumber(summary.latency.queue_wait_p95_ms,1)} ms</b></span><span>END-TO-END P95 <b>{formatNumber(summary.latency.end_to_end_p95_ms,1)} ms</b></span><span>END-TO-END P99 <b>{formatNumber(summary.latency.end_to_end_p99_ms,1)} ms</b></span></div></section>;
}

function RecoveryPanel({ onOpen, summary }: { onOpen: () => void; summary: Summary }) {
  return <section className="panel recovery-panel"><div className="panel-head"><div><p className="panel-kicker">FAULT TOLERANCE</p><h2>Recovery protocol</h2></div><History size={18}/></div><div className="recovery-stat"><strong>6<em>s</em></strong><span>demo lease deadline · heartbeat every 1.8s</span></div><ol className="event-list"><li className="done"><i/><div><strong>Lease acquired</strong><small>generation-fenced claim</small></div><time>t+0</time></li><li className="failed"><i/><div><strong>Heartbeat lost</strong><small>hard-killed worker</small></div><time>t+6s</time></li><li className="done"><i/><div><strong>Job reclaimed</strong><small>new token + generation</small></div><time>bounded</time></li></ol><div className="recovery-note">{Number(summary.rates.leases_expired_5m)} expired lease{Number(summary.rates.leases_expired_5m) === 1 ? '' : 's'} in the last 5m</div><button className="lab-button" onClick={onOpen}><Play size={15}/> Open crash lab <ChevronRight size={15}/></button></section>;
}

function JobsPanel({ jobs, title, onOpen, onAll }: { jobs: Job[]; title: string; onOpen: (job: Job) => void; onAll?: () => void }) {
  return <section className="panel jobs-panel"><div className="panel-head"><div><p className="panel-kicker">DURABLE LEDGER</p><h2>{title}</h2></div>{onAll && <button className="text-button" onClick={onAll}>View all <ChevronRight size={14}/></button>}</div><div className="table-scroll"><table><thead><tr><th>JOB ID</th><th>TYPE</th><th>QUEUE</th><th>STATE</th><th>ATTEMPTS</th><th>AGE</th><th>WORKER</th></tr></thead><tbody>{jobs.length ? jobs.map((job) => <tr key={job.id} onClick={() => onOpen(job)} className="clickable-row"><td className="mono">{shortId(job.id)}</td><td>{job.type}</td><td>{job.queue}</td><td><StateBadge state={job.status}/></td><td>{job.attempts_started} / {job.max_attempts}</td><td suppressHydrationWarning>{age(job.created_at)}</td><td className="mono muted-cell">{job.lease_owner_name ?? '—'}</td></tr>) : <tr><td colSpan={7} className="empty-cell">No jobs match this view.</td></tr>}</tbody></table></div></section>;
}

function WorkersPanel({ workers }: { workers: WorkerRow[] }) {
  return <section className="panel workers-panel"><div className="panel-head"><div><p className="panel-kicker">CONSUMERS</p><h2>Workers</h2></div><span className="online-count">{workers.filter((worker) => worker.status !== 'offline').length} ONLINE</span></div><div className="worker-list">{workers.map((worker) => <article key={worker.id}><span className={`worker-led ${worker.current_jobs ? 'busy' : 'idle'} ${worker.status}`}/><div><strong>{worker.name}</strong><small>{worker.queues.join(', ')} · {worker.current_jobs}/{worker.concurrency} slots</small></div><time>{formatNumber(Number(worker.heartbeat_age_ms)/1000,1)}s</time></article>)}</div></section>;
}

function WorkerGrid({ workers }: { workers: WorkerRow[] }) {
  return <section className="worker-grid">{workers.map((worker) => <article className="panel worker-card" key={worker.id}><div className="worker-card-head"><span className={`worker-led ${worker.status}`}/><StateBadge state={worker.status === 'offline' ? 'dead_lettered' : worker.current_jobs ? 'running' : 'queued'}/></div><h2>{worker.name}</h2><p className="mono muted-cell">{worker.id}</p><dl><div><dt>SLOTS</dt><dd>{worker.current_jobs} / {worker.concurrency}</dd></div><div><dt>HEARTBEAT AGE</dt><dd>{formatNumber(Number(worker.heartbeat_age_ms)/1000,2)}s</dd></div><div><dt>QUEUES</dt><dd>{worker.queues.join(', ')}</dd></div><div><dt>BUILD</dt><dd>{worker.build_version}</dd></div></dl></article>)}</section>;
}

function DeadLetterPanel({ letters, onRedrive }: { letters: DeadLetter[]; onRedrive: (letter: DeadLetter) => void }) {
  return <section className="panel jobs-panel"><div className="panel-head"><div><p className="panel-kicker">TERMINAL FAILURES</p><h2>Dead-letter queue</h2></div><span className="danger-count">{letters.length} ISOLATED</span></div><div className="table-scroll"><table><thead><tr><th>JOB ID</th><th>TYPE</th><th>QUEUE</th><th>REASON</th><th>FINAL ATTEMPT</th><th>FAILED</th><th>ACTION</th></tr></thead><tbody>{letters.length ? letters.map((letter) => <tr key={letter.job_id}><td className="mono">{shortId(letter.job_id)}</td><td>{letter.type}</td><td>{letter.queue}</td><td><span className="state state-dead">{letter.reason}</span></td><td>{letter.final_attempt}</td><td>{age(letter.dead_lettered_at)}</td><td><button className="row-action" onClick={() => onRedrive(letter)}><RefreshCw size={12}/> Redrive</button></td></tr>) : <tr><td colSpan={7} className="empty-cell">No jobs are dead-lettered.</td></tr>}</tbody></table></div></section>;
}

function Modal({ children, onClose, wide = false }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><dialog open className={`modal ${wide ? 'modal-wide' : ''}`}>{children}</dialog></div>;
}

function SubmitDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (input: { type: string; queue: string; payload: Record<string, unknown>; max_attempts: number }) => Promise<void> }) {
  const [type, setType] = useState('noop'); const [queue, setQueue] = useState('default'); const [duration, setDuration] = useState(250); const [maxAttempts, setMaxAttempts] = useState(5); const [working, setWorking] = useState(false); const [error, setError] = useState('');
  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => { event.preventDefault(); setWorking(true); setError(''); try { const payload = type === 'flaky' ? { duration_ms: duration, fail_until_attempt: 2 } : type === 'always_fail' ? { duration_ms: duration, retryable: true, message: 'Planned dashboard failure' } : type === 'idempotent_counter' ? { effect_key: 'dashboard-demo', value: 1, sleep_after_effect_ms: duration } : { duration_ms: duration }; await onSubmit({ type, queue, payload, max_attempts: maxAttempts }); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Submission failed'); setWorking(false); } };
  return <Modal onClose={onClose}><div className="modal-head"><div><p className="panel-kicker">CLIENT API</p><h2>Submit a job</h2></div><button onClick={onClose} aria-label="Close"><X size={18}/></button></div><form className="job-form" onSubmit={submit}><label>Handler<select value={type} onChange={(event) => setType(event.target.value)}><option value="noop">noop — completes successfully</option><option value="flaky">flaky — recovers after retries</option><option value="always_fail">always_fail — reaches the DLQ</option><option value="idempotent_counter">idempotent_counter — crash-safe effect</option></select></label><div className="form-row"><label>Queue<select value={queue} onChange={(event) => setQueue(event.target.value)}><option>default</option><option>critical</option><option>media</option></select></label><label>Max attempts<input type="number" min={1} max={100} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))}/></label></div><label>Handler delay <span>{duration} ms</span><input type="range" min={0} max={10000} step={50} value={duration} onChange={(event) => setDuration(Number(event.target.value))}/></label><div className="idempotency-callout"><ShieldCheck size={16}/><div><strong>Safe client retry</strong><span>The dashboard sends a fresh Idempotency-Key; identical network retries resolve to one durable job.</span></div></div>{error && <p className="form-error"><AlertTriangle size={14}/>{error}</p>}<div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={working}>{working ? 'Submitting…' : 'Submit job'}</button></div></form></Modal>;
}

function CrashDialog({ onClose, summary }: { onClose: () => void; summary: Summary }) {
  return <Modal onClose={onClose} wide><div className="modal-head"><div><p className="panel-kicker">AUTOMATED CHAOS PROOF</p><h2>Crash-recovery lab</h2></div><button onClick={onClose} aria-label="Close"><X size={18}/></button></div><div className="crash-layout"><div className="crash-terminal"><div className="terminal-bar"><i/><i/><i/><span>prove-recovery</span></div><pre><span>$</span> npm run proof:recovery{`\n`}01 submit idempotent effect job{`\n`}02 wait: effect committed by worker-a{`\n`}03 <b>docker kill queueforge-worker-a</b>{`\n`}04 observe: lease expired{`\n`}05 worker-b claim generation +1{`\n`}06 assert logical_effect_count == 1{`\n`}07 assert attempts == 2{`\n`}08 persist JSON + Markdown evidence</pre></div><div className="proof-checks"><h3>What the proof refuses to fake</h3><p><Check size={14}/> Hard SIGKILL, not graceful shutdown</p><p><Check size={14}/> PostgreSQL remains the source of truth</p><p><Check size={14}/> A new fencing token owns attempt two</p><p><Check size={14}/> Side effect occurs once across redelivery</p><p><Check size={14}/> Machine assertions fail the run on regression</p><div className="proof-stat"><span>RECENT LEASE EXPIRATIONS</span><strong>{summary.rates.leases_expired_5m}</strong><small>last 5 minutes</small></div></div></div><div className="modal-actions"><button className="primary-button" onClick={onClose}>Got it</button></div></Modal>;
}

function JobDrawer({ job, onClose, onCancel }: { job: Job; onClose: () => void; onCancel: () => void }) {
  const canCancel = ['queued','running','retry_wait'].includes(job.status);
  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="job-drawer"><div className="modal-head"><div><p className="panel-kicker">JOB DETAIL</p><h2>{shortId(job.id)}</h2></div><button onClick={onClose} aria-label="Close"><X size={18}/></button></div><div className="drawer-summary"><StateBadge state={job.status}/><span>{job.type}</span><span>{job.queue}</span></div><dl className="detail-list"><div><dt>FULL ID</dt><dd className="mono">{job.id}</dd></div><div><dt>ATTEMPTS</dt><dd>{job.attempts_started} / {job.max_attempts}</dd></div><div><dt>CURRENT WORKER</dt><dd>{job.lease_owner_name ?? 'none'}</dd></div><div><dt>CREATED</dt><dd>{new Date(job.created_at).toLocaleString()}</dd></div></dl>{job.last_error && <div className="error-box"><strong>{job.last_error.type ?? 'Error'}</strong><span>{job.last_error.message}</span></div>}<section className="timeline-detail"><h3>Attempt timeline</h3>{job.attempts?.length ? job.attempts.map((attempt) => <article key={attempt.attempt_no}><i/><div><strong>Attempt {attempt.attempt_no} · {attempt.outcome ?? 'running'}</strong><span>{attempt.worker_name ?? 'unknown worker'} · {new Date(attempt.claimed_at).toLocaleTimeString()}{attempt.backoff_ms ? ` · ${attempt.backoff_ms}ms backoff` : ''}</span></div></article>) : <p className="muted-cell">Open against a live API to load the durable attempt log.</p>}</section><div className="drawer-actions">{canCancel && <button className="danger-button" onClick={onCancel}>Cancel job</button>}<button className="ghost-button" onClick={onClose}>Close</button></div></aside></div>;
}
