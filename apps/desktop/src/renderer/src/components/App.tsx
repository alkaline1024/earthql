import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onMenuCommand } from '../api';
import { connectionName, useApp } from '../store';
import { ConnectionsScreen } from './ConnectionsScreen';
import { CreateTableTab } from './CreateTableTab';
import { Sidebar } from './Sidebar';
import { SqlTab } from './SqlTab';
import { TableTab } from './TableTab';
import { TabBar } from './TabBar';
import { ErrorBoundary } from './ErrorBoundary';
import { FeedbackDialog } from './FeedbackDialog';
import { UpdateButton } from './UpdateButton';
import { Modal } from './common';

export function App() {
  const { screen, tabs, activeTabId, activeProfileId, newSqlTab, setScreen, loadProfiles, toasts } = useApp();
  const { discardPrompt, resolveDiscard } = useApp();
  const profiles = useApp((s) => s.profiles);
  const [newRequested, setNewRequested] = useState(0);
  const [feedback, setFeedback] = useState<{ screenshot: string | null } | null>(null);
  const feedbackOpen = useRef(false);

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
        const s = useApp.getState();
        if (cmd === 'new-connection') {
          s.setScreen('connections');
          setNewRequested((n) => n + 1);
        }
        if (cmd === 'new-sql-tab' && s.activeProfileId && s.connections[s.activeProfileId]) s.newSqlTab(s.activeProfileId);
        if (cmd === 'close-tab' && s.activeTabId && s.screen === 'workspace') s.closeTab(s.activeTabId);
        if (cmd === 'close-all-tabs' && s.screen === 'workspace') s.closeTabs(s.tabs.map(({ id }) => id));
        if (cmd === 'refresh' && s.activeTabId && s.screen === 'workspace') s.refreshTab(s.activeTabId);
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
            <div className="tab-content">
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
                  <ErrorBoundary label="this tab">
                  {t.kind === 'table' && (
                    <TableTab tabId={t.id} profileId={t.profileId} object={t.object} objectKind={t.objectKind} initialView={t.initialView} active={t.id === activeTabId} refreshVersion={t.refreshVersion} />
                  )}
                  {t.kind === 'sql' && <SqlTab profileId={t.profileId} initialSql={t.initialSql} context={t.context} active={t.id === activeTabId} refreshVersion={t.refreshVersion} />}
                  {t.kind === 'create' && <CreateTableTab tabId={t.id} profileId={t.profileId} container={t.container} refreshVersion={t.refreshVersion} />}
                  </ErrorBoundary>
                </div>
              ))}
            </div>
          </main>
        </>
      )}
      </div>
      <footer className="app-footer">
        <UpdateButton />
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
      <span hidden>{profiles.length}</span>
    </div>
  );
}
