import { useState, type CSSProperties } from 'react';
import { LIMITS, NO_LIMIT, type Theme, useApp } from '../store';
import { Modal } from './common';
import { ShortcutSettings } from './ShortcutSettings';

const THEME_OPTIONS: { id: Theme; label: string; bg: string; primary?: string; split?: boolean }[] = [
  { id: 'system', label: 'System', bg: 'linear-gradient(135deg, #f5f6f3 50%, #202723 50%)', split: true },
  { id: 'light', label: 'Light', bg: '#f5f6f3', primary: '#34745c' },
  { id: 'dark', label: 'Dark', bg: '#202723', primary: '#85bda3' },
  { id: 'white', label: 'White', bg: '#ffffff', primary: '#2f6fed' },
  { id: 'slate', label: 'Slate', bg: '#eef0f5', primary: '#5b6ee8' },
  { id: 'sepia', label: 'Sepia', bg: '#f6efe2', primary: '#9c6b2e' },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const defaultRowLimit = useApp((s) => s.defaultRowLimit);
  const setDefaultRowLimit = useApp((s) => s.setDefaultRowLimit);
  const beautifyUppercase = useApp((s) => s.beautifyUppercase);
  const setBeautifyUppercase = useApp((s) => s.setBeautifyUppercase);
  const sqlRunDefault = useApp((s) => s.sqlRunDefault);
  const setSqlRunDefault = useApp((s) => s.setSqlRunDefault);
  const [tab, setTab] = useState<'general' | 'shortcuts'>('general');

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="segmented settings-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" role="tab" aria-selected={tab === 'general'} className={tab === 'general' ? 'on' : ''} onClick={() => setTab('general')}>
          General
        </button>
        <button type="button" role="tab" aria-selected={tab === 'shortcuts'} className={tab === 'shortcuts' ? 'on' : ''} onClick={() => setTab('shortcuts')}>
          Shortcuts
        </button>
      </div>
      {tab === 'shortcuts' ? <ShortcutSettings /> : (
      <div className="col" style={{ gap: 20 }}>
        <section>
          <h3 className="settings-h">Appearance</h3>
          <div className="theme-swatch-grid" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={theme === t.id}
                className={`theme-swatch${theme === t.id ? ' on' : ''}`}
                onClick={() => setTheme(t.id)}
              >
                <span
                  className={`theme-swatch-preview${t.split ? ' split' : ''}`}
                  style={{ '--swatch-bg': t.bg, '--swatch-primary': t.primary } as CSSProperties}
                />
                <span className="theme-swatch-label">{t.label}</span>
              </button>
            ))}
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>“System” follows your Mac's light/dark appearance automatically.</p>
        </section>

        <section>
          <h3 className="settings-h">SQL Editor</h3>
          <div className="col" style={{ gap: 12 }}>
            <label className="row" style={{ justifyContent: 'space-between' }}>
              <span>Default row limit for new SQL tabs</span>
              <select
                className="select"
                value={defaultRowLimit}
                onChange={(e) => setDefaultRowLimit(Number(e.target.value))}
              >
                <option value={NO_LIMIT}>No limit</option>
                {LIMITS.map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()} rows
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={beautifyUppercase} onChange={(e) => setBeautifyUppercase(e.target.checked)} />
              Uppercase keywords when formatting (Beautify)
            </label>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>Default run action</span>
              <div className="segmented">
                <button type="button" className={sqlRunDefault === 'current' ? 'on' : ''} onClick={() => setSqlRunDefault('current')}>
                  Run Current
                </button>
                <button type="button" className={sqlRunDefault === 'all' ? 'on' : ''} onClick={() => setSqlRunDefault('all')}>
                  Run All
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
      )}
    </Modal>
  );
}
