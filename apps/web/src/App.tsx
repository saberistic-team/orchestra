import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { projectBriefSchema, type AgentRole, type Project, type ProjectArtifact, type ProjectDetail, type ProjectStatus, type ProjectSummary } from '@orchestra/contracts';
import { AgentOrganism } from './AgentOrganism.js';
import { HumanReviewWorkspace } from './HumanReview.js';

const emptyDraft = { name: '', intent: '', audience: '', success: '', constraints: '' };
type Draft = typeof emptyDraft;
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>; }

const statusCopy: Record<ProjectStatus, string> = {
  discovering: 'Opening the studio', defining: 'Defining the product', planning: 'Planning the solution',
  building: 'Building', reviewing: 'Checking the work', awaiting_approval: 'Waiting for your review',
  blocked: 'Needs attention', completed: 'Completed',
};

function navigate(path: string) {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [online, setOnline] = useState(navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent>();
  useEffect(() => {
    const route = () => setPath(location.pathname);
    const connection = () => setOnline(navigator.onLine);
    const install = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent); };
    window.addEventListener('popstate', route); window.addEventListener('online', connection);
    window.addEventListener('offline', connection); window.addEventListener('beforeinstallprompt', install);
    return () => { window.removeEventListener('popstate', route); window.removeEventListener('online', connection); window.removeEventListener('offline', connection); window.removeEventListener('beforeinstallprompt', install); };
  }, []);
  const install = async () => { await installPrompt?.prompt(); await installPrompt?.userChoice; setInstallPrompt(undefined); };
  const detailMatch = path.match(/^\/projects\/([0-9a-f-]+)$/i);

  return <main className="shell">
    <Header online={online} installPrompt={installPrompt} install={install} />
    {path === '/new' ? <NewProject online={online} /> : detailMatch ? <ProjectPage id={detailMatch[1]} /> : <ProjectsPage />}
    <footer><span>Orchestra</span><p>Human decisions. Agent-powered delivery.</p></footer>
  </main>;
}

function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => fetch('/api/projects').then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((value) => { if (active) { setProjects(value); setError(''); } }).catch(() => { if (active) setError('We could not load your studios.'); });
    void load(); const timer = window.setInterval(load, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return <>
    <section className="dashboard-heading">
      <div><p className="eyebrow">Your software studios</p><h1>Projects in motion.</h1><p className="lede">See what your agent teams are doing, review each iteration, and try the latest working version.</p></div>
      <button className="primary-action" onClick={() => navigate('/new')}>Start a project <span>→</span></button>
    </section>
    {error && <p className="error light-error" role="alert">{error}</p>}
    {!projects && !error && <div className="loading-card">Gathering the latest project activity…</div>}
    {projects?.length === 0 && <section className="empty-state"><span>01</span><h2>Your first studio starts with an idea.</h2><p>No technical plan needed. Tell us who you want to help and what success looks like.</p><button className="primary-action" onClick={() => navigate('/new')}>Describe your idea</button></section>}
    <section className="project-grid" aria-label="Projects">
      {projects?.map((project) => <article className="project-card" key={project.id}>
        <div className="card-top"><Status status={project.status} /><span>Iteration {project.currentIteration}</span></div>
        <h2><a href={`/projects/${project.id}`} onClick={(event) => { event.preventDefault(); navigate(`/projects/${project.id}`); }}>{project.name}</a></h2>
        <p>{project.intent}</p>
        <div className="latest-note"><small>Latest</small><strong>{project.latestEvent?.title ?? 'Studio created'}</strong><span>{project.artifactCount} artifact{project.artifactCount === 1 ? '' : 's'}</span></div>
      </article>)}
    </section>
  </>;
}

function ProjectPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<ProjectDetail>();
  const [error, setError] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgentRole>('manager');
  const detailRef = useRef<ProjectDetail | undefined>(undefined);
  const detailVersionRef = useRef(0);
  const pageVersionRef = useRef(0);
  const requestRef = useRef<{ projectId: string; controller: AbortController; token: symbol; promise: Promise<void> } | undefined>(undefined);

  const load = useCallback(() => {
    const activeRequest = requestRef.current;
    if (activeRequest?.projectId === id) return activeRequest.promise;
    activeRequest?.controller.abort();

    const controller = new AbortController();
    const token = Symbol(id);
    const pageVersion = pageVersionRef.current;
    const detailVersion = detailVersionRef.current;
    const promise = (async () => {
      try {
        const response = await fetch(`/api/projects/${id}`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const value = await response.json() as ProjectDetail;
        if (controller.signal.aborted
          || pageVersion !== pageVersionRef.current
          || detailVersion !== detailVersionRef.current) return;
        detailRef.current = value;
        detailVersionRef.current += 1;
        setDetail(value);
        setError('');
      } catch {
        if (controller.signal.aborted || pageVersion !== pageVersionRef.current) return;
        if (!detailRef.current) setError('We could not load this project.');
      } finally {
        if (requestRef.current?.token === token) requestRef.current = undefined;
      }
    })();
    requestRef.current = { projectId: id, controller, token, promise };
    return promise;
  }, [id]);

  useEffect(() => {
    const pageVersion = ++pageVersionRef.current;
    detailRef.current = undefined;
    detailVersionRef.current = 0;
    setDetail(undefined);
    setError('');
    let disposed = false;
    let fallbackTimer: number | undefined;
    let source: EventSource | undefined;

    const stopFallback = () => {
      if (fallbackTimer === undefined) return;
      window.clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    };
    const startFallback = () => {
      if (disposed || fallbackTimer !== undefined) return;
      void load();
      fallbackTimer = window.setInterval(() => { void load(); }, 4_000);
    };
    const applySnapshot = (event: MessageEvent<string>) => {
      if (disposed || pageVersion !== pageVersionRef.current) return;
      try {
        const value = JSON.parse(event.data) as ProjectDetail;
        if (value.project.id !== id) return;
        detailRef.current = value;
        detailVersionRef.current += 1;
        setDetail(value);
        setError('');
        stopFallback();
      } catch {
        startFallback();
      }
    };

    void load().then(() => {
      if (disposed || pageVersion !== pageVersionRef.current) return;
      if (!window.EventSource) {
        startFallback();
        return;
      }
      try {
        source = new window.EventSource(`/api/projects/${id}/snapshots`);
        source.onopen = stopFallback;
        source.onmessage = applySnapshot;
        source.onerror = startFallback;
      } catch {
        startFallback();
      }
    });

    return () => {
      disposed = true;
      pageVersionRef.current += 1;
      stopFallback();
      source?.close();
      const request = requestRef.current;
      if (request?.projectId === id) {
        request.controller.abort();
        requestRef.current = undefined;
      }
    };
  }, [id, load]);
  if (error) return <section className="empty-state"><h1>Project unavailable.</h1><p>{error}</p><button className="secondary" onClick={() => navigate('/projects')}>Back to projects</button></section>;
  if (!detail) return <div className="loading-card">Collecting the project story and latest artifacts…</div>;
  const { project, events, media } = detail;
  const currentIterationId = detail.iterations.find((iteration) => iteration.number === project.currentIteration)?.id;
  const currentPreviews = media.filter((item) => item.kind === 'preview' && item.iterationId === currentIterationId);
  const checkpointRevision = detail.reviewCheckpoint?.previewRevision;
  const checkpointImageDigest = detail.reviewCheckpoint?.previewImageDigest;
  const checkpointExpiresAt = detail.reviewCheckpoint?.previewExpiresAt;
  const previewMedia = checkpointRevision && checkpointImageDigest && checkpointExpiresAt
    ? currentPreviews
      .filter((item) => item.sourceRevision === checkpointRevision
        && item.imageDigest === checkpointImageDigest
        && item.expiresAt === checkpointExpiresAt)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
    : !checkpointRevision && !checkpointImageDigest && !checkpointExpiresAt
      ? [...currentPreviews].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
      : undefined;
  const preview = previewMedia
    && (!previewMedia.expiresAt || Date.now() < Date.parse(previewMedia.expiresAt))
    ? previewMedia.url
    : null;
  return <>
    <button className="back-link" onClick={() => navigate('/projects')}>← All projects</button>
    <section className="detail-hero">
      <div><Status status={project.status} /><h1>{project.name}</h1><p>{project.intent}</p></div>
      <div className="detail-actions"><span>Iteration {project.currentIteration}</span>{preview ? <a className="primary-action" href={preview} target="_blank" rel="noreferrer">Try the latest version ↗</a> : <button className="primary-action muted" disabled>Preview coming soon</button>}{project.repositoryUrl && <a className="repository-link" href={project.repositoryUrl} target="_blank" rel="noreferrer">Open project repository ↗</a>}</div>
    </section>
    <AgentOrganism detail={detail} selectedRole={selectedAgent} onSelectedRoleChange={setSelectedAgent} onReload={load} />
    <section className="detail-layout">
      <div className="main-column">
        <HumanReviewWorkspace detail={detail} preview={preview} onReload={load} />
      </div>
      <aside>
        <SectionTitle kicker="Live history" title="What happened" />
        <div className="timeline-scroll"><ol className="timeline">
          {events.map((event) => <li key={event.id}><span className={`event-dot ${event.kind}`} /><div><time>{new Date(event.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><strong>{event.title}</strong><p>{event.description}</p>{event.agentRole && <small>{event.agentRole} agent</small>}</div></li>)}
        </ol></div>
      </aside>
    </section>
  </>;
}

function ArtifactViewer({ artifact }: { artifact: ProjectArtifact }) {
  if (artifact.mimeType === 'text/markdown') return <div className="artifact-viewer markdown-viewer"><ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown>{artifact.repositoryUrl && <a className="source-link" href={artifact.repositoryUrl} target="_blank" rel="noreferrer">View source in Forgejo ↗</a>}</div>;
  if (artifact.mimeType === 'image/svg+xml') return <div className="artifact-viewer image-viewer"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(artifact.content)}`} alt={artifact.name} />{artifact.repositoryUrl && <a className="source-link" href={artifact.repositoryUrl} target="_blank" rel="noreferrer">View image in Forgejo ↗</a>}</div>;
  let code = artifact.content;
  if (artifact.mimeType === 'application/json') { try { code = JSON.stringify(JSON.parse(code), null, 2); } catch { /* show original */ } }
  return <div className="artifact-viewer code-viewer"><pre><code>{code}</code></pre>{artifact.repositoryUrl && <a className="source-link" href={artifact.repositoryUrl} target="_blank" rel="noreferrer">View file in Forgejo ↗</a>}</div>;
}

function NewProject({ online }: { online: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => { try { return { ...emptyDraft, ...JSON.parse(localStorage.getItem('orchestra-draft') ?? '{}') }; } catch { return emptyDraft; } });
  const [error, setError] = useState(''); const [submitting, setSubmitting] = useState(false);
  useEffect(() => { localStorage.setItem('orchestra-draft', JSON.stringify(draft)); }, [draft]);
  const update = (field: keyof Draft, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    const parsed = projectBriefSchema.safeParse({ ...draft, constraints: draft.constraints.split('\n').map((item) => item.trim()).filter(Boolean) });
    if (!parsed.success) { setError('Please add a little more detail so your team understands the idea and what success looks like.'); return; }
    setSubmitting(true);
    try {
      const response = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed.data) });
      if (!response.ok) throw new Error();
      const created = await response.json() as Project; localStorage.removeItem('orchestra-draft'); navigate(`/projects/${created.id}`);
    } catch { setError(online ? 'We could not start your project. Please try again.' : 'You are offline. Your draft is safe on this device.'); }
    finally { setSubmitting(false); }
  }
  return <>
    <button className="back-link" onClick={() => navigate('/projects')}>← Your projects</button>
    <section className="hero"><div><p className="eyebrow">A software team that speaks human</p><h1>Tell us the idea.<br /><em>We’ll shape the software.</em></h1><p className="lede">No technical plan needed. Describe who it helps and what a good result feels like.</p></div><div className="promise"><span>01</span><p>You describe the outcome</p><span>02</span><p>Your team proposes a plan</p><span>03</span><p>You approve every iteration</p></div></section>
    <form className="intake" onSubmit={submit} noValidate>
      <div className="form-heading"><div><p className="eyebrow">Start with the essentials</p><h2>What are we making?</h2></div><span>About 3 minutes</span></div>
      <label>Give your idea a name<input value={draft.name} onChange={(event) => update('name', event.target.value)} placeholder="Neighborhood helper" /></label>
      <label>What should it help people do?<textarea value={draft.intent} onChange={(event) => update('intent', event.target.value)} placeholder="Help neighbors ask for and offer small favors…" rows={4} /></label>
      <div className="two-column"><label>Who is it for?<textarea value={draft.audience} onChange={(event) => update('audience', event.target.value)} placeholder="People in the same neighborhood" rows={3} /></label><label>How will we know it works?<textarea value={draft.success} onChange={(event) => update('success', event.target.value)} placeholder="Someone can ask for help and another person can accept" rows={3} /></label></div>
      <label className="optional">Anything we must keep in mind? <small>Optional · one item per line</small><textarea value={draft.constraints} onChange={(event) => update('constraints', event.target.value)} placeholder={'Keep personal addresses private\nMust work well on phones'} rows={3} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="submit-row"><p>Your draft stays on this device until you send it.</p><button type="submit" disabled={submitting}>{submitting ? 'Opening your studio…' : 'Start my project'} <span>→</span></button></div>
    </form>
  </>;
}

function Status({ status }: { status: ProjectStatus }) { return <span className={`status-pill status-${status}`}><i />{statusCopy[status]}</span>; }
function SectionTitle({ kicker, title }: { kicker: string; title: string }) { return <div className="section-title"><p className="eyebrow">{kicker}</p><h2>{title}</h2></div>; }
function Header({ online, installPrompt, install }: { online: boolean; installPrompt?: BeforeInstallPromptEvent; install(): void }) {
  return <header><a className="brand" href="/projects" onClick={(event) => { event.preventDefault(); navigate('/projects'); }}><img src="/orchestra-mark.svg" alt="" /><span>orchestra</span></a><nav><a href="/projects" onClick={(event) => { event.preventDefault(); navigate('/projects'); }}>Projects</a>{installPrompt && <button className="install" onClick={install}>Install app</button>}<span className={online ? 'connection online' : 'connection'}>{online ? 'Ready' : 'Offline'}</span></nav></header>;
}
