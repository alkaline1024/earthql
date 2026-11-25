import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { version as appVersion } from '../../../../package.json';
import { api, onMenuCommand } from '../api';
import { connectionName, useApp, type Tab } from '../store';
import { ConnectionsScreen } from './ConnectionsScreen';
import { CreateTableTab } from './CreateTableTab';
import { Sidebar } from './Sidebar';
import { SqlTab } from './SqlTab';
import { TableTab } from './TableTab';
import { TabBar } from './TabBar';
import { PanelDropPreview } from './PanelDropPreview';
import { ErrorBoundary } from './ErrorBoundary';
import { FeedbackDialog } from './FeedbackDialog';
import { SettingsDialog } from './SettingsDialog';
import { NotificationsButton } from './NotificationsButton';
import { UpdateButton } from './UpdateButton';
import { Modal } from './common';
import { Keys, useShortcuts } from './Shortcut';

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
        <TableTab tabId={t.id} profileId={t.profileId} object={t.object} objectKind={t.objectKind} initialView={t.initialView} initialFilters={t.initialFilters} active={active} refreshVersion={t.refreshVersion} />
      )}
      {t.kind === 'sql' && <SqlTab key={t.profileId} tabId={t.id} profileId={t.profileId} initialSql={t.initialSql} context={t.context} active={active} refreshVersion={t.refreshVersion} />}
      {t.kind === 'create' && <CreateTableTab tabId={t.id} profileId={t.profileId} container={t.container} refreshVersion={t.refreshVersion} />}
    </ErrorBoundary>
  );
}

/** Reparent the host, keeping the editor/grid React tree mounted when a tab moves panels. */
function MountedTab({ tab, host, visible, active }: { tab: Tab; host: HTMLDivElement | null; visible: boolean; active: boolean }) {
  const [element] = useState(() => {
    const element = document.createElement('div');
    element.className = 'tab-pane';
    return element;
  });
  useLayoutEffect(() => {
    host?.appendChild(element);
    return () => { element.remove(); };
  }, [host, element]);
  useLayoutEffect(() => { element.hidden = !visible; }, [element, visible]);
  useLayoutEffect(() => {
    const activate = () => {
      if (visible && useApp.getState().activeTabId !== tab.id) useApp.getState().activateTab(tab.id);
    };
    element.addEventListener('pointerdown', activate, true);
    element.addEventListener('focusin', activate, true);
    return () => {
      element.removeEventListener('pointerdown', activate, true);
      element.removeEventListener('focusin', activate, true);
    };
  }, [element, tab.id, visible]);
  return createPortal(renderTabContent(tab, active), element);
}

