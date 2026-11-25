import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onMenuCommand } from '../api';
import { connectionName, useApp, type Tab } from '../store';
import { ConnectionsScreen } from './ConnectionsScreen';
import { CreateTableTab } from './CreateTableTab';
import { Sidebar } from './Sidebar';
import { SqlTab } from './SqlTab';
import { TableTab } from './TableTab';
import { TabBar } from './TabBar';
import { ErrorBoundary } from './ErrorBoundary';
import { FeedbackDialog } from './FeedbackDialog';
import { SettingsDialog } from './SettingsDialog';
import { UpdateButton } from './UpdateButton';
import { Modal } from './common';

function GearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13">
      <path
        fill="currentColor"
        d="M6.4 1.2h3.2l.5 1.9c.4.15.78.35 1.13.58l1.87-.63 1.6 2.77-1.46 1.3a5 5 0 0 1 0 1.3l1.46 1.3-1.6 2.77-1.87-.63c-.35.23-.73.43-1.13.58l-.5 1.9H6.4l-.5-1.9a4.9 4.9 0 0 1-1.13-.58l-1.87.63-1.6-2.77 1.46-1.3a5 5 0 0 1 0-1.3L1.3 5.14l1.6-2.77 1.87.63c.35-.23.73-.43 1.13-.58zM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5"
      />
    </svg>
  );
}

function renderTabContent(t: Tab, active: boolean) {
  return (
    <ErrorBoundary label="this tab">
      {t.kind === 'table' && (
        <TableTab tabId={t.id} profileId={t.profileId} object={t.object} objectKind={t.objectKind} initialView={t.initialView} active={active} refreshVersion={t.refreshVersion} />
      )}
      {t.kind === 'sql' && <SqlTab profileId={t.profileId} initialSql={t.initialSql} context={t.context} active={active} refreshVersion={t.refreshVersion} />}
      {t.kind === 'create' && <CreateTableTab tabId={t.id} profileId={t.profileId} container={t.container} refreshVersion={t.refreshVersion} />}
    </ErrorBoundary>
  );
}

function tabTitle(t: Tab) {
  if (t.customTitle) return t.customTitle;
  if (t.kind === 'table') return t.object.name;
  return t.kind === 'sql' ? t.title : 'New table';
}

