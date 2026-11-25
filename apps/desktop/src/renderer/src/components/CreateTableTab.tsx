import { useEffect, useMemo, useState } from 'react';
import {
  describePath,
  type BuiltStatement,
  type ColumnDefault,
  type ColumnSpec,
  type CreateTableSpec,
  type ErrorInfo,
  type ObjectPath,
  type TreeNode,
  type TypeOption,
} from '@earthql/core';
import { api, errorInfo } from '../api';
import { noteError, profileOf, useApp } from '../store';
import { ContextBar } from './ContextBar';
import { ConfirmTarget, ErrorView, Modal, Spinner } from './common';

interface ColDraft {
  key: number;
  name: string;
  baseType: string; // type name from the list, or '__custom'
  params: string;
  custom: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultKind: ColumnDefault['kind'];
  defaultValue: string;
}

let keySeq = 1;

function fullType(c: ColDraft, types: TypeOption[]): string {
  if (c.baseType === '__custom') return c.custom.trim();
  const t = types.find((x) => x.name === c.baseType);
  if (t?.params && c.params.trim()) return `${t.name}(${c.params.trim()})`;
  return c.baseType;
}

export function CreateTableTab({ tabId, profileId, container, refreshVersion = 0 }: { tabId: string; profileId: string; container: Partial<ObjectPath>; refreshVersion?: number }) {
  const conn = useApp((s) => s.connections[profileId]);
  const { openTab, closeTab, refreshTree, toast } = useApp();
  const profile = profileOf(profileId)?.profile;
  const caps = conn?.capabilities;
  const types = caps?.types ?? [];
  const hierarchy = caps?.hierarchy ?? [];
  const topLevel = hierarchy[0] as 'catalog' | 'database';
  const hasSchema = hierarchy.includes('schema');

  const [top, setTop] = useState<string>(container.catalog ?? container.database ?? conn?.defaultContext.catalog ?? conn?.defaultContext.database ?? '');
  const [schema, setSchema] = useState<string>(container.schema ?? conn?.defaultContext.schema ?? '');
  const [topOptions, setTopOptions] = useState<string[]>([]);
  const [schemaOptions, setSchemaOptions] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [ifNotExists, setIfNotExists] = useState(false);
  const defaultIntType = types.find((t) => /^(bigint|BIGINT)$/.test(t.name))?.name ?? types[0]?.name ?? 'INT';
  const textType = types.find((t) => t.group === 'text')?.name ?? 'VARCHAR';
  const [cols, setCols] = useState<ColDraft[]>(() => [
    { key: keySeq++, name: 'id', baseType: defaultIntType, params: '', custom: '', nullable: false, primaryKey: true, defaultKind: 'none', defaultValue: '' },
    {
      key: keySeq++,
      name: 'name',
      baseType: textType,
      params: types.find((t) => t.name === textType)?.defaultParams ?? '',
      custom: '',
      nullable: true,
      primaryKey: false,
      defaultKind: 'none',
      defaultValue: '',
    },
  ]);
  const [preview, setPreview] = useState<BuiltStatement | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [createPriv, setCreatePriv] = useState<string | null>(null);

  // Top-level containers (databases / catalogs)
  useEffect(() => {
    api.meta
      .children(profileId, null)
      .then((n) => setTopOptions(n.map((x) => x.name)))
      .catch(() => setTopOptions([]));
  }, [profileId, refreshVersion]);

  // Schemas of the chosen top-level container
  useEffect(() => {
    if (!hasSchema || !top) return;
    const node: TreeNode = { kind: topLevel, name: top, path: {}, hasChildren: true };
    api.meta
      .children(profileId, node)
      .then((n) => setSchemaOptions(n.map((x) => x.name)))
      .catch(() => setSchemaOptions([]));
  }, [profileId, top, hasSchema, topLevel, refreshVersion]);

  const object: ObjectPath = useMemo(
    () => ({
      ...(topLevel === 'catalog' ? { catalog: top || undefined } : { database: top || undefined }),
      ...(hasSchema ? { schema: schema || undefined } : {}),
      name: name.trim(),
    }),
    [top, schema, name, topLevel, hasSchema],
  );

  const spec: CreateTableSpec = useMemo(
    () => ({
      object,
      ifNotExists,
      columns: cols.map(
        (c): ColumnSpec => ({
          name: c.name.trim(),
          type: fullType(c, types),
          nullable: c.nullable,
          primaryKey: c.primaryKey,
          default: c.defaultKind === 'none' ? { kind: 'none' } : { kind: c.defaultKind, value: c.defaultValue },
        }),
      ),
    }),
    [object, ifNotExists, cols, types],
  );

  // Live SQL preview (the main process builds the statement; the same builder is used to run it).
  useEffect(() => {
    const t = setTimeout(() => {
      api.write
        .previewCreate(profileId, spec)
        .then(setPreview)
        .catch((e) => setError(errorInfo(e)));
    }, 150);
    return () => clearTimeout(t);
  }, [profileId, spec]);

  // Create privilege hint (only where the database can answer)
  useEffect(() => {
    if (!top || (hasSchema && !schema)) return;
    api.meta
      .privileges(profileId, { ...object, name: object.name || '__earthql_probe__' })
      .then((p) => setCreatePriv(p.create === 'no' ? 'This account cannot create tables here; the database will reject the statement.' : null))
      .catch(() => setCreatePriv(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, top, schema, refreshVersion]);

  const upd = (key: number, patch: Partial<ColDraft>) => setCols((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const move = (key: number, d: -1 | 1) =>
    setCols((cs) => {
      const i = cs.findIndex((c) => c.key === key);
      const j = i + d;
      if (j < 0 || j >= cs.length) return cs;
      const out = [...cs];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  async function create() {
    setRunning(true);
    setError(null);
    try {
      const r = await api.write.create(profileId, spec);
      if (r.status !== 'ok') {
        if (r.error) {
          noteError(profileId, r.error);
          setError(r.error);
        }
        setConfirm(false);
        return;
      }
      const containerPath: Partial<ObjectPath> = { catalog: object.catalog, database: object.database, schema: object.schema };
      refreshTree(profileId, containerPath);
      toast('ok', `Created ${describePath(object)}. Use “Insert rows” on the Data tab to add data.`);
      closeTab(tabId);
      openTab({ kind: 'table', profileId, object, objectKind: 'table', initialView: 'structure' });
    } catch (e) {
      setError(errorInfo(e));
      setConfirm(false);
    } finally {
      setRunning(false);
    }
  }

  if (!conn || !profile || !caps) return null;
  const canReview = preview && preview.errors.length === 0 && name.trim() && (!hasSchema || schema) && top;

  return (
    <>
      <ContextBar profileId={profileId} target={describePath(object) || '(new table)'} kindLabel="Create table" />
      <div className="scroll" style={{ flex: 1, padding: '16px 20px 30px' }}>
        <div className="form" style={{ maxWidth: 760 }}>
          <span className="lbl">{topLevel === 'catalog' ? 'Catalog' : 'Database'}</span>
          <select className="select" value={top} onChange={(e) => (setTop(e.target.value), setSchema(''))}>
            {!top && <option value="">Choose…</option>}
            {[...new Set([top, ...topOptions].filter(Boolean))].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          {hasSchema && (
            <>
              <span className="lbl">Schema</span>
              <select className="select" value={schema} onChange={(e) => setSchema(e.target.value)}>
                {!schema && <option value="">Choose…</option>}
                {[...new Set([schema, ...schemaOptions].filter(Boolean))].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </>
          )}
          <span className="lbl">Table name</span>
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="new_table" autoFocus />
          <span />
          <label className="check">
            <input type="checkbox" checked={ifNotExists} onChange={(e) => setIfNotExists(e.target.checked)} /> Skip if a table with this name already exists
          </label>
        </div>
        {createPriv && <div className="banner" style={{ marginTop: 12, borderRadius: 6 }}>{createPriv}</div>}

        <div className="row" style={{ margin: '22px 0 8px' }}>
          <b>Columns</b>
          <span className="spacer" />
          <button
            className="btn small"
            onClick={() =>
              setCols((cs) => [
                ...cs,
                { key: keySeq++, name: '', baseType: textType, params: types.find((t) => t.name === textType)?.defaultParams ?? '', custom: '', nullable: true, primaryKey: false, defaultKind: 'none', defaultValue: '' },
              ])
            }
          >
            ＋ Add column
          </button>
        </div>
        <table className="list">
          <thead>
            <tr>
              <th style={{ width: 52 }} />
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              {caps.primaryKey && <th>Primary key</th>}
              <th>Default</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cols.map((c, i) => {
              const t = types.find((x) => x.name === c.baseType);
              return (
                <tr key={c.key}>
                  <td>
                    <button className="btn small ghost" disabled={i === 0} onClick={() => move(c.key, -1)}>
                      ↑
                    </button>
                    <button className="btn small ghost" disabled={i === cols.length - 1} onClick={() => move(c.key, 1)}>
                      ↓
                    </button>
                  </td>
                  <td>
                    <input className="input mono" style={{ width: 160 }} value={c.name} placeholder="column_name" onChange={(e) => upd(c.key, { name: e.target.value })} />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <select
                        className="select"
                        value={c.baseType}
                        onChange={(e) => {
                          const nt = types.find((x) => x.name === e.target.value);
                          upd(c.key, { baseType: e.target.value, params: nt?.defaultParams ?? '' });
                        }}
                      >
                        {types.map((x) => (
                          <option key={x.name} value={x.name}>
                            {x.name}
                          </option>
                        ))}
                        <option value="__custom">Other…</option>
                      </select>
                      {c.baseType === '__custom' ? (
                        <input className="input mono" style={{ width: 150 }} value={c.custom} placeholder="e.g. numeric(20,4)" onChange={(e) => upd(c.key, { custom: e.target.value })} />
                      ) : t?.params ? (
                        <input
                          className="input mono"
                          style={{ width: 70 }}
                          value={c.params}
                          title={t.params === 'precision_scale' ? 'precision,scale' : t.params}
                          placeholder={t.params === 'precision_scale' ? 'p,s' : 'n'}
                          onChange={(e) => upd(c.key, { params: e.target.value })}
                        />
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <input type="checkbox" checked={c.nullable && !c.primaryKey} disabled={c.primaryKey} onChange={(e) => upd(c.key, { nullable: e.target.checked })} />
                  </td>
                  {caps.primaryKey && (
                    <td>
                      <input type="checkbox" checked={c.primaryKey} onChange={(e) => upd(c.key, { primaryKey: e.target.checked })} />
                    </td>
                  )}
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <select
                        className="select"
                        value={c.defaultKind}
                        disabled={!caps.columnDefaults}
                        onChange={(e) => upd(c.key, { defaultKind: e.target.value as ColumnDefault['kind'] })}
                      >
                        <option value="none">None</option>
                        <option value="literal">Value</option>
                        <option value="expression">Expression</option>
                      </select>
                      {c.defaultKind !== 'none' && (
                        <input
                          className="input mono"
                          style={{ width: 170 }}
                          value={c.defaultValue}
                          placeholder={c.defaultKind === 'literal' ? 'literal value' : 'e.g. CURRENT_TIMESTAMP'}
                          onChange={(e) => upd(c.key, { defaultValue: e.target.value })}
                        />
                      )}
                    </div>
                  </td>
                  <td>
                    <button className="btn small ghost" disabled={cols.length === 1} onClick={() => setCols((cs) => cs.filter((x) => x.key !== c.key))}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {caps.notes.length > 0 && (
          <ul className="muted small" style={{ paddingLeft: 18 }}>
            {caps.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <div className="row" style={{ margin: '20px 0 8px' }}>
          <b>SQL preview</b>
          <span className="muted small">Other object types (views, indexes…) can be created from the SQL editor.</span>
        </div>
        <pre className="sql">{preview?.sql ?? '…'}</pre>
        {preview && (preview.errors.length > 0 || preview.warnings.length > 0) && (
          <ul className="small" style={{ paddingLeft: 18 }}>
            {preview.errors.map((e) => (
              <li key={e} style={{ color: 'var(--danger)' }}>
                {e}
              </li>
            ))}
            {preview.warnings.map((w) => (
              <li key={w} style={{ color: 'var(--warn)' }}>
                {w}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <div style={{ marginTop: 12 }}>
            <ErrorView error={error} />
          </div>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          <span className="spacer" />
          <button className="btn" onClick={() => closeTab(tabId)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canReview} onClick={() => setConfirm(true)}>
            Create table…
          </button>
        </div>
      </div>
      {confirm && preview && (
        <Modal
          title="Create table"
          narrow
          onClose={() => !running && setConfirm(false)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" disabled={running} onClick={() => setConfirm(false)}>
                Back
              </button>
              <button className="btn primary" disabled={running} onClick={() => void create()}>
                {running ? <Spinner /> : null} Create on {profile.name}
              </button>
            </>
          }
        >
          <ConfirmTarget profile={profile} action="CREATE TABLE" target={describePath(object)} />
          <pre className="sql">{preview.sql}</pre>
        </Modal>
      )}
    </>
  );
}
