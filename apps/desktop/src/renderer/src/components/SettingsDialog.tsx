import { useState, type CSSProperties } from 'react';
import { LIMITS, NO_LIMIT, type Theme, type UiStyle, useApp } from '../store';
import { Modal } from './common';
import { BackupSettings } from './BackupSettings';
import { ShortcutSettings } from './ShortcutSettings';

import { THEME_OPTIONS } from '../themes';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const autoThemes = useApp((s) => s.autoThemes);
  const setAutoTheme = useApp((s) => s.setAutoTheme);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const uiStyle = useApp((s) => s.uiStyle);
  const setUiStyle = useApp((s) => s.setUiStyle);
  const defaultRowLimit = useApp((s) => s.defaultRowLimit);
  const setDefaultRowLimit = useApp((s) => s.setDefaultRowLimit);
  const beautifyUppercase = useApp((s) => s.beautifyUppercase);
  const setBeautifyUppercase = useApp((s) => s.setBeautifyUppercase);
  const sqlRunDefault = useApp((s) => s.sqlRunDefault);
  const setSqlRunDefault = useApp((s) => s.setSqlRunDefault);
  const exportInBackground = useApp((s) => s.exportInBackground);
  const setExportInBackground = useApp((s) => s.setExportInBackground);
  const exportSuccessDialog = useApp((s) => s.exportSuccessDialog);
  const setExportSuccessDialog = useApp((s) => s.setExportSuccessDialog);
  const [tab, setTab] = useState<'general' | 'shortcuts' | 'backup'>('general');
  const [working, setWorking] = useState(false);

  return (
    <Modal title="Settings" onClose={() => { if (!working) onClose(); }}>
      <div className="segmented settings-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" role="tab" disabled={working} aria-selected={tab === 'general'} className={tab === 'general' ? 'on' : ''} onClick={() => setTab('general')}>
          General
        </button>
        <button type="button" role="tab" disabled={working} aria-selected={tab === 'shortcuts'} className={tab === 'shortcuts' ? 'on' : ''} onClick={() => setTab('shortcuts')}>
          Shortcuts
        </button>
        <button type="button" role="tab" disabled={working} aria-selected={tab === 'backup'} className={tab === 'backup' ? 'on' : ''} onClick={() => setTab('backup')}>
          Backup / Restore
        </button>
      </div>
      <div hidden={tab !== 'backup'}><BackupSettings setWorking={setWorking} /></div>
      {tab === 'shortcuts' && <ShortcutSettings />}
      {tab === 'general' && (
      <div className="col" style={{ gap: 20 }}>
        <section>
          <h3 className="settings-h">Appearance</h3>
          <div className="ui-style-options" role="radiogroup" aria-label="UI style">
            {([
              { id: 'classic', label: 'Classic', description: 'The familiar EarthQL layout' },
              { id: 'modern', label: 'Modern', description: 'Softer surfaces and streamlined controls' },
            ] satisfies { id: UiStyle; label: string; description: string }[]).map((style) => (
              <label key={style.id} className={`ui-style-option${uiStyle === style.id ? ' on' : ''}`}>
                <input type="radio" name="ui-style" value={style.id} checked={uiStyle === style.id}
                  onChange={() => setUiStyle(style.id)} />
                <span className={`ui-style-preview ${style.id}`} aria-hidden="true">
                  <span /><span /><span />
                </span>
                <span className="ui-style-copy"><strong>{style.label}</strong><span>{style.description}</span></span>
              </label>
            ))}
          </div>
          <h4 className="theme-heading">Color theme</h4>
          <div role="radiogroup" aria-label="Color theme">
            {(['auto', 'light', 'dark'] as const).map((group) => (
              <div key={group} role="group" aria-label={group} className="theme-option-group">
                <h5>{group === 'auto' ? 'Appearance' : group === 'light' ? 'Light themes' : 'Dark themes'}</h5>
                <div className="theme-swatch-grid">
            {THEME_OPTIONS.filter((t) => t.group === group).map((t) => (
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
                  style={{ '--swatch-bg': t.split ? `linear-gradient(135deg, ${THEME_OPTIONS.find((o) => o.id === autoThemes.light)?.bg} 50%, ${THEME_OPTIONS.find((o) => o.id === autoThemes.dark)?.bg} 50%)` : t.bg, '--swatch-primary': t.primary } as CSSProperties}
                />
                <span className="theme-swatch-label">{t.label}</span>
              </button>
            ))}
                </div>
                {group === 'auto' && <>
                  <p className="muted small">Auto follows your Mac’s light or dark appearance.</p>
                  <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                    {(['light', 'dark'] as const).map((mode) => <label className="row" key={mode}>
                      {mode === 'light' ? 'Light theme' : 'Dark theme'}
                      <select className="select" value={autoThemes[mode]} onChange={(event) => setAutoTheme(mode, event.target.value as Theme)}>
                        {THEME_OPTIONS.filter((option) => option.group === mode).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                      </select>
                    </label>)}
                  </div>
                </>}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="settings-h">SQL Query</h3>
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

        <section>
          <h3 className="settings-h">Export</h3>
          <div className="col" style={{ gap: 12 }}>
            <label className="check">
              <input type="checkbox" checked={exportInBackground} onChange={(e) => setExportInBackground(e.target.checked)} />
              Always export in the background
            </label>
            <span className="muted small">When off, a progress dialog appears and you can send the export to the background from there.</span>
            <label className="check">
              <input type="checkbox" checked={exportSuccessDialog} onChange={(e) => setExportSuccessDialog(e.target.checked)} />
              Show a success dialog when an export completes
            </label>
          </div>
        </section>
      </div>
      )}
    </Modal>
  );
}
