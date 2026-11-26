import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { MSSQL, MySQL, PostgreSQL, SQLDialect, StandardSQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import type { CompletionSchema, DriverId } from '@earthql/core';
import { useApp } from '../store';
import { Kbd, shortcutLabel } from './Shortcut';

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

export interface EditorActions {
  onBeautify(): void;
  onUglify(): void;
  onSave(): void;
  onSplit(side: 'left' | 'right' | 'up' | 'down'): void;
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
  editorActions,
}: {
  driver: DriverId;
  initial: string;
  schema: CompletionSchema | null;
  onChange?: (text: string) => void;
  handleRef: React.MutableRefObject<SqlEditorHandle | null>;
  /** Enables the Beautify / Uglify / Add to Queries / Split entries in the right-click menu. */
  editorActions?: EditorActions;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langConf = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
        placeholder(() => {
          const run = shortcutLabel('run', useApp.getState().keybindings);
          const hint = document.createElement('span');
          hint.textContent = `Write SQL here. ${run ? `${run} runs` : 'Run executes'} the selection, or the current statement when nothing is selected.`;
          return hint;
        }),
        langConf.current.of(sql({ dialect: DIALECTS[driver], upperCaseKeywords: true })),
        Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
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

  function openMenu(x: number, y: number) {
    setHasSelection(!view.current!.state.selection.main.empty);
    setMenu({ x, y });
  }

  // Run an action, then hand focus back to the editor so typing continues where it was.
  function invoke(action: () => void) {
    setMenu(null);
    action();
    view.current?.focus();
  }

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(null);
    };
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  function onMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      setMenu(null);
      view.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (event.key === 'Home') buttons[0]?.focus();
    else if (event.key === 'End') buttons.at(-1)?.focus();
    else buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }

  function copySelection() {
    const range = view.current!.state.selection.main;
    if (!range.empty) void navigator.clipboard.writeText(view.current!.state.sliceDoc(range.from, range.to));
  }

  async function pasteAtCursor() {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    const v = view.current;
    if (!v || !text) return;
    const range = v.state.selection.main;
    v.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length }, scrollIntoView: true });
    v.focus();
  }

  return (
    <>
      <div
        className="editor"
        ref={host}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY);
        }}
      />
      {menu && (
        <div className="tab-context-menu" ref={menuRef} role="menu" aria-label="SQL Query actions" onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" disabled={!hasSelection} onClick={() => invoke(copySelection)}>
            <span>Copy</span><Kbd id="sys-copy" />
          </button>
          <button type="button" role="menuitem" onClick={() => invoke(() => void pasteAtCursor())}>
            <span>Paste</span><Kbd id="sys-paste" />
          </button>
          {editorActions && (
            <>
              <div className="conn-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => invoke(editorActions.onBeautify)}>
                <span>Beautify</span><Kbd id="beautify" />
              </button>
              <button type="button" role="menuitem" onClick={() => invoke(editorActions.onUglify)}>
                <span>Uglify</span><Kbd id="uglify" />
              </button>
              <div className="conn-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => invoke(editorActions.onSave)}>Add to Queries</button>
              <div className="conn-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => invoke(() => editorActions.onSplit('left'))}>
                <span>Split Left</span><Kbd id="split-left" />
              </button>
              <button type="button" role="menuitem" onClick={() => invoke(() => editorActions.onSplit('right'))}>
                <span>Split Right</span><Kbd id="split-right" />
              </button>
              <button type="button" role="menuitem" onClick={() => invoke(() => editorActions.onSplit('up'))}>
                <span>Split Up</span><Kbd id="split-up" />
              </button>
              <button type="button" role="menuitem" onClick={() => invoke(() => editorActions.onSplit('down'))}>
                <span>Split Down</span><Kbd id="split-down" />
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