export function App() {
  const sc = useShortcuts();
  useEffect(() => {
    const clearDrag = () => useApp.getState().setDraggedTabId(null);
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('drop', clearDrag);
    window.addEventListener('blur', clearDrag);
    return () => {
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('drop', clearDrag);
      window.removeEventListener('blur', clearDrag);
    };
  }, []);

  // The menu is built with default shortcuts at launch; push the saved overrides once the UI is up.
  useEffect(() => {
    void api.keybindings.apply(useApp.getState().keybindings).catch(() => undefined);
  }, []);
  const { screen, tabs, activeTabId, activeProfileId, newSqlTab, setScreen, loadProfiles, toasts } = useApp();
  const { discardPrompt, resolveDiscard } = useApp();
  const { splitPane, closeSplit, focusedPane, focusPane, draggedTabId } = useApp();
  const [mainHost, setMainHost] = useState<HTMLDivElement | null>(null);
  const [splitHost, setSplitHost] = useState<HTMLDivElement | null>(null);
  const profiles = useApp((s) => s.profiles);
  const editProfileId = useApp((s) => s.editProfileId);
  const [newRequested, setNewRequested] = useState(0);
  const [feedback, setFeedback] = useState<{ screenshot: string | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [splitWidth, setSplitWidth] = useState<number | null>(null);
  const [splitHeight, setSplitHeight] = useState<number | null>(null);
  const mainTabId = splitPane ? splitPane.mainTabId : activeTabId;
  const mainTabs = tabs.filter((tab) => !splitPane?.tabIds.includes(tab.id));
  const mainSplitRef = useRef<HTMLDivElement>(null);
  const feedbackOpen = useRef(false);

  function startSplitResize(e: React.MouseEvent) {
    const rect = mainSplitRef.current!.getBoundingClientRect();
    const side = splitPane?.side;
    const move = (ev: MouseEvent) => {
      if (side === 'up' || side === 'down') {
        const h = side === 'down' ? rect.bottom - ev.clientY : ev.clientY - rect.top;
        setSplitHeight(Math.max(120, Math.min(h, rect.height - 120)));
      } else {
        const w = side === 'right' ? rect.right - ev.clientX : ev.clientX - rect.left;
        setSplitWidth(Math.max(200, Math.min(w, rect.width - 200)));
      }
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
          useApp.setState({ editProfileId: undefined });
          setNewRequested((n) => n + 1);
        }
        if (cmd === 'new-sql-tab' && s.activeProfileId && s.connections[s.activeProfileId]) s.newSqlTab(s.activeProfileId);
        if (cmd === 'close-tab' && s.activeTabId && s.screen === 'workspace') s.closeTab(s.activeTabId);
        if (cmd === 'close-all-tabs' && s.screen === 'workspace') s.closeTabs(s.tabs.map(({ id }) => id));
        if (cmd === 'reopen-closed-tab' && s.screen === 'workspace') s.reopenClosedTab();
        if (cmd === 'reconnect' && s.screen === 'workspace' && s.activeProfileId && s.connections[s.activeProfileId] && !s.connecting[s.activeProfileId]) {
          const id = s.activeProfileId;
          void s.connect(id).then((ok) => {
            const error = useApp.getState().connectErrors[id];
            if (ok) s.toast('ok', `Reconnected to ${connectionName(id)}.`);
            else if (error) s.toast('error', error.message);
          });
        }
        if (cmd === 'refresh' && s.activeTabId && s.screen === 'workspace') s.refreshTab(s.activeTabId);
        if (cmd === 'split-left' && s.activeTabId && s.screen === 'workspace') s.openSplit(s.activeTabId, 'left');
        if (cmd === 'split-right' && s.activeTabId && s.screen === 'workspace') s.openSplit(s.activeTabId, 'right');
        if (cmd === 'split-up' && s.activeTabId && s.screen === 'workspace') s.openSplit(s.activeTabId, 'up');
        if (cmd === 'split-down' && s.activeTabId && s.screen === 'workspace') s.openSplit(s.activeTabId, 'down');
      }),
    [openFeedback],
  );

  const splitVertical = splitPane?.side === 'up' || splitPane?.side === 'down';
  const splitFirst = splitPane?.side === 'left' || splitPane?.side === 'up';
  const splitPaneEl = splitPane && (
    <div className={`split-pane${splitVertical ? ' vertical' : ''}${focusedPane === 'split' ? ' focused' : ''}`}
      style={splitVertical ? { height: splitHeight ?? undefined } : { width: splitWidth ?? undefined }}
      onPointerDownCapture={(event) => { if (!(event.target instanceof Element && event.target.closest('.new-sql-tab'))) focusPane('split'); }} onFocusCapture={(event) => { if (!event.target.closest('.new-sql-tab') && useApp.getState().focusedPane !== 'split') focusPane('split'); }}>
      <div className="panel-tab-bar"><TabBar pane="split" />
        <button type="button" className="btn ghost icon merge-panel" aria-label="Merge panels" title="Merge panels" onClick={closeSplit}>✕</button>
      </div>
      <div className="tab-content" ref={setSplitHost}><PanelDropPreview key={draggedTabId ?? 'idle'} pane="split" /></div>
    </div>
  );
  const splitDividerEl = splitPaneEl && <div className={`split-divider${splitVertical ? ' row' : ''}`} role="separator" aria-label="Resize panels" aria-orientation={splitVertical ? 'horizontal' : 'vertical'} onMouseDown={startSplitResize} />;

  return (
    <div className="app">
      <div className="app-content">
      {screen === 'connections' ? (
        <ConnectionsScreen key={newRequested} initialNew={!editProfileId && newRequested > 0} initialProfileId={editProfileId} />
      ) : (
        <>
          <Sidebar />
          <main className="main">
            <div className={`main-split${splitPane ? ' has-split' : ''}${splitVertical ? ' vertical' : ''}`} ref={mainSplitRef}>
              {splitFirst && <>{splitPaneEl}{splitDividerEl}</>}
              <div className={`workspace-panel${focusedPane === 'main' ? ' focused' : ''}`} onPointerDownCapture={(event) => { if (!(event.target instanceof Element && event.target.closest('.new-sql-tab'))) focusPane('main'); }}
                onFocusCapture={(event) => { if (!event.target.closest('.new-sql-tab') && useApp.getState().focusedPane !== 'main') focusPane('main'); }}>
                <TabBar pane="main" />
                <div className="tab-content" ref={setMainHost}>
                <PanelDropPreview key={draggedTabId ?? 'idle'} pane="main" />
                {mainTabs.length === 0 && (
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
                </div>
              </div>
              {!splitFirst && <>{splitDividerEl}{splitPaneEl}</>}
            </div>
          </main>
          {tabs.map((tab) => {
            const inSplit = !!splitPane?.tabIds.includes(tab.id);
            const visible = tab.id === (inSplit ? splitPane?.tabId : mainTabId);
            return <MountedTab key={tab.id} tab={tab} host={inSplit ? splitHost : mainHost} visible={visible} active={visible && tab.id === activeTabId} />;
          })}
        </>
      )}
      </div>
      <footer className="app-footer">
        <button className="btn small ghost no-drag" aria-keyshortcuts={sc.aria('open-settings')} onClick={() => setSettingsOpen(true)}>
          <GearIcon /> Settings
        </button>
        <button className="btn small ghost no-drag" onClick={openFeedback}>
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeLinejoin="round">
            <path d="M2 2.5h12v8.5H7l-3 2.5V11H2zM8 4.5v3m0 1v1" />
          </svg>
          Feedback &amp; Bug Report
        </button>
        <span className="muted small" title={`EarthQL version ${appVersion}`}>v{appVersion}</span>
        <span className="spacer" />
        <UpdateButton />
        <NotificationsButton />
      </footer>
      <div className="toasts">
        {toasts.map((t) => (
          <button type="button" key={t.id} className={`toast ${t.kind}`}
            aria-label={`Dismiss notification: ${t.text}`} title="Dismiss notification"
            onClick={() => useApp.getState().dismissToast(t.id)}>
            {t.text}
          </button>
        ))}
      </div>
      {discardPrompt && (
        <Modal narrow title="Unsaved changes" onClose={() => resolveDiscard(false)} footer={<>
          <button className="btn" autoFocus onClick={() => resolveDiscard(false)}>Cancel</button>
          <button className="btn danger" onClick={() => resolveDiscard(true)}>Discard changes</button>
        </>}>
          <p>Discard all changes?</p>
          <p className="muted small">Your unsaved Data and Structure changes will be lost.</p>
          <div className="discard-save-tip">Save your changes with {sc.label('save') && <><Keys keys={sc.label('save')} /> or </>}the <strong>Save</strong> button above the table.</div>
        </Modal>
      )}
      {feedback && <FeedbackDialog screenshot={feedback.screenshot} onClose={() => { feedbackOpen.current = false; setFeedback(null); }} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      <span hidden>{profiles.length}</span>
    </div>
  );
}
