/**
 * The keybinding registry — the single source of truth for every keyboard shortcut in EarthQL.
 *
 * Imported by the main process (native menu accelerators), the renderer (Settings > Shortcuts,
 * shortcut hints, in-component key handlers) and tests, so it must stay free of electron/react imports.
 *
 * Adding a shortcut? Add a `SHORTCUTS` entry here — see "Keyboard shortcuts" in CLAUDE.md.
 */

export const SHORTCUT_CATEGORIES = [
  'General',
  'Tabs',
  'Connections',
  'Query',
  'View',
  'Tables',
  'SQL Query',
  'Data grid',
  'Lists & sidebar',
  'System',
] as const;
export type ShortcutCategory = (typeof SHORTCUT_CATEGORIES)[number];

/**
 * - `menu`:  bound through the native application menu (rebindable). `command` is the `menu:command` payload.
 * - `app`:   handled by a renderer key handler via `matchesAccelerator` (rebindable).
 * - `fixed`: built into the OS / CodeMirror / a component. Shown for reference, cannot be rebound.
 *            If it has an `accelerator` it is also reserved, so rebindable shortcuts can't collide with it.
 */
export type ShortcutKind = 'menu' | 'app' | 'fixed';

export interface ShortcutDef {
  id: string;
  label: string;
  category: ShortcutCategory;
  kind: ShortcutKind;
  /** Default accelerator in Electron format, e.g. `CmdOrCtrl+Shift+T`. */
  accelerator?: string;
  /** `menu:command` sent to the renderer when the menu item fires (kind `menu`). */
  command?: string;
  /** Native menu label when it differs from `label` (e.g. with a trailing ellipsis). */
  menuLabel?: string;
  /** Display text for shortcuts that are not a single accelerator, e.g. `⇧↑ ⇧↓`. */
  keys?: string;
  note?: string;
}

export const GRID_COPY_FORMATS = [
  { format: 'plain', label: 'Plain Text' },
  { format: 'json', label: 'JSON' },
  { format: 'html', label: 'HTML' },
  { format: 'markdown', label: 'Markdown Table' },
  { format: 'csv', label: 'CSV' },
  { format: 'csv-header', label: 'CSV with Header' },
  { format: 'insert', label: 'INSERT Statement' },
] as const;

