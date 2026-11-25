import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { MSSQL, MySQL, PostgreSQL, SQLDialect, StandardSQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import type { CompletionSchema, DriverId } from '@earthql/core';

const SparkSQL = SQLDialect.define({
  ...((StandardSQL as any).spec ?? {}),
  identifierQuotes: '`',
  keywords:
    'select from where group by having order limit offset join inner left right full outer cross on using as and or not in is null like ilike rlike between case when then else end with union all distinct insert into values update set delete merge create table view schema catalog database replace if exists drop alter add column columns describe show tables schemas catalogs use comment tblproperties partitioned location using delta cluster qualify pivot unpivot lateral explode true false',
  types: 'string int bigint smallint tinyint double float decimal boolean date timestamp timestamp_ntz binary array map struct void interval',
});

const DIALECTS: Record<DriverId, SQLDialect> = { postgres: PostgreSQL, mysql: MySQL, mssql: MSSQL, databricks: SparkSQL };

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--cm-keyword, #8a3ffc)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--cm-string, #198038)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--cm-number, #b45309)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--cm-type, #0e7490)' },
  { tag: [t.operator, t.punctuation], color: 'var(--text-2)' },
  { tag: t.special(t.name), color: 'var(--cm-quoted, #a16207)' },
]);

function toNamespace(s: CompletionSchema | null): SQLNamespace {
  return (s?.namespaces ?? {}) as SQLNamespace;
}

export interface SqlEditorHandle {
  getText(): string;
  /** Selected text, or '' when nothing is selected. */
  getSelection(): string;
  /** Absolute offset of the caret (the active end of the selection). */
  getCursor(): number;
  /** Absolute offset range of the selection, or null when it is empty. */
  getSelectionRange(): { from: number; to: number } | null;
  setText(text: string): void;
  /** Replaces just `[from, to)` — a single undoable step, unlike setText. */
  replaceRange(from: number, to: number, text: string): void;
  focus(): void;
}

export function SqlEditor({
  driver,
  initial,
  schema,
  onChange,
  handleRef,
}: {
  driver: DriverId;
  initial: string;
  schema: CompletionSchema | null;
  onChange?: (text: string) => void;
  handleRef: React.MutableRefObject<SqlEditorHandle | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langConf = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const state = EditorState.create({
      doc: initial,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(highlight),
        autocompletion({ activateOnTyping: true, icons: true }),
        placeholder('Write SQL here. ⌘↵ runs the selection, or the current statement when nothing is selected.'),
        langConf.current.of(sql({ dialect: DIALECTS[driver], upperCaseKeywords: true })),
        Prec.high(keymap.of([indentWithTab])),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap.filter((k) => k.key !== 'Mod-Enter'), ...searchKeymap, ...historyKeymap, ...completionKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
        }),
        EditorView.theme({ '&': { height: '100%' } }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    handleRef.current = {
      getText: () => v.state.doc.toString(),
      getSelection: () => {
        const r = v.state.selection.main;
        return r.empty ? '' : v.state.sliceDoc(r.from, r.to);
      },
      getCursor: () => v.state.selection.main.head,
      getSelectionRange: () => {
        const r = v.state.selection.main;
        return r.empty ? null : { from: r.from, to: r.to };
      },
      setText: (text) => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }),
      replaceRange: (from, to, text) => v.dispatch({ changes: { from, to, insert: text } }),
      focus: () => v.focus(),
    };
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autocomplete from the connection and context of this tab.
  useEffect(() => {
    view.current?.dispatch({
      effects: langConf.current.reconfigure(
        sql({ dialect: DIALECTS[driver], upperCaseKeywords: true, schema: toNamespace(schema), defaultSchema: schema?.defaultNamespace }),
      ),
    });
  }, [schema, driver]);

  return <div className="editor" ref={host} />;
}
