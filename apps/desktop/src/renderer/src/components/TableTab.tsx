import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canEditGridColumn,
  canEditGridInsertColumn,
  cellToText,
  checkRawCondition,
  describePath,
  gridPrimaryKey,
  gridRowId,
  gridInputCell,
  isGridDateTime,
  MAX_GRID_UPDATE_ROWS,
  type BrowseRequest,
  type BrowseResult,
  type BuiltStatement,
  type Cell,
  type ErrorInfo,
  type Filter,
  type FilterOp,
  type GridRowUpdate,
  type InsertCell,
  type ObjectKind,
  type ObjectPath,
  type ObjectPrivileges,
  type SectionStatus,
  type Sort,
  type TableStructure,
} from '@earthql/core';
import type { StructureEdit } from '../../../shared/table-actions';
import type { TableImportFormat } from '../../../shared/api';
import { api, errorInfo, uid } from '../api';
import type { GridRowsClipboard } from '../grid-clipboard';
import { gridChangesForSave, gridDraftRowCount, insertCell, newGridRow, pastedGridRows, stageGridDeletes } from '../grid-inserts';
import { parseSavedFilters, savedFiltersKey, type SavedFilter } from '../saved-filters';
import { noteError, profileOf, useApp } from '../store';
import { DataGrid, type GridChoice, type GridEditing, type TableGridActions } from './DataGrid';
import { ContextBar } from './ContextBar';
import { ErrorView, Modal, Spinner, StateView, formatDuration, plural } from './common';
import { ExportDialog } from './ExportDialog';
import { TableImportDialog } from './TableImportDialog';
import { useShortcuts } from './Shortcut';

interface OpDef {
  op: FilterOp;
  label: string;
  needsValue: boolean;
  /** Takes a second value (BETWEEN's upper bound). */
  second?: boolean;
  placeholder?: string;
}

/** Shown as one dropdown with a divider between groups. */
const OP_GROUPS: OpDef[][] = [
  [
    { op: '=', label: '=', needsValue: true },
    { op: '!=', label: '<>', needsValue: true },
    { op: '<', label: '<', needsValue: true },
    { op: '>', label: '>', needsValue: true },
    { op: '<=', label: '<=', needsValue: true },
    { op: '>=', label: '>=', needsValue: true },
  ],
  [
    { op: 'in', label: 'IN', needsValue: true, placeholder: 'value1, value2, …' },
    { op: 'not_in', label: 'NOT IN', needsValue: true, placeholder: 'value1, value2, …' },
  ],
  [
    { op: 'is_null', label: 'IS NULL', needsValue: false },
    { op: 'is_not_null', label: 'IS NOT NULL', needsValue: false },
  ],
  [
    { op: 'between', label: 'BETWEEN', needsValue: true, second: true },
    { op: 'not_between', label: 'NOT BETWEEN', needsValue: true, second: true },
  ],
  [{ op: 'like', label: 'LIKE', needsValue: true, placeholder: 'pattern, e.g. %text%' }],
  [
    { op: 'contains', label: 'Contains', needsValue: true },
    { op: 'not_contains', label: 'Not contains', needsValue: true },
  ],
  [
    { op: 'contains_cs', label: 'Contains - Case sensitive', needsValue: true },
    { op: 'not_contains_cs', label: 'Not contains - Case sensitive', needsValue: true },
  ],
  [
    { op: 'starts_with', label: 'Has prefix', needsValue: true },
    { op: 'ends_with', label: 'Has suffix', needsValue: true },
  ],
  [
    { op: 'starts_with_cs', label: 'Has prefix - Case sensitive', needsValue: true },
    { op: 'ends_with_cs', label: 'Has suffix - Case sensitive', needsValue: true },
  ],
];
const OPS = OP_GROUPS.flat();

const PAGE_SIZES = [50, 100, 200, 500, 1000];

/** Value of the "Raw SQL" entry in a filter row's column dropdown (the filter itself is op 'raw', no column). */
const RAW_SQL = '::raw-sql::';

type DraftFilter = Filter & { applied?: Filter };

/** Whether a row still matches what was applied — editing an applied row makes its button say Apply again. */
const sameFilter = (a: Filter, b: Filter) =>
  a.column === b.column && a.op === b.op && (a.value ?? '') === (b.value ?? '') && (a.value2 ?? '') === (b.value2 ?? '') && (a.join ?? 'and') === (b.join ?? 'and');

