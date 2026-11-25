import { useEffect, useMemo, useState } from 'react';
import {
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  acceleratorFromEvent,
  findConflict,
  isRebindable,
  shortcutDisplay,
  toSymbols,
  validateAccelerator,
  type ShortcutDef,
} from '../../../shared/keybindings';
import { api } from '../api';
import { useApp } from '../store';
import { Keys } from './Shortcut';

function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
      <path fill="currentColor" d="M11.9 1.6a1.9 1.9 0 0 1 2.7 2.7l-8.5 8.5-3.6.9.9-3.6zm-1 2.1L3.5 11.1l-.4 1.6 1.6-.4 7.4-7.4z" />
    </svg>
  );
}

interface Problem {
  id: string;
  message: string;
  /** Set when the clash is with another rebindable shortcut the user may take over. */
  takeOver?: { from: ShortcutDef; accelerator: string };
}

export function ShortcutSettings() {
  const overrides = useApp((s) => s.keybindings);
  const setKeybinding = useApp((s) => s.setKeybinding);
  const setKeybindings = useApp((s) => s.setKeybindings);
  const resetKeybinding = useApp((s) => s.resetKeybinding);
  const resetAllKeybindings = useApp((s) => s.resetAllKeybindings);
  const [filter, setFilter] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  // Native menu accelerators would fire (and swallow) the keystroke being recorded, so the menu
  // is stripped of them for as long as a row is waiting for keys.
  useEffect(() => {
    if (!recording) return;
    void api.keybindings.apply(useApp.getState().keybindings, true).catch(() => undefined);
    return () => {
      void api.keybindings.apply(useApp.getState().keybindings, false).catch(() => undefined);
    };
  }, [recording]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (event.key === 'Escape' && bare) {
        setRecording(null);
        setProblem(null);
        return;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && bare) {
        setKeybinding(recording, null);
        setRecording(null);
        setProblem(null);
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;
      const invalid = validateAccelerator(accelerator);
      if (invalid) {
        setProblem({ id: recording, message: invalid });
        return;
      }
      const conflict = findConflict(recording, accelerator, useApp.getState().keybindings);
      if (conflict) {
        if (isRebindable(conflict)) {
          setProblem({ id: recording, message: `${toSymbols(accelerator)} is already used by “${conflict.label}”.`, takeOver: { from: conflict, accelerator } });
          setRecording(null);
        } else {
          setProblem({ id: recording, message: `${toSymbols(accelerator)} is built in for “${conflict.label}”. Try another.` });
        }
        return;
      }
      setKeybinding(recording, accelerator);
      setRecording(null);
      setProblem(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, setKeybinding]);

  const needle = filter.trim().toLowerCase();
  const groups = useMemo(
    () =>
      SHORTCUT_CATEGORIES.map((category) => ({
        category,
        defs: SHORTCUTS.filter(
          (def) =>
            def.category === category &&
            (!needle || `${def.label} ${def.category} ${def.note ?? ''} ${shortcutDisplay(def, overrides)}`.toLowerCase().includes(needle)),
        ),
      })).filter((group) => group.defs.length),
    [needle, overrides],
  );
  const modified = Object.keys(overrides).length;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input grow"
          type="search"
          placeholder="Filter shortcuts"
          aria-label="Filter shortcuts"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="btn small" disabled={!modified} onClick={() => { resetAllKeybindings(); setProblem(null); setRecording(null); }}>
          Reset all
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Click a shortcut, then press the new keys. <Keys keys="⎋" /> cancels and <Keys keys="⌫" /> removes it. Built-in shortcuts are listed for reference.
      </p>
      {groups.length === 0 && <p className="muted">No shortcuts match “{filter}”.</p>}
      {groups.map(({ category, defs }) => (
        <section key={category}>
          <h3 className="settings-h">{category}</h3>
          <div className="shortcut-list">
            {defs.map((def) => {
              const rebindable = isRebindable(def);
              const isRecording = recording === def.id;
              const display = shortcutDisplay(def, overrides);
              const changed = rebindable && Object.prototype.hasOwnProperty.call(overrides, def.id);
              const rowProblem = problem?.id === def.id ? problem : null;
              return (
                <div key={def.id} className="shortcut-row">
                  <div className="shortcut-label">
                    <span>{def.label}</span>
                    {def.note && <span className="muted small">{def.note}</span>}
                    {rowProblem && (
                      <span className="shortcut-problem small" role="alert">
                        {rowProblem.message}
                        {rowProblem.takeOver && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => {
                                setKeybindings({ [rowProblem.takeOver!.from.id]: null, [def.id]: rowProblem.takeOver!.accelerator });
                                setProblem(null);
                              }}
                            >
                              Reassign
                            </button>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="shortcut-keys">
                    {changed && (
                      <button
                        type="button"
                        className="btn small ghost"
                        title={`Restore default (${def.accelerator ? toSymbols(def.accelerator) : 'none'})`}
                        onClick={() => { resetKeybinding(def.id); setProblem(null); }}
                      >
                        Reset
                      </button>
                    )}
                    {isRecording ? (
                      <span className="shortcut-prompt">Press shortcut…</span>
                    ) : display ? (
                      <span className={rebindable ? undefined : 'shortcut-fixed'} title={rebindable ? undefined : 'Built in — cannot be changed'}>
                        <Keys keys={display} />
                      </span>
                    ) : (
                      <span className="muted small">Not set</span>
                    )}
                    {rebindable ? (
                      <button
                        type="button"
                        className={`shortcut-edit${isRecording ? ' recording' : ''}`}
                        title={isRecording ? 'Press the new keys (⎋ cancels)' : `Change shortcut for ${def.label}`}
                        aria-label={`${def.label} shortcut: ${display || 'not set'}. Click to change.`}
                        onClick={() => { setProblem(null); setRecording(isRecording ? null : def.id); }}
                        onBlur={() => isRecording && setRecording(null)}
                      >
                        <PencilIcon />
                      </button>
                    ) : (
                      <span className="shortcut-edit-spacer" aria-hidden="true" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
