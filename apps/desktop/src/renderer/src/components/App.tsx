import { useEffect, useState, type CSSProperties } from 'react';
import { describePath } from '@earthql/core';
import { onMenuCommand } from '../api';
import { profileOf, useApp, type Tab } from '../store';
import { ConnectionsScreen } from './ConnectionsScreen';
import { CreateTableTab } from './CreateTableTab';
import { Sidebar } from './Sidebar';
import { SqlTab } from './SqlTab';
import { TableTab } from './TableTab';
import { ErrorBoundary } from './ErrorBoundary';

function tabTitle(t: Tab): { title: string; sub: string; icon: string } {
  if (t.kind === 'table') return { title: t.object.name, sub: describePath({ ...t.object, name: '' }).replace(/\.$/, ''), icon: t.objectKind === 'view' ? '◇' : '▦' };
  if (t.kind === 'sql') return { title: t.title, sub: '', icon: '⌨︎' };
  return { title: 'New table', sub: describePath({ ...t.container, name: '' }).replace(/\.$/, ''), icon: '＋' };
}

export function App() {
  const { screen, tabs, activeTabId, activateTab, closeTab, activeProfileId, newSqlTab, setScreen, loadProfiles, toasts } = useApp();
  const profiles = useApp((s) => s.profiles);
  const [newRequested, setNewRequested] = useState(0);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(
    () =>
      onMenuCommand((cmd) => {
        const s = useApp.getState();
        if (cmd === 'new-connection') {
          s.setScreen('connections');
          setNewRequested((n) => n + 1);
        }
        if (cmd === 'new-sql-tab' && s.activeProfileId && s.connections[s.activeProfileId]) s.newSqlTab(s.activeProfileId);
        if (cmd === 'close-tab' && s.activeTabId && s.screen === 'workspace') s.closeTab(s.activeTabId);
      }),
    [],
  );

  return (
    <div className="app">
      {screen === 'connections' ? (
        <ConnectionsScreen key={newRequested} initialNew={newRequested > 0} />
      ) : (
        <>
          <Sidebar />
          <main className="main">
            <div className="main-top drag">
              <div className="tabs no-drag">
                {tabs.map((t) => {
                  const p = profileOf(t.profileId)?.profile;
                  const { title, sub, icon } = tabTitle(t);
                  return (
                    <div
                      key={t.id}
                      className={`tab${t.id === activeTabId ? ' active' : ''}`}
                      style={{ '--env': p?.env.color ?? 'transparent' } as CSSProperties}
                      onMouseDown={(e) => {
                        if (e.button === 1) closeTab(t.id);
                        else activateTab(t.id);
                      }}
                      title={`${p?.name ?? ''}${p?.env.name ? ` (${p.env.name})` : ''} — ${t.kind === 'table' ? describePath(t.object) : title}`}
                    >
                      <span className="stripe" />
                      <span className="muted">{icon}</span>
                      <span className="t-title">
                        {title}
                        <div className="t-sub">
                          {p?.name}
                          {sub ? ` · ${sub}` : ''}
                        </div>
                      </span>
                      <span
                        className="t-close"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(t.id);
                        }}
                      >
                        ×
                      </span>
                    </div>
                  );
                })}
              </div>
              {activeProfileId && (
                <button className="btn small ghost no-drag" style={{ margin: '0 8px 6px' }} title="New SQL editor (⌘T)" onClick={() => newSqlTab(activeProfileId)}>
                  ＋ SQL
                </button>
              )}
            </div>
            <div className="tab-content">
              {tabs.length === 0 && (
                <div className="welcome" style={{ height: '100%' }}>
                  <h2>{activeProfileId ? profileOf(activeProfileId)?.profile.name : 'EarthQL'}</h2>
                  <p>Pick a table or view in the sidebar, or open a SQL editor.</p>
                  <div className="row">
                    {activeProfileId && (
                      <button className="btn primary" onClick={() => newSqlTab(activeProfileId)}>
                        New SQL editor
                      </button>
                    )}
                    <button className="btn" onClick={() => setScreen('connections')}>
                      Connections
                    </button>
                  </div>
                  <p className="muted small">Right-click a schema or database to create a table.</p>
                </div>
              )}
              {tabs.map((t) => (
                <div key={t.id} className="tab-pane" hidden={t.id !== activeTabId}>
                  <ErrorBoundary label="this tab">
                  {t.kind === 'table' && (
                    <TableTab tabId={t.id} profileId={t.profileId} object={t.object} objectKind={t.objectKind} initialView={t.initialView} active={t.id === activeTabId} />
                  )}
                  {t.kind === 'sql' && <SqlTab profileId={t.profileId} initialSql={t.initialSql} context={t.context} active={t.id === activeTabId} />}
                  {t.kind === 'create' && <CreateTableTab tabId={t.id} profileId={t.profileId} container={t.container} />}
                  </ErrorBoundary>
                </div>
              ))}
            </div>
          </main>
        </>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
      <span hidden>{profiles.length}</span>
    </div>
  );
}