export function TableTab({
  tabId,
  profileId,
  object,
  objectKind,
  initialView,
  initialFilters,
  active,
  refreshVersion = 0,
}: {
  tabId: string;
  profileId: string;
  object: ObjectPath;
  objectKind: ObjectKind;
  initialView?: 'data' | 'structure';
  initialFilters?: Filter[];
  active: boolean;
  refreshVersion?: number;
}) {
  const view = initialView ?? 'data';
  const setTableView = useApp((s) => s.setTableView);
  const setView = (next: 'data' | 'structure') => setTableView(tabId, next);
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [structureErr, setStructureErr] = useState<ErrorInfo | null>(null);
  const [privileges, setPrivileges] = useState<ObjectPrivileges | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const conn = useApp((s) => s.connections[profileId]);
  const profile = profileOf(profileId)?.profile;

  const loadStructure = useCallback(
    async (refresh = false) => {
      setStructureErr(null);
      try {
        setStructure(await api.meta.structure(profileId, object, refresh));
      } catch (e) {
        const info = errorInfo(e);
        noteError(profileId, info);
        setStructureErr(info);
      }
    },
    [profileId, object],
  );

  useEffect(() => {
    void loadStructure();
    api.meta
      .privileges(profileId, object)
      .then(setPrivileges)
      .catch(() => setPrivileges({ select: 'unknown', insert: 'unknown' }));
  }, [loadStructure, profileId, object]);

  const [edits, setEdits] = useState<StructureEdit[]>([]);
  const previousRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (previousRefresh.current === refreshVersion) return;
    previousRefresh.current = refreshVersion;
    if (!useApp.getState().unsavedStructureTabs[tabId]) {
      setEdits([]);
      setSaveError(null);
    }
    void loadStructure(true);
  }, [loadStructure, refreshVersion, tabId]);

  const [savingStructure, setSavingStructure] = useState(false);
  const hasStructureChanges = edits.length > 0;
  useEffect(() => {
    if (!hasStructureChanges) return;
    useApp.setState((state) => ({ unsavedStructureTabs: { ...state.unsavedStructureTabs, [tabId]: savingStructure ? 'saving' : true } }));
    return () => useApp.setState((state) => {
      const unsavedStructureTabs = { ...state.unsavedStructureTabs };
      delete unsavedStructureTabs[tabId];
      return { unsavedStructureTabs };
    });
  }, [tabId, hasStructureChanges, savingStructure]);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [saveError, setSaveError] = useState<ErrorInfo | null>(null);
  const canEditStructure = conn?.status === 'connected' && structure?.kind === 'table'
    && structure.columnsStatus.state === 'ok' && (profile?.driver === 'postgres' || profile?.driver === 'mysql');
  const saveStructure = useCallback(async (confirmed = false) => {
    if (!canEditStructure || !edits.length || savingStructure) return;
    if (useApp.getState().gridDrafts[tabId]) {
      setSaveError({ category: 'config', message: 'Save or discard pending Data edits before changing the structure.' });
      return;
    }
    if (!confirmed && edits.some((edit) => edit.kind.startsWith('drop'))) { setConfirmDrop(true); return; }
    setConfirmDrop(false);
    setSavingStructure(true);
    setSaveError(null);
    try {
      await api.tableActions.saveStructure(profileId, object, edits);
      setEdits([]);
      setDataVersion((version) => version + 1);
      await loadStructure(true);
      useApp.getState().toast('ok', 'Table structure saved.');
    } catch (failure) {
      setSaveError(errorInfo(failure));
    } finally {
      setSavingStructure(false);
    }
  }, [canEditStructure, edits, savingStructure, tabId, profileId, object, loadStructure]);

  useEffect(() => {
    if (!active || view !== 'structure') return;
    return window.earthqlBridge.on('menu:command', (command) => {
      if (command === 'save' && !confirmDrop) void saveStructure();
    });
  }, [active, view, saveStructure, confirmDrop]);

  if (!conn || !profile) return <StateView title="Not connected" />;

  // Why Insert is (not) available — capability, object type, then the account's privilege.
  const kind = structure?.kind ?? objectKind;
  let insertBlocked: string | null = null;
  if (!conn.capabilities.insert) insertBlocked = 'This driver does not support inserting from the form.';
  else if (kind === 'view') insertBlocked = 'This is a view. Insert rows into its base table instead.';
  else if (privileges?.insert === 'no') insertBlocked = privileges.reason ?? 'This account has no INSERT privilege on this table.';
  else if (structure && structure.columnsStatus.state !== 'ok') insertBlocked = 'The column list could not be read, so the form cannot be built.';

  return (
    <>
      <ContextBar profileId={profileId} target={describePath(object)} kindLabel={kind === 'view' ? 'View' : 'Table'}>
        <div className="subtabs">
          <button className={view === 'data' ? 'on' : ''} onClick={() => setView('data')}>
            Data
          </button>
          <button className={view === 'structure' ? 'on' : ''} onClick={() => setView('structure')}>
            Structure
          </button>
        </div>
      </ContextBar>
      {view === 'data' ? (
        <DataView
          key={dataVersion}
          initialFilters={initialFilters}
          tabId={tabId}
          profileId={profileId}
          object={object}
          structure={structure}
          insertBlocked={insertBlocked}
          insertUnknown={privileges?.insert === 'unknown'}
          editBlocked={privileges?.update === 'no' ? 'This account has no UPDATE privilege on this table.' : null}
          active={active}
          refreshVersion={refreshVersion}
        />
      ) : (
        <>
          {canEditStructure && structure ? <StructureEditor types={conn.capabilities.types} postgres={profile.driver === 'postgres'} structure={structure} edits={edits} onChange={setEdits}
            saving={savingStructure} error={saveError} onSave={() => void saveStructure()} onRefresh={() => void useApp.getState().refreshTab(tabId)} />
            : <StructureView structure={structure} error={structureErr} onRefresh={() => void useApp.getState().refreshTab(tabId)} />}
          {confirmDrop && <Modal narrow title="Drop structure items?" onClose={() => setConfirmDrop(false)} footer={<>
            <button className="btn" onClick={() => setConfirmDrop(false)}>Cancel</button>
            <button className="btn danger" onClick={() => void saveStructure(true)}>Save structure</button>
          </>}>
            Saving will drop the selected structure items. Dropping columns also removes their data.
          </Modal>}
        </>
      )}
    </>
  );
}

