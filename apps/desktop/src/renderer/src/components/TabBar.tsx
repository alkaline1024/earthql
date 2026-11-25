import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import { describePath } from '@earthql/core';
import { connectionName, profileOf, useApp, type Tab } from '../store';
import { TAB_GROUP_COLORS, type TabGroup } from '../tab-groups';
import { hasUnsavedChanges } from '../unsaved-changes';
import { ContextSubmenu } from './ContextSubmenu';
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
  groupId?: string;
}

interface GroupEditor {
  id?: string;
  name: string;
  color: string;
  ids: string[];
}

interface DropTarget {
  id: string;
  after: boolean;
}

export function TabBar() {
  const {
    tabs, activeTabId, activeProfileId, activateTab, closeTab, closeTabs, newSqlTab, refreshTab, renameTab,
    tabGroups, moveTab, moveTabsToGroup, createTabGroup, renameTabGroup, setTabGroupColor, toggleTabGroupCollapsed, removeTabGroup,
    openSplit,
  } = useApp();
  const gridDrafts = useApp((s) => s.gridDrafts);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const [rename, setRename] = useState<{ id: string; title: string } | null>(null);
  const [closeTip, setCloseTip] = useState<TabMenu | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [groupEditor, setGroupEditor] = useState<GroupEditor | null>(null);
  const [groupError, setGroupError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const focusBeforeMenu = useRef<HTMLElement | null>(null);
  const target = tabs.find((tab) => tab.id === menu?.tabId);
  const menuGroup = tabGroups.find((group) => group.id === menu?.groupId);
  const profileId = target?.profileId ?? activeProfileId;

  const groupOf = new Map(tabGroups.flatMap((group) => group.tabIds.map((id) => [id, group] as const)));
  const segments: { group: TabGroup | null; tabs: Tab[] }[] = [];
  for (const tab of tabs) {
    const group = groupOf.get(tab.id) ?? null;
    const last = segments.at(-1);
    if (last && last.group?.id === group?.id) last.tabs.push(tab);
    else segments.push({ group, tabs: [tab] });
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

  function openMenu(x: number, y: number, tabId?: string, groupId?: string) {
    focusBeforeMenu.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCloseTip(null);
    setMenu({ x, y, tabId, groupId });
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

  function openGroupEditor(seed: GroupEditor) {
    setMenu(null);
    setGroupError('');
    setGroupEditor(seed);
  }

  function saveGroupEditor(event: FormEvent) {
    event.preventDefault();
    if (!groupEditor) return;
    const name = groupEditor.name.trim();
    if (!name) { setGroupError('Enter a group name.'); return; }
    if (tabGroups.some((group) => group.id !== groupEditor.id && group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setGroupError('A group with this name already exists.');
      return;
    }
    if (groupEditor.id) {
      renameTabGroup(groupEditor.id, name);
      setTabGroupColor(groupEditor.id, groupEditor.color);
    } else {
      createTabGroup(name, groupEditor.ids, groupEditor.color);
    }
    setGroupEditor(null);
  }

  function renderTab(tab: Tab) {
    const profile = profileOf(tab.profileId)?.profile;
    const title = tabTitle(tab);
    const unsaved = hasUnsavedChanges(gridDrafts[tab.id]);
    const detail = tab.kind === 'table' ? describePath(tab.object) : title;
    const subtitle = tab.kind === 'table' ? describePath({ ...tab.object, name: '' }).replace(/\.$/, '') : '';
    return (
      <div
        key={tab.id}
        data-tab-id={tab.id}
        className={`tab${tab.id === activeTabId ? ' active' : ''}${draggingId === tab.id ? ' dragging' : ''}${dropTarget?.id === tab.id ? (dropTarget.after ? ' drop-after' : ' drop-before') : ''}`}
        style={{ '--env': profile?.env.color ?? 'transparent' } as CSSProperties}
        draggable
        onMouseDown={(event) => {
          if (event.button === 1) closeTab(tab.id);
          if (event.button === 0 && !event.ctrlKey) activateTab(tab.id);
        }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', tab.id);
          setMenu(null);
          setDraggingId(tab.id);
        }}
        onDragOver={(event) => {
          if (!draggingId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          setDropTarget(draggingId === tab.id ? null : { id: tab.id, after: event.clientX > rect.left + rect.width / 2 });
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (draggingId && draggingId !== tab.id) {
            const rect = event.currentTarget.getBoundingClientRect();
            moveTabsToGroup([draggingId], groupOf.get(tab.id)?.id ?? null);
            moveTab(draggingId, tab.id, event.clientX > rect.left + rect.width / 2);
          }
          setDraggingId(null);
          setDropTarget(null);
        }}
        onDragEnd={() => {
          setDraggingId(null);
          setDropTarget(null);
          setDragGroupId(null);
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
  }

  return (
    <>
      <div className="main-top drag">
        {activeProfileId && (
          <button
            type="button"
            className="btn text no-drag new-sql-tab"
            aria-label="New SQL Query"
            aria-keyshortcuts="Meta+T"
            data-tooltip="+ New SQL Query (⌘T)"
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
          {segments.map(({ group, tabs: segmentTabs }, index) => {
            if (!group) return <Fragment key={`u-${segmentTabs[0]?.id ?? index}`}>{segmentTabs.map(renderTab)}</Fragment>;
            return (
              <div key={group.id} className="tab-group" style={{ '--group-color': group.color } as CSSProperties}>
                <button
                  type="button"
                  data-group-id={group.id}
                  className={`tab-group-label${dragGroupId === group.id ? ' drop-target' : ''}`}
                  aria-expanded={!group.collapsed}
                  onClick={() => toggleTabGroupCollapsed(group.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(event.clientX, event.clientY, undefined, group.id);
                  }}
                  onDragOver={(event) => {
                    if (!draggingId) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDragGroupId(group.id);
                    setDropTarget(null);
                  }}
                  onDragLeave={() => setDragGroupId(null)}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (draggingId) {
                      moveTabsToGroup([draggingId], group.id);
                      if (group.collapsed) toggleTabGroupCollapsed(group.id);
                    }
                    setDraggingId(null);
                    setDropTarget(null);
                    setDragGroupId(null);
                  }}
                >
                  <span aria-hidden="true">{group.collapsed ? '▸' : '▾'}</span>
                  <span className="grow">{group.name}</span>
                  <span className="muted">{group.tabIds.length}</span>
                </button>
                {!group.collapsed && segmentTabs.map(renderTab)}
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
          {menuGroup && (
            <>
              <button type="button" role="menuitem" onClick={() => invoke(() => openGroupEditor({ id: menuGroup.id, name: menuGroup.name, color: menuGroup.color, ids: [] }))}>
                Rename Group…
              </button>
              <button type="button" role="menuitem" onClick={() => invoke(() => removeTabGroup(menuGroup.id))}>Remove Group (keep tabs)</button>
              <div className="conn-menu-separator" role="separator" />
            </>
          )}
          <button type="button" role="menuitem" disabled={!profileId} onClick={() => invoke(() => { if (profileId) newSqlTab(profileId); })}>
            <span>＋ New SQL Query</span><kbd>⌘T</kbd>
          </button>
          {target && (
            <>
              <div className="conn-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => invoke(() => refreshTab(target.id))}><span>Refresh</span><kbd>⌘R</kbd></button>
              <button type="button" role="menuitem" onClick={() => invoke(() => setRename({ id: target.id, title: tabTitle(target) }))}>Rename Tab</button>
              <ContextSubmenu label="Add to Group">
                <button type="button" role="menuitem" onClick={() => invoke(() => moveTabsToGroup([target.id], null))}>Ungrouped</button>
                {tabGroups.map((group) => (
                  <button type="button" key={group.id} role="menuitem" onClick={() => invoke(() => moveTabsToGroup([target.id], group.id))}>{group.name}</button>
                ))}
                <div className="conn-menu-separator" role="separator" />
                <button type="button" role="menuitem" onClick={() => invoke(() => openGroupEditor({ name: '', color: TAB_GROUP_COLORS[0], ids: [target.id] }))}>New Group…</button>
              </ContextSubmenu>
              <div className="conn-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => invoke(() => openSplit(target.id, 'left'))}><span>Split Left</span><kbd>⌘[</kbd></button>
              <button type="button" role="menuitem" onClick={() => invoke(() => openSplit(target.id, 'right'))}><span>Split Right</span><kbd>⌘]</kbd></button>
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
      {groupEditor && (
        <Modal title={groupEditor.id ? 'Rename Group' : 'New Group'} narrow onClose={() => setGroupEditor(null)}>
          <form onSubmit={saveGroupEditor} style={{ display: 'grid', gap: 12 }}>
            <label htmlFor="tab-group-name">Group name</label>
            <input id="tab-group-name" className="input" style={{ width: '100%', marginTop: -6 }} autoFocus value={groupEditor.name}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setGroupEditor({ ...groupEditor, name: event.target.value })} />
            {!groupEditor.id && groupEditor.ids.length > 0 && <span className="muted">Move {groupEditor.ids.length} tab{groupEditor.ids.length === 1 ? '' : 's'} into this group.</span>}
            <div className="row" role="radiogroup" aria-label="Group color" style={{ gap: 6 }}>
              {TAB_GROUP_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={groupEditor.color === color}
                  aria-label={color}
                  className="tab-group-swatch"
                  style={{ '--swatch': color } as CSSProperties}
                  onClick={() => setGroupEditor({ ...groupEditor, color })}
                >
                  {groupEditor.color === color && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
            {groupError && <span role="alert" style={{ color: 'var(--danger)' }}>{groupError}</span>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setGroupEditor(null)}>Cancel</button>
              <button type="submit" className="btn primary">{groupEditor.id ? 'Save' : 'Create Group'}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