export const SHORTCUTS: readonly ShortcutDef[] = [
  // General
  { id: 'open-settings', label: 'Settings', menuLabel: 'Preferences…', category: 'General', kind: 'menu', accelerator: 'CmdOrCtrl+,', command: 'open-settings' },
  { id: 'dismiss', label: 'Close dialog, menu or popup', category: 'General', kind: 'fixed', keys: '⎋' },

  // Tabs
  { id: 'new-sql-tab', label: 'New SQL query tab', menuLabel: 'New SQL Query Tab', category: 'Tabs', kind: 'menu', accelerator: 'CmdOrCtrl+T', command: 'new-sql-tab' },
  { id: 'reopen-closed-tab', label: 'Reopen closed tab', menuLabel: 'Reopen Closed Tab', category: 'Tabs', kind: 'menu', accelerator: 'CmdOrCtrl+Shift+T', command: 'reopen-closed-tab', note: 'Remembers the last 25 closed tabs.' },
  { id: 'close-tab', label: 'Close tab', menuLabel: 'Close Tab', category: 'Tabs', kind: 'menu', accelerator: 'CmdOrCtrl+W', command: 'close-tab' },
  { id: 'close-all-tabs', label: 'Close all tabs', menuLabel: 'Close All Tabs', category: 'Tabs', kind: 'menu', accelerator: 'CmdOrCtrl+Shift+W', command: 'close-all-tabs' },

  // Connections
  { id: 'new-connection', label: 'New connection', menuLabel: 'New Connection…', category: 'Connections', kind: 'menu', accelerator: 'CmdOrCtrl+Shift+N', command: 'new-connection' },

  // Query
  { id: 'run', label: 'Run current', menuLabel: 'Run Current', category: 'Query', kind: 'menu', accelerator: 'CmdOrCtrl+Enter', command: 'run', note: 'Runs the selection, or the statement under the cursor.' },
  { id: 'run-all', label: 'Run all', menuLabel: 'Run All', category: 'Query', kind: 'menu', accelerator: 'CmdOrCtrl+Shift+Enter', command: 'run-all' },
  { id: 'cancel', label: 'Cancel running query', menuLabel: 'Cancel', category: 'Query', kind: 'menu', accelerator: 'CmdOrCtrl+.', command: 'cancel' },
  { id: 'beautify', label: 'Beautify SQL', menuLabel: 'Beautify', category: 'Query', kind: 'menu', accelerator: 'CmdOrCtrl+I', command: 'beautify' },
  { id: 'uglify', label: 'Uglify SQL', menuLabel: 'Uglify', category: 'Query', kind: 'menu', accelerator: 'CmdOrCtrl+Shift+I', command: 'uglify', note: 'Collapses the SQL onto one line.' },
  { id: 'save', label: 'Add to Queries / save', menuLabel: 'Add to Queries', category: 'Query', kind: 'menu', accelerator: 'CmdOrCtrl+S', command: 'save', note: 'Also saves cell edits in a table tab and the open connection form.' },
  { id: 'save-sql-file', label: 'Save SQL as file', menuLabel: 'Save SQL as…', category: 'Query', kind: 'menu', accelerator: 'CmdOrCtrl+Shift+S', command: 'save-sql-file' },

  // View
  { id: 'reconnect', label: 'Reconnect active connection', menuLabel: 'Reconnect', category: 'View', kind: 'menu', accelerator: 'CmdOrCtrl+Shift+R', command: 'reconnect' },
  { id: 'refresh', label: 'Refresh tab', menuLabel: 'Refresh', category: 'View', kind: 'menu', accelerator: 'CmdOrCtrl+R', command: 'refresh' },
  { id: 'split-left', label: 'Split left', menuLabel: 'Split Left', category: 'View', kind: 'menu', accelerator: 'CmdOrCtrl+[', command: 'split-left' },
  { id: 'split-right', label: 'Split right', menuLabel: 'Split Right', category: 'View', kind: 'menu', accelerator: 'CmdOrCtrl+]', command: 'split-right' },
  { id: 'split-up', label: 'Split up', menuLabel: 'Split Up', category: 'View', kind: 'menu', accelerator: 'CmdOrCtrl+Shift+[', command: 'split-up' },
  { id: 'split-down', label: 'Split down', menuLabel: 'Split Down', category: 'View', kind: 'menu', accelerator: 'CmdOrCtrl+Shift+]', command: 'split-down' },

  // Tables (focus must be on a table in the sidebar)
  { id: 'table-delete', label: 'Delete selected tables', category: 'Tables', kind: 'app', accelerator: 'CmdOrCtrl+Backspace', note: 'With a table focused in the sidebar.' },
  { id: 'table-truncate', label: 'Truncate selected tables', category: 'Tables', kind: 'app', accelerator: 'Alt+Backspace', note: 'With a table focused in the sidebar.' },

  // SQL Query (CodeMirror)
  { id: 'editor-accept-completion', label: 'Accept autocomplete suggestion', category: 'SQL Query', kind: 'fixed', keys: '⇥', note: 'Indents when no suggestion is showing.' },
  { id: 'editor-outdent', label: 'Outdent', category: 'SQL Query', kind: 'fixed', keys: '⇧⇥' },
  { id: 'editor-complete', label: 'Show autocomplete', category: 'SQL Query', kind: 'fixed', accelerator: 'Ctrl+Space' },
  { id: 'editor-undo', label: 'Undo', category: 'SQL Query', kind: 'fixed', accelerator: 'CmdOrCtrl+Z' },
  { id: 'editor-redo', label: 'Redo', category: 'SQL Query', kind: 'fixed', accelerator: 'CmdOrCtrl+Shift+Z' },
  { id: 'editor-find', label: 'Find', category: 'SQL Query', kind: 'fixed', accelerator: 'CmdOrCtrl+F' },
  { id: 'editor-comment', label: 'Toggle comment', category: 'SQL Query', kind: 'fixed', accelerator: 'CmdOrCtrl+/' },
  { id: 'editor-move-line-up', label: 'Move line up', category: 'SQL Query', kind: 'fixed', accelerator: 'Alt+Up' },
  { id: 'editor-move-line-down', label: 'Move line down', category: 'SQL Query', kind: 'fixed', accelerator: 'Alt+Down' },

  // Data grid: Copy As shortcuts are unbound until configured in Settings.
  ...(['cells', 'rows'] as const).flatMap((scope) => GRID_COPY_FORMATS.map(({ format, label }): ShortcutDef => ({
    id: `grid-copy-${scope}-${format}`,
    label: `Copy ${scope === 'cells' ? 'cells' : 'rows'} as ${label}`,
    category: 'Data grid',
    kind: 'app',
    note: format === 'insert' ? 'With a grid selection in a table that supports INSERT statements.' : 'With a selection focused in the data grid.',
  }))),
  { id: 'grid-copy', label: 'Copy rows', category: 'Data grid', kind: 'fixed', keys: '⌘C', note: 'Copies every column of the selected rows.' },
  { id: 'grid-add-row', label: 'Add row', category: 'Data grid', kind: 'app', note: 'Stages a new row until Save.' },
  { id: 'grid-duplicate-rows', label: 'Duplicate rows', category: 'Data grid', kind: 'app', accelerator: 'CmdOrCtrl+D', note: 'Stages copies of the selected rows until Save.' },
  { id: 'grid-delete-rows', label: 'Delete rows', category: 'Data grid', kind: 'app', accelerator: 'Backspace', note: 'Marks selected rows for deletion on Save; text editing keeps native deletion.' },
  { id: 'grid-paste-rows', label: 'Paste rows', category: 'Data grid', kind: 'fixed', keys: '⌘V', note: 'Copied rows are staged as new rows in a table. Text editing keeps native paste.' },
  { id: 'grid-paste-fill', label: 'Paste into selected cells', category: 'Data grid', kind: 'app', accelerator: 'CmdOrCtrl+Shift+V' },
  { id: 'grid-select-all', label: 'Select all cells', category: 'Data grid', kind: 'fixed', keys: '⌘A', note: 'With a cell selection focused in the grid. Selects all loaded rows and columns.' },
  { id: 'grid-open', label: 'Quick Look / edit cell', category: 'Data grid', kind: 'fixed', keys: '↵ F2' },
  { id: 'grid-move', label: 'Move selection', category: 'Data grid', kind: 'fixed', keys: '↑ ↓ ← →' },
  { id: 'grid-extend', label: 'Extend selection', category: 'Data grid', kind: 'fixed', keys: '⇧↑ ⇧↓ ⇧← ⇧→', note: 'Or ⇧-click, or drag with the mouse.' },
  { id: 'grid-edit-commit', label: 'Finish editing a cell', category: 'Data grid', kind: 'fixed', keys: '↵' },
  { id: 'grid-edit-cancel', label: 'Cancel editing a cell', category: 'Data grid', kind: 'fixed', keys: '⎋' },

  // Lists & sidebar
  { id: 'list-select-all', label: 'Select all (tables, connections)', category: 'Lists & sidebar', kind: 'fixed', keys: '⌘A' },
  { id: 'list-move', label: 'Move focus', category: 'Lists & sidebar', kind: 'fixed', keys: '↑ ↓' },
  { id: 'list-first-last', label: 'First / last item', category: 'Lists & sidebar', kind: 'fixed', keys: 'Home End' },
  { id: 'list-open', label: 'Open or expand', category: 'Lists & sidebar', kind: 'fixed', keys: '↵' },
  { id: 'list-toggle', label: 'Toggle item in selection', category: 'Lists & sidebar', kind: 'fixed', keys: '␣', note: 'Or ⌘-click. ⇧-click selects a range.' },
  { id: 'list-menu', label: 'Open context menu', category: 'Lists & sidebar', kind: 'fixed', keys: '⇧F10' },

  // System (native menu roles — reserved)
  { id: 'sys-copy', label: 'Copy', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+C' },
  { id: 'sys-cut', label: 'Cut', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+X' },
  { id: 'sys-paste', label: 'Paste', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+V' },
  { id: 'sys-select-all', label: 'Select all', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+A' },
  { id: 'sys-zoom-reset', label: 'Actual size', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+0' },
  { id: 'sys-zoom-in', label: 'Zoom in', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+Plus' },
  { id: 'sys-zoom-out', label: 'Zoom out', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+-' },
  { id: 'sys-fullscreen', label: 'Toggle full screen', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+Ctrl+F' },
  { id: 'sys-devtools', label: 'Developer tools', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+Alt+I' },
  { id: 'sys-hide', label: 'Hide EarthQL', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+H' },
  { id: 'sys-minimize', label: 'Minimize', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+M' },
  { id: 'sys-quit', label: 'Quit EarthQL', category: 'System', kind: 'fixed', accelerator: 'CmdOrCtrl+Q' },
];

const BY_ID = new Map(SHORTCUTS.map((def) => [def.id, def]));

export const shortcutDef = (id: string): ShortcutDef | undefined => BY_ID.get(id);
export const isRebindable = (def: ShortcutDef): boolean => def.kind !== 'fixed';

/** `null` means the shortcut was explicitly unbound; a missing key means "use the default". */
export type KeybindingOverrides = Record<string, string | null>;

// ---------------------------------------------------------------------------
// Accelerator parsing / formatting
// ---------------------------------------------------------------------------

const MODIFIER_ALIASES: Record<string, 'CmdOrCtrl' | 'Ctrl' | 'Alt' | 'Shift'> = {
  cmd: 'CmdOrCtrl', command: 'CmdOrCtrl', cmdorctrl: 'CmdOrCtrl', commandorcontrol: 'CmdOrCtrl',
  ctrl: 'Ctrl', control: 'Ctrl',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
};
const MODIFIER_ORDER = ['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift'] as const;

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', space: 'Space', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: 'Plus',
};

/** Canonical form: modifiers in a fixed order, upper-case letters. Returns null for malformed input. */
export function normalizeAccelerator(accelerator: string): string | null {
  const tokens = accelerator.split('+');
  if (tokens.length < 2 && !tokens[0]) return null;
  const key = tokens.pop();
  if (!key) return null;
  const mods = new Set<string>();
  for (const token of tokens) {
    const mod = MODIFIER_ALIASES[token.toLowerCase()];
    if (!mod) return null;
    mods.add(mod);
  }
  const normalizedKey = KEY_ALIASES[key.toLowerCase()] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key.length === 1 ? key.toUpperCase() : null);
  if (!normalizedKey) return null;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), normalizedKey].join('+');
}

const SYMBOL_FOR_MODIFIER = { CmdOrCtrl: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' } as const;
const SYMBOL_FOR_KEY: Record<string, string> = {
  Enter: '↵', Backspace: '⌫', Delete: '⌦', Escape: '⎋', Tab: '⇥', Space: '␣',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Plus: '+',
  Home: '↖', End: '↘', PageUp: '⇞', PageDown: '⇟',
};

/** `CmdOrCtrl+Shift+T` -> `⌘⇧T` (Mac modifier symbols, no separators — see CLAUDE.md). */
export function toSymbols(accelerator: string): string {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return accelerator;
  const parts = normalized.split('+');
  const key = parts.pop()!;
  return parts.map((m) => SYMBOL_FOR_MODIFIER[m as keyof typeof SYMBOL_FOR_MODIFIER]).join('') + (SYMBOL_FOR_KEY[key] ?? key);
}

const MODIFIER_SYMBOLS = '⌘⌃⌥⇧';

/** `⌘⇧T` -> [['⌘', '⇧', 'T']] — one entry per keycap. Whitespace separates alternatives or chords (`↵ F2`). */
export function splitKeys(display: string): string[][] {
  return display
    .split(/\s+/)
    .filter(Boolean)
    .map((combo) => {
      const chars = [...combo];
      const modifiers: string[] = [];
      while (chars.length > 1 && MODIFIER_SYMBOLS.includes(chars[0])) modifiers.push(chars.shift()!);
      return [...modifiers, chars.join('')];
    });
}

/** The word form for `aria-keyshortcuts`, e.g. `Meta+Shift+T`. */
export function toAria(accelerator: string): string | undefined {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return undefined;
  return normalized.replace('CmdOrCtrl', 'Meta').replace('Ctrl', 'Control');
}

/** What to show for a shortcut with the user's overrides applied; '' when it is unbound. */
export function shortcutDisplay(def: ShortcutDef, overrides: KeybindingOverrides): string {
  if (def.kind === 'fixed') return def.keys ?? (def.accelerator ? toSymbols(def.accelerator) : '');
  const accelerator = effectiveAccelerator(def.id, overrides);
  return accelerator ? toSymbols(accelerator) : '';
}

export function effectiveAccelerator(id: string, overrides: KeybindingOverrides): string | null {
  const def = BY_ID.get(id);
  if (!def) return null;
  if (isRebindable(def) && Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] ?? null;
  return def.accelerator ?? null;
}

// ---------------------------------------------------------------------------
// Recording keystrokes
// ---------------------------------------------------------------------------

export interface KeyEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const PUNCTUATION_CODES: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};
const NAMED_CODES: Record<string, string> = {
  Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape', Tab: 'Tab', Space: 'Space',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};

/** Physical key (layout-independent, ignores Shift's effect on the character), or null for modifier-only presses. */
export function keyNameFromEvent(event: Pick<KeyEventLike, 'code'>): string | null {
  const { code } = event;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  return NAMED_CODES[code] ?? PUNCTUATION_CODES[code] ?? null;
}

/** Builds a canonical accelerator from a keydown event, or null when only modifiers are down. */
export function acceleratorFromEvent(event: KeyEventLike, mac = true): string | null {
  const key = keyNameFromEvent(event);
  if (!key) return null;
  const mods: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) mods.push('CmdOrCtrl');
  if (mac && event.ctrlKey) mods.push('Ctrl');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

export function matchesAccelerator(event: KeyEventLike, accelerator: string | null | undefined, mac = true): boolean {
  if (!accelerator) return false;
  const normalized = normalizeAccelerator(accelerator);
  return !!normalized && acceleratorFromEvent(event, mac) === normalized;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Returns a user-facing reason the accelerator can't be used, or null when it is fine. */
export function validateAccelerator(accelerator: string): string | null {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return 'That is not a valid shortcut.';
  const parts = normalized.split('+');
  const key = parts.pop()!;
  const hasCommandModifier = parts.some((m) => m === 'CmdOrCtrl' || m === 'Ctrl' || m === 'Alt');
  if (!hasCommandModifier && !/^F\d{1,2}$/.test(key) && normalized !== 'Backspace') return 'Include ⌘, ⌃ or ⌥ so it does not clash with typing.';
  return null;
}

/** Another shortcut that already uses this accelerator, ignoring `id` itself. */
export function findConflict(id: string, accelerator: string, overrides: KeybindingOverrides): ShortcutDef | undefined {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return undefined;
  return SHORTCUTS.find((def) => {
    if (def.id === id) return false;
    const other = effectiveAccelerator(def.id, overrides);
    return !!other && normalizeAccelerator(other) === normalized;
  });
}

/** Drops unknown ids, non-rebindable ids, invalid accelerators and entries equal to the default. */
export function sanitizeOverrides(raw: unknown): KeybindingOverrides {
  const out: KeybindingOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = BY_ID.get(id);
    if (!def || !isRebindable(def)) continue;
    if (value === null) {
      out[id] = null;
      continue;
    }
    if (typeof value !== 'string' || validateAccelerator(value)) continue;
    const normalized = normalizeAccelerator(value)!;
    const defaultNormalized = def.accelerator ? normalizeAccelerator(def.accelerator) : null;
    if (normalized !== defaultNormalized) out[id] = normalized;
  }
  return out;
}