function DataView({
  initialFilters = [],
  tabId,
  profileId,
  object,
  structure,
  insertBlocked,
  insertUnknown,
  editBlocked,
  active,
  refreshVersion,
}: {
  initialFilters?: Filter[];
  tabId: string;
  profileId: string;
  object: ObjectPath;
  structure: TableStructure | null;
  insertBlocked: string | null;
  insertUnknown: boolean;
  editBlocked: string | null;
  active: boolean;
  refreshVersion: number;
}) {
  const sc = useShortcuts();
  // Each row remembers a snapshot of what was last applied (`applied`); `filters` is the list of those
  // snapshots, kept as its own state so typing in a row does not re-run the query.
  const [filters, setFilters] = useState<Filter[]>(initialFilters);
  const [draftFilters, setDraftFilters] = useState<DraftFilter[]>(() => initialFilters.map((f) => ({ ...f, applied: f })));
  const filterPanel = useRef<HTMLDivElement>(null);
  const [focusFilter, setFocusFilter] = useState(0);
  const [sort, setSort] = useState<Sort | undefined>();
  const savedProfileId = useApp((s) => s.connections[profileId]?.profileId ?? profileId);
  const storageKey = savedFiltersKey(savedProfileId, object);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [savedFiltersError, setSavedFiltersError] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState('');
  const [filterName, setFilterName] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [focusCell, setFocusCell] = useState<{ row: number; column: number; version: number }>();
  const [showExport, setShowExport] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [sqlPreview, setSqlPreview] = useState<BuiltStatement | null>(null);
  const [sqlError, setSqlError] = useState<ErrorInfo | null>(null);
  const lastBrowse = useRef<BrowseRequest | null>(null);
  const [importFormat, setImportFormat] = useState<TableImportFormat | null>(null);
  const [gridEpoch, setGridEpoch] = useState(0);
  const draft = useApp((s) => s.gridDrafts[tabId]);
  const setDraft = useApp((s) => s.setGridDraft);
  const toast = useApp((s) => s.toast);
  useEffect(() => {
    try {
      setSavedFilters(parseSavedFilters(localStorage.getItem(storageKey)));
      setSavedFiltersError(false);
      setSelectedFilter('');
    } catch (error) {
      setSavedFilters([]);
      setSavedFiltersError(true);
      toast('error', `Saved filters could not be loaded: ${errorInfo(error).message}`);
    }
  }, [storageKey, toast]);
  const driver = profileOf(profileId)?.profile.driver;
  const status = useApp((s) => s.connections[profileId]?.status);
  const editable = useMemo(() => editBlocked || !structure?.gridUpdate || status === 'lost' ? null : gridPrimaryKey(structure), [editBlocked, structure, status]);
  const rowKeys = useMemo(() => {
    const identity = structure?.kind === 'table' ? gridPrimaryKey(structure) : null;
    if (!result || !identity) return [];
    const indexes = identity.map((column) => result.columns.findIndex((current) => current.name === column.name));
    if (indexes.some((index) => index < 0)) return [];
    return result.rows.map((row) => {
      const values = indexes.map((index) => row[index]);
      if (values.some((value) => value == null || typeof value === 'object')) return null;
      return identity.map(({ name }, index) => ({ column: name, value: cellToText(values[index]) }));
    });
  }, [result, structure]);
  const displayedRows = useMemo(() => result ? [...result.rows.map((row, index) => {
    const key = rowKeys[index];
    const changes = key && draft?.rows[gridRowId(key)]?.changes;
    if (!changes) return row;
    const copy = [...row];
    for (const change of changes) {
      const column = result.columns.findIndex(({ name }) => name === change.column);
      if (column >= 0) copy[column] = change.value;
    }
    return copy;
  }), ...(draft?.inserts ?? []).map(({ values }) => result.columns.map(({ name }): Cell => {
    const cell = values[name];
    return cell?.kind === 'value' ? cell.value : null;
  }))] : [], [result, rowKeys, draft]);

  const rowCount = gridDraftRowCount(draft);
  const deleteCount = Object.keys(draft?.deletes ?? {}).length;
  const isDeletedRow = (row: number) => !!rowKeys[row] && !!draft?.deletes?.[gridRowId(rowKeys[row])];
  const saving = !!draft?.saving;
  const unknownOutcome = draft?.error?.category === 'outcome_unknown';

  const load = useCallback(async () => {
    const request = { object, filters, sort, offset, pageSize };
    lastBrowse.current = request;
    setFocusCell(undefined);
    setShowSql(false);
    setSqlPreview(null);
    setSqlError(null);
    setLoading(true);
    setError(null);
    try {
      const response = await api.data.browse(profileId, request);
      if (lastBrowse.current !== request) return;
      setResult(response);
      setGridEpoch((previous) => previous + 1);
    } catch (e) {
      if (lastBrowse.current !== request) return;
      const info = errorInfo(e);
      noteError(profileId, info);
      setResult(null);
      setError(info);
    } finally {
      if (lastBrowse.current === request) setLoading(false);
    }
  }, [profileId, object, filters, sort, offset, pageSize]);

  async function openSql() {
    const request = lastBrowse.current;
    if (!request) return;
    setShowSql(true);
    setSqlPreview(null);
    setSqlError(null);
    if (result && !error) {
      setSqlPreview({ sql: result.sql, params: result.params, target: describePath(request.object), errors: [], warnings: [] });
      return;
    }
    try {
      const statement = await api.data.previewBrowse(profileId, request);
      if (lastBrowse.current === request) setSqlPreview(statement);
    } catch (failure) {
      if (lastBrowse.current !== request) return;
      const info = errorInfo(failure);
      noteError(profileId, info);
      setSqlError(info);
    }
  }

  const saveChanges = useCallback(async () => {
    const current = useApp.getState().gridDrafts[tabId];
    if (!current || current.saving || current.error?.category === 'outcome_unknown' || loading || showExport || showSql ||
      ((Object.keys(current.rows).length > 0 || Object.keys(current.deletes ?? {}).length > 0) && !editable) || (current.inserts?.length && insertBlocked)) return;
    setDraft(tabId, { ...current, error: undefined, saving: true });
    try {
      if (Object.keys(current.deletes ?? {}).length && (structure?.gridSaveVersion ?? 0) < 2) {
        const metadata = await api.meta.structure(profileId, object, true);
        if ((metadata.gridSaveVersion ?? 0) < 2) {
          const info: ErrorInfo = { category: 'unsupported', message: 'The running app is too old to save staged deletions. Preserve your pending rows and restart the app before saving. No changes were sent to the database.' };
          noteError(profileId, info);
          setDraft(tabId, { ...current, saving: false, error: info });
          return;
        }
      }
      const update = await api.write.saveGrid(profileId, object, gridChangesForSave(structure?.columns ?? [], {
        updates: Object.values(current.rows), inserts: current.inserts?.map(({ values }) => values) ?? [],
        deletes: Object.values(current.deletes ?? {}),
      }));
      if (update.status !== 'ok') {
        setDraft(tabId, { ...current, saving: false, error: update.error ?? { category: 'unknown', message: 'The database did not confirm the changes.' } });
        if (update.error) noteError(profileId, update.error);
        return;
      }
      setDraft(tabId, undefined);
      toast('ok', `Saved ${update.rowsAffected ?? rowCount} ${(update.rowsAffected ?? rowCount) === 1 ? 'row' : 'rows'}.`);
      await load();
    } catch (err) {
      const info = errorInfo(err);
      noteError(profileId, info);
      setDraft(tabId, { ...current, saving: false, error: info });
    }
  }, [editable, insertBlocked, load, loading, object, profileId, rowCount, setDraft, showExport, showSql, structure, tabId, toast]);

  useEffect(() => {
    void load();
  }, [load, refreshVersion]);

  useEffect(() => {
    if (!active) return;
    const off = window.earthqlBridge.on('menu:command', (cmd) => {
      if (cmd === 'save') void saveChanges();
    });
    return off;
  }, [active, saveChanges]);

  function stageRows(values: Record<string, InsertCell>[]) {
    const current = useApp.getState().gridDrafts[tabId];
    if (!structure || !result || insertBlocked || loading || current?.saving || current?.error?.category === 'outcome_unknown') return;
    const count = gridDraftRowCount(current);
    if (count + values.length > MAX_GRID_UPDATE_ROWS) {
      toast('error', `Save up to ${MAX_GRID_UPDATE_ROWS} changed rows at a time.`);
      return;
    }
    const inserts = [...(current?.inserts ?? []), ...values.map((row) => ({ id: uid(), values: row }))];
    setDraft(tabId, { rows: current?.rows ?? {}, inserts, deletes: current?.deletes });
    const first = structure.columns.findIndex((column) => canEditGridInsertColumn(column) &&
      result.columns.some(({ name }) => name === column.name));
    const column = result.columns.findIndex(({ name }) => name === structure.columns[first]?.name);
    setFocusCell((previous) => ({
      row: result.rows.length + (current?.inserts?.length ?? 0), column: Math.max(0, column), version: (previous?.version ?? 0) + 1,
    }));
  }

  function openAddRow() {
    if (structure) stageRows([newGridRow(structure.columns)]);
  }

  function openDuplicate(rowIndexes: number[]) {
    if (!result || !structure) return;
    stageRows(rowIndexes.map((row) => newGridRow(structure.columns,
      draft?.inserts?.[row - result.rows.length]?.values ??
      Object.fromEntries(result.columns.map((column, i): [string, InsertCell] => {
        const expression = cellExpression(row, i);
        return [column.name, expression === 'now' || expression === 'default' ? { kind: expression } : insertCell(displayedRows[row]?.[i] ?? null)];
      })), true)));
  }

  function pasteRows(clipboard: GridRowsClipboard) {
    if (!structure || !result) return;
    try {
      stageRows(pastedGridRows(structure.columns, result.columns.map(({ name }) => name), clipboard));
    } catch (failure) {
      toast('error', errorInfo(failure).message);
    }
  }

  function deleteRows(rowIndexes: number[]) {
    const current = useApp.getState().gridDrafts[tabId];
    if (!result || loading || current?.saving || current?.error?.category === 'outcome_unknown') return;
    const persisted = rowIndexes.filter((row) => row < result.rows.length);
    const keys = persisted.map((r) => rowKeys[r]).filter((k): k is NonNullable<(typeof rowKeys)[number]> => !!k);
    if (keys.length !== persisted.length) {
      toast('error', 'These rows cannot be identified by primary key.');
      return;
    }
    const ids = rowIndexes.flatMap((row) => current?.inserts?.[row - result.rows.length]?.id ?? []);
    const next = stageGridDeletes(current, keys, ids);
    if (gridDraftRowCount(next) > MAX_GRID_UPDATE_ROWS) {
      toast('error', `Save up to ${MAX_GRID_UPDATE_ROWS} changed rows at a time.`);
      return;
    }
    setDraft(tabId, next);
    setFocusCell(undefined);
    if (ids.length) setGridEpoch((previous) => previous + 1);
  }

  function onQuickFilter(column: string, op: FilterOp, value?: string) {
    const f: Filter = { column, op, value, join: 'and' };
    commitFilters([...draftFilters, { ...f, applied: f }]);
  }

  const gridColumns = useMemo(() => result?.columns.map(({ name }) => structure?.columns.find((column) => column.name === name)) ?? [], [result, structure]);
  function cellExpression(row: number, col: number) {
    const name = result?.columns[col]?.name;
    if (!name) return undefined;
    const insert = draft?.inserts?.[row - (result?.rows.length ?? 0)];
    if (insert) return insert.values[name]?.kind;
    const key = rowKeys[row];
    return key ? draft?.rows[gridRowId(key)]?.changes.find((change) => change.column === name)?.expression : undefined;
  }

  const gridEditing: GridEditing = {
    choices: (row, col) => {
      const column = gridColumns[col];
      const values: GridChoice[] = [];
      if (column && isGridDateTime(column)) return [
        { label: 'DEFAULT', value: null, expression: 'default', disabled: !gridEditing.canDefault?.(row, col) },
        { label: 'NULL', value: null, disabled: column.nullable === false },
        { label: 'NOW()', value: null, expression: 'now' },
      ];
      if (column && /^(bool|boolean|bit)$/i.test(column.type.trim())) {
        const bit = /^bit$/i.test(column.type.trim());
        values.push({ label: 'True', value: bit ? '1' : 'true' }, { label: 'False', value: bit ? '0' : 'false' });
      }
      if (column?.nullable === true) values.push({ label: 'NULL', value: null });
      return values;
    },
    canEdit: (row, col) => !saving && !loading && !unknownOutcome && !isDeletedRow(row) && !!gridColumns[col] &&
      (row >= (result?.rows.length ?? 0) ? !insertBlocked && canEditGridInsertColumn(gridColumns[col]) :
        !!editable && !!rowKeys[row] && canEditGridColumn(gridColumns[col], editable)),
    nullable: (col) => gridColumns[col]?.nullable !== false,
    isDefault: (row, col) => cellExpression(row, col) === 'default',
    isNow: (row, col) => cellExpression(row, col) === 'now',
    canDefault: (row, col) => gridEditing.canEdit(row, col) &&
      (row >= (result?.rows.length ?? 0) || (!!gridColumns[col] && isGridDateTime(gridColumns[col]))),
    setDefault: (row, col) => changeGridCell(row, col, null, 'default'),
    setNow: (row, col) => changeGridCell(row, col, null, 'now'),
    changed: (row, col) => {
      const key = rowKeys[row];
      return !!key && !!draft?.rows[gridRowId(key)]?.changes.some((change) => change.column === result?.columns[col]?.name);
    },
    change: changeGridCell,
  };

  function changeGridCell(row: number, col: number, value: string | null, expression?: 'default' | 'now') {
    const key = rowKeys[row];
    const column = gridColumns[col];
    const current = useApp.getState().gridDrafts[tabId];
    if (!column || !result || !gridEditing.canEdit(row, col) || current?.saving) return;
    if (expression === undefined && gridInputCell(column, value).kind === 'now') {
      expression = 'now';
      value = null;
    }
    if (row >= result.rows.length) {
      changeInsertCell(row, col, expression ? { kind: expression } : value === null ? { kind: 'null' } : { kind: 'value', value });
      return;
    }
    if (!key) return;
    const id = gridRowId(key);
    const originalCell = result.rows[row][col];
    const before = current?.rows[id];
    if (!before && gridDraftRowCount(current) >= MAX_GRID_UPDATE_ROWS) {
      toast('info', `Save up to ${MAX_GRID_UPDATE_ROWS} rows at a time.`);
      return;
    }
    const existing = before?.changes.find((cell) => cell.column === column.name);
    const original = existing ? existing.original : originalCell === null ? null : cellToText(originalCell);
    const changes = (before?.changes ?? []).filter((cell) => cell.column !== column.name);
    if (expression || value !== original) changes.push({ column: column.name, original, value, ...(expression ? { expression } : {}) });
    const rows: Record<string, GridRowUpdate> = { ...current?.rows };
    if (changes.length) rows[id] = { key, changes };
    else delete rows[id];
    setDraft(tabId, Object.keys(rows).length || current?.inserts?.length || Object.keys(current?.deletes ?? {}).length ?
      { rows, inserts: current?.inserts, deletes: current?.deletes } : undefined);
  }

  function changeInsertCell(row: number, col: number, value: InsertCell) {
    const current = useApp.getState().gridDrafts[tabId];
    const name = result?.columns[col]?.name;
    const index = row - (result?.rows.length ?? 0);
    if (!name || !current?.inserts?.[index] || !gridEditing.canEdit(row, col)) return;
    setDraft(tabId, { rows: current.rows, deletes: current.deletes, inserts: current.inserts.map((insert, i) =>
      i === index ? { ...insert, values: { ...insert.values, [name]: value } } : insert) });
  }

  const columnNames = structure?.columns.map((c) => c.name) ?? result?.columns.map((c) => c.name) ?? [];

  const toggleSort = (column: string) => {
    setOffset(0);
    setSort((s) => (s?.column !== column ? { column, dir: 'asc' } : s.dir === 'asc' ? { column, dir: 'desc' } : undefined));
  };

  const addFilter = () => setDraftFilters((current) => [...current, { column: columnNames[0] ?? '', op: '=', value: '' }]);
  useEffect(() => {
    if (!active) return;
    function openFilter(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'f' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      setDraftFilters((current) => current.length ? current : [{ column: columnNames[0] ?? '', op: '=', value: '' }]);
      setFocusFilter((value) => value + 1);
    }
    window.addEventListener('keydown', openFilter);
    return () => window.removeEventListener('keydown', openFilter);
  }, [active, columnNames]);
  useEffect(() => {
    if (!focusFilter) return;
    const firstRow = filterPanel.current?.querySelector('.filter-row');
    (firstRow?.querySelector<HTMLInputElement>('input:not([type="checkbox"])') ?? firstRow?.querySelector('select'))?.focus();
  }, [focusFilter]);

  const validValues = (filter: Filter) => {
    const meta = OPS.find((op) => op.op === filter.op);
    return !meta?.needsValue || (!!filter.value && (!meta.second || !!filter.value2));
  };
  const isValidFilter = (filter: Filter) =>
    filter.op === 'raw'
      ? !!filter.value?.trim() && !checkRawCondition(filter.value)
      : !!filter.column && validValues(filter);
  const snapshotOf = ({ column, op, value, value2, join }: Filter): Filter => ({ column, op, value, value2, join });
  const isApplied = (f: DraftFilter) => !!f.applied && sameFilter(f.applied, f);
  function commitFilters(next: DraftFilter[]) {
    setDraftFilters(next);
    setFilters(next.flatMap((f) => (f.applied ? [f.applied] : [])));
    setOffset(0);
  }
  /** Applies exactly these rows (the others become un-applied) — what Apply All / Apply Checked do. */
  function applyOnly(items: readonly DraftFilter[]) {
    if (!items.some(isValidFilter)) return;
    commitFilters(draftFilters.map((f) => ({ ...f, applied: items.includes(f) && isValidFilter(f) ? snapshotOf(f) : undefined })));
  }
  /** Applies one row on top of whatever is already applied. */
  function applyRow(index: number) {
    if (!isValidFilter(draftFilters[index])) return;
    commitFilters(draftFilters.map((f, j) => (j === index ? { ...f, applied: snapshotOf(f) } : f)));
  }
  function toggleRow(index: number) {
    if (isApplied(draftFilters[index])) commitFilters(draftFilters.map((f, j) => (j === index ? { ...f, applied: undefined } : f)));
    else applyRow(index);
  }
  function removeRow(index: number) {
    const next = draftFilters.filter((_, j) => j !== index);
    if (draftFilters[index].applied) commitFilters(next);
    else setDraftFilters(next);
  }
  function changeJoin(index: number, join: 'and' | 'or') {
    const next = draftFilters.map((filter, i) => i === index ? {
      ...filter, join, applied: filter.applied ? { ...filter.applied, join } : undefined,
    } : filter);
    if (draftFilters[index].applied) commitFilters(next);
    else setDraftFilters(next);
  }
  function writeSavedFilters(update: (current: SavedFilter[]) => SavedFilter[]) {
    try {
      const next = update(parseSavedFilters(localStorage.getItem(storageKey)));
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSavedFilters(next);
      return true;
    } catch (error) {
      toast('error', `Saved filters could not be saved: ${errorInfo(error).message}`);
      return false;
    }
  }

  const page = Math.floor(offset / pageSize) + 1;
  const rowsShown = result?.rows.length ?? 0;

  const tableActions: TableGridActions = {
    onAddRow: insertBlocked || !structure || !result || loading || saving || unknownOutcome ? undefined : openAddRow,
    onDuplicateRows: insertBlocked || !structure || loading || saving || unknownOutcome ? undefined : openDuplicate,
    onPasteRows: insertBlocked || !structure || !result || loading || saving || unknownOutcome ? undefined : pasteRows,
    onDeleteRows: !saving && !loading && !unknownOutcome && (editable || draft?.inserts?.length) ? (rowIndexes) => void deleteRows(rowIndexes) : undefined,
    onQuickFilter: structure ? onQuickFilter : undefined,
    onImport: structure ? (format) => setImportFormat(format) : undefined,
    onFormatInsert: (cols, data) => api.query.rowsAsInsert(profileId, object, cols, data),
  };

  return (
    <>
      <div className="toolbar">
        <button
          className="btn small"
          onClick={addFilter} title="Add filter (⌘F)"
          disabled={columnNames.length === 0}
        >
          ＋ Filter
        </button>
        <button className="btn small" disabled={savedFiltersError || (!filters.length && !sort)} onClick={() => setFilterName('')}>Save filters…</button>
        {savedFilters.length > 0 && <>
          <select className="select" aria-label="Saved filters" value={selectedFilter} onChange={(event) => setSelectedFilter(event.target.value)}>
            <option value="">Saved filters…</option>
            {savedFilters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button className="btn small" disabled={!selectedFilter} onClick={() => {
            const item = savedFilters.find((saved) => saved.id === selectedFilter);
            if (!item) return;
            commitFilters(item.filters.map((filter) => ({ ...filter, applied: filter })));
            setSort(item.sort);
          }}>Load</button>
          <button className="btn small" disabled={!selectedFilter} onClick={() => {
            if (writeSavedFilters((current) => current.filter((item) => item.id !== selectedFilter))) setSelectedFilter('');
          }}>Delete</button>
        </>}
        {filters.length > 0 && <span className="pill info">{filters.length} filter{filters.length > 1 ? 's' : ''} applied</span>}
        {sort && (
          <span className="pill info">
            Sorted by {sort.column} {sort.dir === 'asc' ? '▲' : '▼'}
            <span style={{ cursor: 'default', marginLeft: 4 }} onClick={() => setSort(undefined)}>
              ✕
            </span>
          </span>
        )}
        <span className="spacer" />
        {!!rowCount && <span className="pill info">{rowCount} pending {rowCount === 1 ? 'row' : 'rows'}</span>}
        {!!rowCount && <button className="btn small" disabled={saving} onClick={() => { setDraft(tabId, undefined); setFocusCell(undefined); setGridEpoch((i) => i + 1); if (unknownOutcome) void load(); }}>Discard</button>}
        <span title={draft?.inserts?.length || deleteCount ? sc.hint('Save pending rows', 'save') :
          editBlocked ?? (!editable ? 'Cell editing requires a supported transactional table with a primary key.' : sc.hint('Save cell edits', 'save'))}>
          <button className="btn small" disabled={!rowCount || saving || loading || !!unknownOutcome ||
            ((!!Object.keys(draft?.rows ?? {}).length || !!deleteCount) && !editable) || (!!draft?.inserts?.length && !!insertBlocked)} onClick={() => void saveChanges()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </span>
        <button className="btn small" onClick={() => void useApp.getState().refreshTab(tabId)} disabled={loading || saving} title={sc.hint('Refresh', 'refresh')}>
          ↻ Refresh
        </button>
        <button className="btn small" onClick={() => setShowExport(true)} disabled={!result}>
          Export CSV…
        </button>
        <span title={insertBlocked ?? (insertUnknown ? 'The database will check your privileges when you insert.' : '')}>
          <button className="btn small primary" disabled={!tableActions.onAddRow} onClick={openAddRow}>
            ＋ Add row
          </button>
        </span>
      </div>
      {draft?.error && <ErrorView error={draft.error} compact />}
      {filterName !== null && <Modal title="Save filters" narrow onClose={() => setFilterName(null)}>
        <form onSubmit={(event) => {
          event.preventDefault();
          const name = filterName.trim();
          if (!name) return;
          const item = { id: uid(), name, filters: filters.map(snapshotOf), sort };
          if (writeSavedFilters((current) => [...current, item])) { setSelectedFilter(item.id); setFilterName(null); }
        }}>
          <label>Name<input className="input" style={{ width: '100%', marginTop: 6 }} autoFocus value={filterName}
            onChange={(event) => setFilterName(event.target.value)} /></label>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="btn" onClick={() => setFilterName(null)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!filterName.trim()}>Save</button>
          </div>
        </form>
      </Modal>}
      {insertBlocked && (
        <div className="banner" style={{ background: 'var(--bg-sunken)', borderBottomColor: 'var(--line)' }}>
          <span className="muted">Insert unavailable:</span> {insertBlocked}
        </div>
      )}

      {draftFilters.length > 0 && (
        <div className="filters" ref={filterPanel}>
          {draftFilters.map((f, i) => {
            const raw = f.op === 'raw';
            const meta = OPS.find((o) => o.op === f.op);
            const rawProblem = raw && f.value?.trim() ? checkRawCondition(f.value) : null;
            const upd = (patch: Partial<DraftFilter>) => setDraftFilters((fs) => fs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <Fragment key={i}>
              {i > 0 && (
                <div className="filter-join" role="group" aria-label={`How filter ${i} and filter ${i + 1} combine`}>
                  <span className="filter-join-line" />
                  <div className="segmented tiny" title="AND is evaluated before OR">
                    <button type="button" aria-pressed={f.join !== 'or'} className={f.join !== 'or' ? 'on' : ''} onClick={() => changeJoin(i, 'and')}>AND</button>
                    <button type="button" aria-pressed={f.join === 'or'} className={f.join === 'or' ? 'on' : ''} onClick={() => changeJoin(i, 'or')}>OR</button>
                  </div>
                  <span className="filter-join-line" />
                </div>
              )}
              <div className="filter-row">
                <select
                  className="select filter-col"
                  value={raw ? RAW_SQL : f.column}
                  onChange={(e) => {
                    if (e.target.value === RAW_SQL) upd({ op: 'raw', column: '', value: raw ? f.value : '' });
                    else upd({ column: e.target.value, ...(raw ? { op: '=' as FilterOp, value: '' } : {}) });
                  }}
                >
                  {!f.column && !raw && <option value="" disabled>Select a column</option>}
                  <option value={RAW_SQL}>Raw SQL</option>
                  <hr />
                  {columnNames.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                {raw ? (
                  <input
                    className={`input mono filter-raw${rawProblem ? ' invalid' : ''}`}
                    value={f.value ?? ''}
                    placeholder="WHERE condition, e.g. status = 'open' AND total > 100"
                    aria-label="Raw SQL condition"
                    aria-invalid={!!rawProblem}
                    title={rawProblem ?? undefined}
                    onChange={(e) => upd({ value: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) applyRow(i); }}
                  />
                ) : (
                  <>
                    <select className="select filter-op" value={f.op} onChange={(e) => upd({ op: e.target.value as FilterOp })}>
                      {OP_GROUPS.map((group, gi) => (
                        <Fragment key={gi}>
                          {gi > 0 && <hr />}
                          {group.map((o) => (
                            <option key={o.op} value={o.op}>
                              {o.label}
                            </option>
                          ))}
                        </Fragment>
                      ))}
                    </select>
                    {meta?.needsValue && (
                      <>
                        <input
                          className="input mono filter-val"
                          value={f.value ?? ''}
                          placeholder={meta.second ? 'from' : (meta.placeholder ?? 'value')}
                          onChange={(e) => upd({ value: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) applyRow(i); }}
                        />
                        {meta.second && (
                          <>
                            <span className="muted small">and</span>
                            <input
                              className="input mono filter-val"
                              value={f.value2 ?? ''}
                              placeholder="to"
                              onChange={(e) => upd({ value2: e.target.value })}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) applyRow(i); }}
                            />
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
                <button
                  className={`btn small filter-apply${isApplied(f) ? ' applied' : ''}`}
                  aria-pressed={isApplied(f)}
                  title={isApplied(f) ? 'Applied — click to remove this filter' : undefined}
                  disabled={!isApplied(f) && !isValidFilter(f)}
                  onClick={() => toggleRow(i)}
                >
                  {isApplied(f) ? 'Applied' : 'Apply'}
                </button>
                <button className="btn small ghost" onClick={() => removeRow(i)}>
                  ✕
                </button>
              </div>
              </Fragment>
            );
          })}
          <div className="filter-row" style={{ marginTop: 2 }}>
            <button className="btn small" disabled={loading || !lastBrowse.current} onClick={() => void openSql()} title="Show SQL for the last applied filters">SQL</button>
            <span className="spacer" />
            <button
              className="btn small"
              onClick={() => commitFilters([])}
            >
              Clear
            </button>
            <button className="btn small primary" disabled={!draftFilters.some(isValidFilter)} onClick={() => applyOnly(draftFilters)}>Apply All</button>
          </div>
        </div>
      )}

      {error ? (
        <div style={{ padding: 16 }}>
          <ErrorView error={error} actions={<button className="btn small" onClick={() => void load()}>Try again</button>} />
        </div>
      ) : !result ? (
        <div className="state">
          <Spinner />
          <p>Loading rows…{driver === 'databricks' ? ' (a stopped SQL warehouse can take a few minutes to start)' : ''}</p>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', opacity: loading ? 0.55 : 1 }}>
          <DataGrid
            key={gridEpoch}
            columns={result.columns}
            rows={displayedRows}
            isNewRow={(row) => row >= result.rows.length}
            isDeletedRow={isDeletedRow}
            focusCell={focusCell}
            cellLinks={(row, column) => (structure?.constraints ?? []).flatMap((constraint) => {
              const target = constraint.foreignTarget;
              if (!target || !constraint.columns.includes(result.columns[column].name) || target.columns.length !== constraint.columns.length) return [];
              if (row >= result.rows.length) return [];
              const values = constraint.columns.map((name) => displayedRows[row]?.[result.columns.findIndex((item) => item.name === name)]);
              if (values.some((value) => value == null || typeof value === 'object')) return [];
              const initialFilters: Filter[] = target.columns.map((name, index) => ({ column: name, op: '=', value: cellToText(values[index]) }));
              return [{ label: `Open ${describePath(target.object)} · ${initialFilters.map((filter) => `${filter.column} = ${filter.value}`).join(', ')}`,
                open: () => useApp.getState().openTab({ kind: 'table', profileId, object: target.object, objectKind: 'table', initialView: 'data', initialFilters }) }];
            })}
            editing={gridEditing}
            sort={sort}
            onSort={toggleSort}
            rowOffset={result.offset}
            emptyText={filters.length ? 'No rows match the filter.' : offset > 0 ? 'No rows on this page.' : 'This table has no rows.'}
            onRefresh={() => void useApp.getState().refreshTab(tabId)}
            onExportPage={() => setShowExport(true)}
            tableActions={tableActions}
          />
        </div>
      )}

      <div className="statusbar table-statusbar">
        <div className="table-status-meta">
        {loading && <Spinner />}
        {result && (
          <>
            {result.hasMore ? <span className="pill info">More rows available</span> : <span className="pill">End of data</span>}
            <span className="muted">{formatDuration(result.durationMs)}</span>
          </>
        )}
        </div>
        {result && (<span className="table-row-count">
              {rowsShown === 0 ? 'No rows' : `Rows ${(result.offset + 1).toLocaleString()}–${(result.offset + rowsShown).toLocaleString()}`}
              {result.totalRows !== undefined && (rowsShown > 0 || result.totalRows !== '0')
                ? ` of ${BigInt(result.totalRows).toLocaleString()} rows`
                : ''}
              {!!draft?.inserts?.length && ` · ${plural(draft.inserts.length, 'pending insert')}`}
              {!!deleteCount && ` · ${plural(deleteCount, 'pending deletion')}`}
            </span>)}
        <div className="table-status-pagination">
        <span className="muted">Rows per page</span>
        <select
          className="select"
          style={{ height: 22 }}
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setOffset(0);
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <button className="btn small" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
          ‹ Prev
        </button>
        <span>Page {page}</span>
        <button className="btn small" disabled={!result?.hasMore || loading} onClick={() => setOffset(offset + pageSize)}>
          Next ›
        </button>
        </div>
      </div>

      {showSql && (
        <Modal title="Filter SQL" onClose={() => setShowSql(false)} footer={<button className="btn" onClick={() => setShowSql(false)}>Close</button>}>
          <div className="col">
            <span className="muted small">{error ? 'The request failed. This preview is rebuilt from the last submitted filters, sort and page.' : 'SQL executed for the last submitted filters, sort and page.'} Unapplied changes are not included.</span>
            {sqlError ? <ErrorView error={sqlError} /> : !sqlPreview ? <Spinner /> : <>
              <pre className="sql">{sqlPreview.sql}</pre>
              {sqlPreview.params.length > 0 && <>
                <b>Bound values</b>
                <div className="scroll" style={{ maxHeight: 180 }}>
                  <table className="list"><tbody>
                    {sqlPreview.params.map((param, i) => <tr key={i}>
                      <td className="mono muted">{driver === 'postgres' ? `$${i + 1}` : driver === 'mssql' ? `@p${i}` : driver === 'databricks' ? `:p${i}` : `? #${i + 1}`}</td>
                      <td className="mono">{param.value === null ? 'NULL' : param.value === '' ? <span className="emptystr">(empty text)</span> : param.value}</td>
                    </tr>)}
                  </tbody></table>
                </div>
              </>}
              {sqlPreview.errors.map((message, i) => <div key={i} style={{ color: 'var(--danger)' }}>{message}</div>)}
            </>}
          </div>
        </Modal>
      )}
      {importFormat && (
        <TableImportDialog
          profileId={profileId}
          object={object}
          format={importFormat}
          onClose={() => { setImportFormat(null); void load(); }}
        />
      )}
      {showExport && result && (
        <ExportDialog
          key={tabId}
          name={object.name}
          onClose={() => setShowExport(false)}
          options={[
            { id: 'page', label: `Current page (${result.rows.length.toLocaleString()} rows)`, scope: { kind: 'loaded', columns: result.columns, rows: result.rows } },
            {
              id: 'all',
              label: filters.length ? 'All rows matching the filter' : 'All rows in the table',
              detail: `Runs SELECT without paging${sort ? `, sorted by ${sort.column}` : ''} and streams every row to the file.`,
              scope: { kind: 'table', profileId, object, filters, sort },
            },
          ]}
        />
      )}
    </>
  );
}

function SectionState({ status, empty }: { status: SectionStatus; empty: string }) {
  if (status.state === 'empty') return <div className="tree-msg">{empty}</div>;
  if (status.state === 'denied')
    return (
      <div className="tree-msg" style={{ color: 'var(--warn)' }}>
        Cannot read — {status.message}
      </div>
    );
  if (status.state === 'unsupported') return <div className="tree-msg">Not supported — {status.message}</div>;
  return null;
}

function StructureEditor({ types, postgres, structure, edits, onChange, saving, error, onSave, onRefresh }: {
  types: import('@earthql/core').TypeOption[];
  postgres: boolean;
  structure: TableStructure;
  edits: StructureEdit[];
  onChange: (edits: StructureEdit[]) => void;
  saving: boolean;
  error: ErrorInfo | null;
  onSave: () => void;
  onRefresh: () => void;
}) {
  const names = structure.columns.flatMap(({ name }) => {
    const change = edits.find((edit) => (edit.kind === 'drop' || edit.kind === 'rename') && edit.column === name);
    return change?.kind === 'drop' ? [] : [change?.kind === 'rename' ? change.name : name];
  }).concat(edits.flatMap((edit) => edit.kind === 'add' && edit.name.trim() ? [edit.name.trim()] : []));
  function structureChoices(field: number, current: string) {
    if (field === 2) return ['YES', 'NO'];
    if (field !== 1) return [];
    const chosen = current.split(',').map((name) => name.trim()).filter(Boolean);
    return [...new Set([...names, ...names.filter((name) => !chosen.includes(name) && chosen.length).map((name) => [...chosen, name].join(', '))])];
  }
  return <div className="scroll structure-editor">
    <div className="row">
      {edits.length > 0 && <><span>Unsaved structure changes · ⌘S to save</span>
        <button className="btn small" disabled={saving} onClick={() => onChange([])}>Discard all</button></>}
      <span className="spacer" />
      <button className="btn small" disabled={saving} onClick={onRefresh}>Refresh</button>
      <button className="btn small primary" disabled={saving || !edits.length} onClick={onSave}>Save structure</button>
    </div>
    {error && <ErrorView error={error} />}
    <StructureGrid choicesForField={(field) => field === 1 ? types.map((type) => type.defaultParams ? `${type.name}(${type.defaultParams})` : type.name) : []} allowTypeChange={postgres} section="Column" headers={['Name', 'Type', 'Nullable', 'Default', 'Key', 'Comment']}
      source={structure.columns.map((c) => ({ name: c.name, values: [c.name, c.type, c.nullable === null ? '—' : c.nullable ? 'YES' : 'NO', c.defaultValue ?? '—', [c.isPrimaryKey && 'PK', c.isIdentity && 'identity'].filter(Boolean).join(' '), c.comment ?? ''], locked: false }))}
      edits={edits} onChange={onChange} saving={saving} />
    <StructureGrid choicesForField={structureChoices} section="Index" headers={['Name', 'Columns', 'Unique', 'Definition']}
      source={structure.indexes.map((i) => ({ name: i.name, values: [i.name, i.columns.join(', '), i.unique ? 'YES' : 'NO', i.definition ?? ''], locked: i.primary }))}
      edits={edits} onChange={onChange} saving={saving} />
    <StructureGrid choicesForField={structureChoices} section="Constraint" headers={['Name', 'Columns', 'Type', 'Definition / references']}
      source={structure.constraints.map((c) => ({ name: c.name, values: [c.name, c.columns.join(', '), c.type, c.definition ?? c.references ?? ''], locked: false }))}
      edits={edits} onChange={onChange} saving={saving} allowRename={postgres} />
  </div>;
}

function StructureGrid({ section, headers, source, edits, onChange, saving, choicesForField, allowRename = true, allowTypeChange = false }: {
  section: 'Column' | 'Index' | 'Constraint';
  headers: string[];
  source: { name: string; values: string[]; locked: boolean }[];
  edits: StructureEdit[];
  onChange: (edits: StructureEdit[]) => void;
  saving: boolean;
  choicesForField(field: number, current: string): string[];
  allowRename?: boolean;
  allowTypeChange?: boolean;
}) {
  const add = section === 'Column' ? 'add' : section === 'Index' ? 'addIndex' : 'addConstraint';
  const drop = section === 'Column' ? 'drop' : section === 'Index' ? 'dropIndex' : 'dropConstraint';
  const rename = section === 'Column' ? 'rename' : section === 'Index' ? 'renameIndex' : 'renameConstraint';
  const rows = source.flatMap((row) => {
    const change = edits.findIndex((edit) => (edit.kind === drop || edit.kind === rename)
      && ('column' in edit ? edit.column : 'name' in edit ? edit.name : '') === row.name);
    const edit = edits[change];
    if (edit?.kind === drop) return [];
    const name = edit?.kind === 'rename' ? edit.name : edit && 'next' in edit ? edit.next : row.name;
    const typeEdit = section === 'Column' ? edits.find((item) => item.kind === 'columnType' && (item.column === name || item.column === row.name)) : undefined;
    const values = [name, ...row.values.slice(1)];
    if (typeEdit?.kind === 'columnType') values[1] = typeEdit.type;
    return [{ ...row, values, change, fresh: false }];
  });
  for (const [change, edit] of edits.entries()) {
    if (edit.kind !== add) continue;
    const values = edit.kind === 'add' ? [edit.name, edit.type, 'YES', '', '', '']
      : 'columns' in edit ? [edit.name, edit.columns, edit.kind === 'addConstraint' ? 'UNIQUE' : edit.unique ? 'YES' : 'NO', ''] : [];
    rows.push({ name: edit.name, values, change, locked: false, fresh: true });
  }
  function newEdit(values: string[] = []): StructureEdit {
    if (add === 'add') return { kind: add, name: values[0] ?? '', type: values[1] ?? '' };
    return { kind: add, name: values[0] ?? '', columns: values[1] ?? '', unique: values[2]?.trim().toUpperCase() === 'YES' };
  }
  return <section className="structure-grid-section">
    <div className="row">
      <b>{section === 'Index' ? 'Indexes' : `${section}s`}</b>
      <button className="btn small" disabled={saving} onClick={() => onChange([...edits, newEdit()])}>＋ Add {section}</button>
    </div>
    <div className="structure-grid-content">
      <DataGrid expandRows columns={headers.map((name) => ({ name, type: '', kind: 'text' }))} rows={rows.map((row) => row.values)}
        emptyText={`No ${section.toLowerCase()} entries.`}
        editing={{
          canEdit: (index, col) => !saving && !!rows[index] && !rows[index].locked &&
            (rows[index].fresh ? col < 2 || (section === 'Index' && col === 2) : (col === 0 && allowRename) || (col === 1 && allowTypeChange)),
          choices: (index, field) => choicesForField(field, rows[index]?.values[field] ?? '').map((value) => ({ label: value, value })),
          nullable: () => false,
          changed: (index, col) => rows[index]?.fresh || (col === 0 && (rows[index]?.change ?? -1) >= 0),
          change: (index, col, value) => {
            const row = rows[index];
            if (!row || value === null) return;
            if (!row.fresh && col === 1 && allowTypeChange) {
              const column = row.name;
              const next = edits.filter((edit) => edit.kind !== 'columnType' || (edit.column !== row.name && edit.column !== column));
              const original = source.find((item) => item.name === row.name)?.values[1];
              onChange(value === original ? next : [{ kind: 'columnType', column, type: value }, ...next]);
              return;
            }
            if (!row.fresh && col === 0 && value === row.name) {
              if (row.change >= 0) onChange(edits.filter((_, position) => position !== row.change));
              return;
            }
            const values = [...row.values];
            values[col] = value;
            const edit: StructureEdit = row.fresh ? newEdit(values) : rename === 'rename'
              ? { kind: rename, column: row.name, name: value } : { kind: rename, name: row.name, next: value };
            if (row.change < 0) onChange([...edits, edit]);
            else onChange(edits.map((item, position) => position === row.change ? edit : item));
          },
        }}
        tableActions={saving ? undefined : {
          structureLabel: section,
          onAddRow: () => onChange([...edits, newEdit()]),
          onDuplicateRows: (indexes) => onChange([...edits, ...indexes.flatMap((index) => {
            const row = rows[index];
            if (!row || (section === 'Constraint' && row.values[2] !== 'UNIQUE')) return [];
            const values = [...row.values];
            values[0] += '_copy';
            return [newEdit(values)];
          })]),
          onDeleteRows: (indexes) => {
            const targets = indexes.map((index) => rows[index]).filter((row) => row && !row.locked);
            const removed = new Set(targets.map((row) => row.change));
            onChange([...edits.filter((_, index) => !removed.has(index)), ...targets.flatMap((row): StructureEdit[] =>
              row.fresh ? [] : [drop === 'drop' ? { kind: drop, column: row.name } : { kind: drop, name: row.name }])]);
          },
        }}
      />
    </div>
  </section>;
}

function StructureView({ structure, error, onRefresh }: { structure: TableStructure | null; error: ErrorInfo | null; onRefresh: () => void }) {
  if (error)
    return (
      <div style={{ padding: 16 }}>
        <ErrorView error={error} actions={<button className="btn small" onClick={onRefresh}>Try again</button>} />
      </div>
    );
  if (!structure)
    return (
      <div className="state">
        <Spinner />
      </div>
    );
  return (
    <div className="scroll" style={{ flex: 1, padding: '6px 14px 24px' }}>
      <div className="row" style={{ margin: '8px 0' }}>
        <span className="section-label" style={{ padding: 0 }}>
          Columns
        </span>
        <span className="pill">{structure.columns.length}</span>
        <span className="spacer" />
        <button className="btn small" onClick={onRefresh}>
          ↻ Refresh
        </button>
      </div>
      {structure.columnsStatus.state === 'ok' ? (
        <table className="list">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Key</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {structure.columns.map((c) => (
              <tr key={c.ordinal}>
                <td className="muted">{c.ordinal}</td>
                <td>
                  <b>{c.name}</b>
                </td>
                <td className="mono">{c.type}</td>
                <td>{c.nullable === null ? <span className="muted">unknown</span> : c.nullable ? 'YES' : <b>NO</b>}</td>
                <td className="mono">{c.defaultValue === null ? <span className="muted">—</span> : c.defaultValue}</td>
                <td>
                  {c.isPrimaryKey && <span className="pill info">PK</span>} {c.isIdentity && <span className="pill">identity</span>}
                </td>
                <td className="muted">{c.comment ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState status={structure.columnsStatus} empty="No columns." />
      )}

      <div className="row" style={{ margin: '20px 0 8px' }}>
        <span className="section-label" style={{ padding: 0 }}>
          Indexes
        </span>
        {structure.indexesStatus.state === 'ok' && <span className="pill">{structure.indexes.length}</span>}
      </div>
      {structure.indexesStatus.state === 'ok' ? (
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Columns</th>
              <th>Unique</th>
              <th>Definition</th>
            </tr>
          </thead>
          <tbody>
            {structure.indexes.map((i) => (
              <tr key={i.name}>
                <td>
                  <b>{i.name}</b> {i.primary && <span className="pill info">PRIMARY</span>}
                </td>
                <td className="mono">{i.columns.join(', ')}</td>
                <td>{i.unique ? 'YES' : 'NO'}</td>
                <td className="mono muted">{i.definition ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState status={structure.indexesStatus} empty="No indexes." />
      )}

      <div className="row" style={{ margin: '20px 0 8px' }}>
        <span className="section-label" style={{ padding: 0 }}>
          Constraints
        </span>
        {structure.constraintsStatus.state === 'ok' && <span className="pill">{structure.constraints.length}</span>}
      </div>
      {structure.constraintsStatus.state === 'ok' ? (
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Columns</th>
              <th>Definition / references</th>
            </tr>
          </thead>
          <tbody>
            {structure.constraints.map((c) => (
              <tr key={c.name + c.type}>
                <td>
                  <b>{c.name}</b>
                </td>
                <td>{c.type}</td>
                <td className="mono">{c.columns.join(', ')}</td>
                <td className="mono muted">{c.definition ?? (c.references ? `→ ${c.references}` : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState status={structure.constraintsStatus} empty="No constraints." />
      )}
    </div>
  );
}