export function App() {
  const { screen, tabs, activeTabId, activeProfileId, newSqlTab, setScreen, loadProfiles, toasts } = useApp();
  const { discardPrompt, resolveDiscard } = useApp();
  const { splitPane, closeSplit } = useApp();
  const profiles = useApp((s) => s.profiles);
  const [newRequested, setNewRequested] = useState(0);
  const [feedback, setFeedback] = useState<{ screenshot: string | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [splitWidth, setSplitWidth] = useState<number | null>(null);
  const splitTab = splitPane ? tabs.find((t) => t.id === splitPane.tabId) : undefined;
  const mainSplitRef = useRef<HTMLDivElement>(null);
  const feedbackOpen = useRef(false);

  function startSplitResize(e: React.MouseEvent) {
    const rect = mainSplitRef.current!.getBoundingClientRect();
    const fromRight = splitPane?.side === 'right';
    const move = (ev: MouseEvent) => {
      const w = fromRight ? rect.right - ev.clientX : ev.clientX - rect.left;
      setSplitWidth(Math.max(200, Math.min(w, rect.width - 200)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.preventDefault();
  }

  const openFeedback = useCallback(() => {
    if (feedbackOpen.current) return;
    feedbackOpen.current = true;
    // Capture the original view before covering it with the feedback form.
    void api.feedback.capture().catch(() => null).then((screenshot) => setFeedback({ screenshot }));
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(
    () =>
      onMenuCommand((cmd) => {
        if (cmd === 'close-window') {
          const state = useApp.getState();
          if (Object.values(state.gridDrafts).some((draft) => draft.saving)) {
            window.earthqlBridge.closeWindow(false);
            state.toast('info', 'Wait for the cell changes to finish saving.');
          } else {
            void (async () => {
              const discard = !Object.keys(state.gridDrafts).length || await state.confirmDiscard();
              window.earthqlBridge.closeWindow(discard && !Object.values(useApp.getState().gridDrafts).some((draft) => draft.saving));
            })();
          }
        }
        if (cmd === 'send-feedback') openFeedback();
        if (cmd === 'open-settings') setSettingsOpen(true);
        const s = useApp.getState();
        if (cmd === 'new-connection') {
          s.setScreen('connections');
          setNewRequested((n) => n + 1);
        }
        if (cmd === 'new-sql-tab' && s.activeProfileId && s.connections[s.activeProfileId]) s.newSqlTab(s.activeProfileId);
        if (cmd === 'close-tab' && s.activeTabId && s.screen === 'workspace') s.closeTab(s.activeTabId);
        if (cmd === 'close-all-tabs' && s.screen === 'workspace') s.closeTabs(s.tabs.map(({ id }) => id));
        if (cmd === 'refresh' && s.activeTabId && s.screen === 'workspace') s.refreshTab(s.activeTabId);
        if (cmd === 'split-left' && s.activeTabId && s.screen === 'workspace') s.openSplit(s.activeTabId, 'left');
        if (cmd === 'split-right' && s.activeTabId && s.screen === 'workspace') s.openSplit(s.activeTabId, 'right');
      }),
    [openFeedback],
  );


  return (
    <div className="app">
      <div className="app-content">
      {screen === 'connections' ? (
        <ConnectionsScreen key={newRequested} initialNew={newRequested > 0} />
      ) : (
        <>
          <Sidebar />
          <main className="main">
            <TabBar />
            <div className={`main-split${splitPane ? ' has-split' : ''}`} ref={mainSplitRef}>
              {splitPane && splitTab && splitPane.side === 'left' && (
                <>
                  <div className="split-pane" style={{ width: splitWidth ?? undefined }}>
                    <div className="split-pane-head">
                      <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tabTitle(splitTab)}</span>
                      <button type="button" className="btn ghost icon" aria-label="Close split" title="Close split" onClick={closeSplit}>✕</button>
                    </div>
                    <div className="tab-content"><div className="tab-pane">{renderTabContent(splitTab, false)}</div></div>
                  </div>
                  <div className="split-divider" onMouseDown={startSplitResize} />
                </>
              )}
              <div className="tab-content" style={splitPane ? { flex: 1, minWidth: 0 } : undefined}>
                {tabs.length === 0 && (
                  <div className="welcome" style={{ height: '100%' }}>
                    <h2>{activeProfileId ? connectionName(activeProfileId) : 'EarthQL'}</h2>
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
                    {renderTabContent(t, t.id === activeTabId)}
                  </div>
                ))}
              </div>
              {splitPane && splitTab && splitPane.side === 'right' && (
                <>
                  <div className="split-divider" onMouseDown={startSplitResize} />
                  <div className="split-pane" style={{ width: splitWidth ?? undefined }}>
                    <div className="split-pane-head">
                      <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tabTitle(splitTab)}</span>
                      <button type="button" className="btn ghost icon" aria-label="Close split" title="Close split" onClick={closeSplit}>✕</button>
                    </div>
                    <div className="tab-content"><div className="tab-pane">{renderTabContent(splitTab, false)}</div></div>
                  </div>
                </>
              )}
            </div>
          </main>
        </>
      )}
      </div>
      <footer className="app-footer">
        <UpdateButton />
        <button className="btn small ghost no-drag" aria-keyshortcuts="Meta+," onClick={() => setSettingsOpen(true)}>
          <GearIcon /> Settings
        </button>
        <span className="spacer" />
        <button className="btn small no-drag" onClick={openFeedback}>Send Feedback</button>
      </footer>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
      {discardPrompt && (
        <Modal narrow title="Unsaved changes" onClose={() => resolveDiscard(false)} footer={<>
          <button className="btn" autoFocus onClick={() => resolveDiscard(false)}>Cancel</button>
          <button className="btn danger" onClick={() => resolveDiscard(true)}>Discard changes</button>
        </>}>
          <p>Discard all changes?</p>
          <p className="muted small">Your unsaved cell edits will be lost.</p>
          <div className="discard-save-tip">Save your changes with <kbd>⌘S</kbd> or the <strong>Save</strong> button above the table.</div>
        </Modal>
      )}
      {feedback && <FeedbackDialog screenshot={feedback.screenshot} onClose={() => { feedbackOpen.current = false; setFeedback(null); }} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      <span hidden>{profiles.length}</span>
    </div>
  );
}
