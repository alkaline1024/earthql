import { useEffect, useId, useRef, useState } from 'react';
import { describePath, type TreeNode } from '@earthql/core';
import { api, errorInfo } from '../api';
import { compareSchemas, readSchema, schemaDiagram, type SchemaSnapshot } from '../schema-tools';
import { useApp } from '../store';
import { Modal, Spinner } from './common';

function SchemaPicker({ profileId, label, onChange, disabled }: { profileId: string; label: string; onChange(node: TreeNode | null): void; disabled: boolean }) {
  const connection = useApp((state) => state.connections[profileId]);
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [rootIndex, setRootIndex] = useState(0);
  const [schemas, setSchemas] = useState<TreeNode[]>([]);
  const [schemaIndex, setSchemaIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const root = roots[rootIndex];
  const hasSchemas = connection?.capabilities.hierarchy.includes('schema') ?? false;

  useEffect(() => {
    let active = true;
    setRoots([]); setSchemas([]); setRootIndex(0); setSchemaIndex(0); setError(''); setLoading(true); onChange(null);
    api.meta.children(profileId, null).then((nodes) => {
      if (!active) return;
      const scope = connection?.scope;
      setRoots(nodes.filter((node) => node.hasChildren && (!scope || (node.kind === scope.kind && node.name === scope.name))));
    }).catch((failure) => { if (active) setError(errorInfo(failure).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [profileId, connection?.scope, onChange]);

  useEffect(() => {
    let active = true;
    setSchemas([]); setSchemaIndex(0); onChange(null);
    if (!root || !hasSchemas) { if (root) onChange(root); return; }
    setLoading(true); setError('');
    api.meta.children(profileId, root).then((nodes) => {
      if (active) setSchemas(nodes.filter((node) => node.kind === 'schema' && node.hasChildren));
    }).catch((failure) => { if (active) setError(errorInfo(failure).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [profileId, root, hasSchemas, onChange]);
  useEffect(() => { if (hasSchemas) onChange(schemas[schemaIndex] ?? null); }, [schemas, schemaIndex, hasSchemas, onChange]);

  return <fieldset className="col" style={{ gap: 6 }}>
    <legend>{label}</legend>
    <label>Database or catalog <select className="select" value={root ? String(rootIndex) : ''} disabled={disabled || loading || !roots.length}
      onChange={(event) => setRootIndex(Number(event.target.value))}>
      {!roots.length && <option value="">None available</option>}
      {roots.map((node, index) => <option value={index} key={JSON.stringify([node.kind, node.path, node.name])}>{node.name}</option>)}
    </select></label>
    {hasSchemas && <label>Schema <select className="select" value={schemas[schemaIndex] ? String(schemaIndex) : ''} disabled={disabled || loading || !schemas.length}
      onChange={(event) => setSchemaIndex(Number(event.target.value))}>
      {!schemas.length && <option value="">None available</option>}
      {schemas.map((node, index) => <option value={index} key={JSON.stringify([node.path, node.name])}>{node.name}</option>)}
    </select></label>}
    {loading && <span><Spinner /> Loading locations…</span>}
    {error && <span className="err" role="alert">{error}</span>}
  </fieldset>;
}

export function SchemaTools({ profileId, mode, onClose }: { profileId: string; mode: 'diagram' | 'compare'; onClose(): void }) {
  const connections = useApp((state) => state.connections);
  const profiles = useApp((state) => state.profiles);
  const [targetId, setTargetId] = useState(profileId);
  const [source, setSource] = useState<TreeNode | null>(null);
  const [target, setTarget] = useState<TreeNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ source: SchemaSnapshot; target?: SchemaSnapshot } | null>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  useEffect(() => { setResult(null); setStopped(false); }, [source, target, targetId]);

  async function run() {
    if (!source || (mode === 'compare' && !target)) return;
    const current = ++request.current;
    setBusy(true); setStopped(false); setResult(null); setError('');
    const scan = (id: string, parent: TreeNode, label: string) => readSchema({
      parent, children: (node) => api.meta.children(id, node), structure: (path) => api.meta.structure(id, path, true),
      errorMessage: (failure) => errorInfo(failure).message, cancelled: () => request.current !== current,
      progress: (done, total) => { if (request.current === current) setProgress(`${label}: ${done} / ${total}`); },
    });
    try {
      setProgress('Reading source…');
      const first = await scan(profileId, source, 'Source');
      if (request.current !== current) return;
      const second = mode === 'compare' && target ? await scan(targetId, target, 'Target') : undefined;
      if (request.current === current) setResult({ source: first, target: second });
    } catch (failure) {
      if (request.current === current) setError(errorInfo(failure).message);
    } finally { if (request.current === current) setBusy(false); }
  }
  const differences = result?.target ? compareSchemas(result.source, result.target) : [];
  const errors = [...(result?.source.errors ?? []), ...(result?.target?.errors ?? [])];
  return <Modal title={mode === 'compare' ? 'Compare schemas' : 'ER diagram'} onClose={onClose}>
    <div className="col" style={{ gap: 10 }}>
      <SchemaPicker profileId={profileId} label="Source" onChange={setSource} disabled={busy} />
      {mode === 'compare' && <>
        <label>Target connection <select className="select" value={targetId} disabled={busy} onChange={(event) => { setTarget(null); setTargetId(event.target.value); }}>
          {Object.entries(connections).filter(([, connection]) => connection.status === 'connected').map(([id, connection]) => <option key={id} value={id}>
            {profiles.find(({ profile }) => profile.id === connection.profileId)?.profile.name ?? connection.profileId}{connection.scope ? ` (${connection.scope.name})` : ''}
          </option>)}
        </select></label>
        <SchemaPicker profileId={targetId} label="Target" onChange={setTarget} disabled={busy} />
      </>}
      <p className="muted small">Reads metadata for every table and view in the selected schema. Large schemas may take time.</p>
      <div className="row">
        {busy ? <><Spinner /><span>{progress}</span><button className="btn" onClick={() => { request.current += 1; setBusy(false); setStopped(true); }}>Stop</button></>
          : <button className="btn primary" disabled={!source || (mode === 'compare' && !target)} onClick={() => void run()}>{mode === 'compare' ? 'Compare' : 'Build diagram'}</button>}
      </div>
      {stopped && <p className="muted">Scan stopped; no results were saved.</p>}
      {error && <p className="err" role="alert">{error}</p>}
      {!!errors.length && <details open><summary>Incomplete metadata ({errors.length})</summary>{errors.map((item, index) => <div className="err" key={index}>{item}</div>)}</details>}
      {result && mode === 'compare' && <>
        <p className="muted small">Compares names, column properties, indexes and constraints; not view definitions or triggers. Differences are informational and do not generate migrations.</p>
        {differences.length ? <div className="scroll" style={{ maxHeight: 350 }}><table className="list"><thead><tr><th>Object</th><th>Difference</th></tr></thead>
          <tbody>{differences.map((item, index) => <tr key={index}><td>{item.object}</td><td>{item.detail}</td></tr>)}</tbody></table></div>
          : <p>{errors.length ? 'No differences found in readable metadata; the comparison is incomplete.' : 'No differences found in the compared metadata.'}</p>}
      </>}
      {result && mode === 'diagram' && <Diagram snapshot={result.source} />}
    </div>
  </Modal>;
}

function Diagram({ snapshot }: { snapshot: SchemaSnapshot }) {
  const marker = useId();
  const { nodes, edges } = schemaDiagram(snapshot);
  const positions = new Map(nodes.map((node, index) => [node.key, { x: 25 + (index % 3) * 270, y: 25 + Math.floor(index / 3) * 170 }]));
  if (!nodes.length) return <p>No tables found in this schema.</p>;
  return <>
    <p className="muted small">Arrows point to referenced tables. External tables are shown without columns.</p>
    <div className="scroll" style={{ maxHeight: 480, border: '1px solid var(--line)' }}>
      <svg role="img" aria-label="Table relationship diagram" width={810} height={Math.ceil(nodes.length / 3) * 170 + 30}>
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-2)" /></marker></defs>
        {edges.map((edge, index) => {
          const a = positions.get(edge.source)!, b = positions.get(edge.target)!;
          const dx = b.x - a.x, dy = b.y - a.y;
          const factor = Math.min(dx ? 105 / Math.abs(dx) : Infinity, dy ? 65 / Math.abs(dy) : Infinity);
          const path = edge.source === edge.target
            ? `M ${a.x + 210} ${a.y + 35} C ${a.x + 260} ${a.y - 20}, ${a.x + 260} ${a.y + 120}, ${a.x + 210} ${a.y + 95}`
            : `M ${a.x + 105 + dx * factor} ${a.y + 65 + dy * factor} L ${b.x + 105 - dx * factor} ${b.y + 65 - dy * factor}`;
          return <path key={index} d={path} fill="none" stroke="var(--text-2)" markerEnd={`url(#${marker})`}><title>{edge.label}</title></path>;
        })}
        {nodes.map((node) => {
          const point = positions.get(node.key)!;
          return <g key={node.key} transform={`translate(${point.x}, ${point.y})`}>
            <rect width="210" height="130" rx="5" fill="var(--bg)" stroke="var(--line-strong)" />
            <text x="8" y="18" fill="var(--text)" fontSize="12"><title>{describePath(node.path)}</title>{node.path.name.slice(0, 27)}{node.external ? ' (external)' : ''}</text>
            {node.columns.slice(0, 6).map((column, index) => <text key={column} x="8" y={37 + index * 14} fill="var(--text-2)" fontSize="11">{column.slice(0, 30)}</text>)}
            {node.columns.length > 6 && <text x="8" y="121" fill="var(--text-3)" fontSize="11">… {node.columns.length - 6} more</text>}
          </g>;
        })}
      </svg>
    </div>
    {edges.length > 0 && <details><summary>{edges.length} relationships</summary>{edges.map((edge, index) => <div key={index}>{edge.label}</div>)}</details>}
    {!edges.length && <p className="muted">No foreign-key relationships were returned by the database.</p>}
  </>;
}
