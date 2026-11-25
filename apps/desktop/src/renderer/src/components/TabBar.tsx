import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { describePath } from '@earthql/core';
import { connectionName, profileOf, useApp, type Tab } from '../store';
import { hasUnsavedChanges } from '../unsaved-changes';
import { Modal } from './common';

function tabTitle(tab: Tab) {
  if (tab.customTitle) return tab.customTitle;
  if (tab.kind === 'table') return tab.object.name;
  return tab.kind === 'sql' ? tab.title : 'New table';
}

interface TabMenu {
  x: number;
  y: number;
  tabId?: string;
}

export function TabBar() {
  const { tabs, activeTabId, activeProfileId, activateTab, closeTab, closeTabs, newSqlTab, refreshTab, renameTab } = useApp();
  const gridDrafts = useApp((s) => s.gridDrafts);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const [rename, setRename] = useState<{ id: string; title: string } | null>(null);
  const [closeTip, setCloseTip] = useState<TabMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusBeforeMenu = useRef<HTMLElement | null>(null);
  const target = tabs.find((tab) => tab.id === menu?.tabId);
  const profileId = target?.profileId ?? activeProfileId;

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

  function openMenu(x: number, y: number, tabId?: string) {
    focusBeforeMenu.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCloseTip(null);
    setMenu({ x, y, tabId });
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      setMenu(null);
      focusBeforeMenu.current?.focus();
      if (event.key === 'Escape') event.preventDefault();
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

  function showCloseTip(button: HTMLButtonElement, tabId: string) {
    const rect = button.getBoundingClientRect();
    setCloseTip({ x: rect.right, y: rect.bottom + 5, tabId });
  }

  function hideCloseTip(tabId: string) {
    setCloseTip((tip) => tip?.tabId === tabId ? null : tip);
  }

  function invoke(action: () => void) {
    setMenu(null);
    action();
  }

  return (
    <>
      <div className="main-top drag">
        {activeProfileId && (
          <button
            type="button"
            className="btn small primary no-drag new-sql-tab"
            aria-label="New SQL Query"
            aria-keyshortcuts="Meta+T"
            data-tooltip="+ New SQL Query (Command + T)"
            onClick={() => newSqlTab(activeProfileId)}
          >
            ＋ SQL
          </button>
        )}
        <div
          className="tabs no-drag"
          onContextMenu={(event) => {
            event.preventDefault();
            const tabId = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tab-id]')?.dataset.tabId : undefined;
            openMenu(event.clientX, event.clientY, tabId);
          }}
          onScroll={() => setCloseTip(null)}
        >
          {tabs.map((tab) => {
            const profile = profileOf(tab.profileId)?.profile;
            const title = tabTitle(tab);
            const unsaved = hasUnsavedChanges(gridDrafts[tab.id]);
            const detail = tab.kind === 'table' ? describePath(tab.object) : title;
            const subtitle = tab.kind === 'table' ? describePath({ ...tab.object, name: '' }).replace(/\.$/, '') : '';
            return (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                className={`tab${tab.id === activeTabId ? ' active' : ''}`}
                style={{ '--env': profile?.env.color ?? 'transparent' } as CSSProperties}
                onMouseDown={(event) => {
                  if (event.button === 1) closeTab(tab.id);
                  if (event.button === 0 && !event.ctrlKey) activateTab(tab.id);
                }}
                title={`${connectionName(tab.profileId)}${profile?.env.name ? ` (${profile.env.name})` : ''} — ${detail}`}
              >
                <span className="stripe" />
                <span className="muted">{tab.kind === 'sql' ? '⌨︎' : tab.kind === 'create' ? '＋' : tab.objectKind === 'view' ? '◇' : '▦'}</span>
                <span className="t-title">
                  {title}
                  <div className="t-sub">{tab.kind === 'table' ? profile?.name : connectionName(tab.profileId)}{subtitle ? ` · ${subtitle}` : ''}</div>
                </span>
                {unsaved && <span className="unsaved-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
                <button
                  type="button"
                  className="t-close"
                  aria-label="Close tab"
                  title=""
                  onMouseDown={(event) => event.stopPropagation()}
                  onMouseEnter={(event) => showCloseTip(event.currentTarget, tab.id)}
                  onMouseLeave={() => hideCloseTip(tab.id)}
                  onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) showCloseTip(event.currentTarget, tab.id); }}
                  onBlur={() => hideCloseTip(tab.id)}
                  onClick={() => { hideCloseTip(tab.id); closeTab(tab.id); }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {closeTip && !menu && tabs.some((tab) => tab.id === closeTip.tabId) && (
        <div className="tab-close-tooltip" aria-hidden="true" style={{ left: closeTip.x, top: closeTip.y }}>Close (⌘W)</div>
      )}
      {menu && (
        <div className="tab-context-menu" ref={menuRef} role="menu" aria-label="Tab actions" onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" disabled={!profileId} onClick={() => invoke(() => { if (profileId) newSqlTab(profileId); })}>
            <span>＋ New SQL Query</span><kbd>⌘T</kbd>
          </button>
          {target && (
            <>
              <div className="conn-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => invoke(() => refreshTab(target.id))}><span>Refresh</span><kbd>⌘R</kbd></button>
              <button type="button" role="menuitem" onClick={() => invoke(() => setRename({ id: target.id, title: tabTitle(target) }))}>Rename Tab</button>
              <div className="conn-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => invoke(() => closeTab(target.id))}><span>Close Tab</span><kbd>⌘W</kbd></button>
              <button type="button" role="menuitem" disabled={tabs.length < 2} onClick={() => invoke(() => closeTabs(tabs.filter((tab) => tab.id !== target.id).map((tab) => tab.id), target.id))}>
                Close Other Tabs
              </button>
              <button type="button" role="menuitem" onClick={() => invoke(() => closeTabs(tabs.map((tab) => tab.id)))}><span>Close All</span><kbd>⌘⇧W</kbd></button>
            </>
          )}
        </div>
      )}
      {rename && tabs.some((tab) => tab.id === rename.id) && (
        <Modal title="Rename Tab" narrow onClose={() => setRename(null)}>
          <form onSubmit={(event) => { event.preventDefault(); if (rename.title.trim()) { renameTab(rename.id, rename.title); setRename(null); } }}>
            <label htmlFor="tab-name">Tab name</label>
            <input id="tab-name" className="input" style={{ width: '100%', marginTop: 4 }} autoFocus value={rename.title}
              onFocus={(event) => event.currentTarget.select()} onChange={(event) => setRename({ ...rename, title: event.target.value })} />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" className="btn" onClick={() => setRename(null)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!rename.title.trim()}>Rename</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
