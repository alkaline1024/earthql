import { describe, expect, it } from 'vitest';
import {
  SHORTCUTS,
  acceleratorFromEvent,
  effectiveAccelerator,
  findConflict,
  isRebindable,
  matchesAccelerator,
  normalizeAccelerator,
  sanitizeOverrides,
  shortcutDisplay,
  shortcutDef,
  splitKeys,
  toAria,
  toSymbols,
  validateAccelerator,
} from '../src/shared/keybindings';

const key = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, k = code) => ({
  key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

describe('shortcut registry', () => {
  it('has unique ids', () => {
    const ids = SHORTCUTS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every menu shortcut a unique menu command', () => {
    const menu = SHORTCUTS.filter((d) => d.kind === 'menu');
    expect(menu.every((d) => !!d.command)).toBe(true);
    expect(new Set(menu.map((d) => d.command)).size).toBe(menu.length);
  });

  it('has valid, canonical default accelerators', () => {
    for (const def of SHORTCUTS.filter((d) => d.accelerator)) {
      expect(validateAccelerator(def.accelerator!), def.id).toBeNull();
      expect(normalizeAccelerator(def.accelerator!), def.id).toBe(def.accelerator);
    }
  });

  it('never defaults two shortcuts to the same keys', () => {
    const seen = new Map<string, string>();
    for (const def of SHORTCUTS.filter((d) => d.accelerator)) {
      const accel = normalizeAccelerator(def.accelerator!)!;
      expect(seen.get(accel), `${def.id} duplicates ${seen.get(accel)}`).toBeUndefined();
      seen.set(accel, def.id);
    }
  });

  it('only rebinds shortcuts that are not built in', () => {
    expect(isRebindable(shortcutDef('close-tab')!)).toBe(true);
    expect(isRebindable(shortcutDef('table-delete')!)).toBe(true);
    expect(isRebindable(shortcutDef('sys-copy')!)).toBe(false);
  });
});

describe('accelerator formatting', () => {
  it('renders Mac symbols with no separators', () => {
    expect(toSymbols('CmdOrCtrl+Shift+T')).toBe('⌘⇧T');
    expect(toSymbols('CmdOrCtrl+Enter')).toBe('⌘↵');
    expect(toSymbols('Alt+Backspace')).toBe('⌥⌫');
    expect(toSymbols('CmdOrCtrl+[')).toBe('⌘[');
    expect(toSymbols('Ctrl+Alt+Shift+CmdOrCtrl+Up')).toBe('⌘⌃⌥⇧↑');
  });

  it('normalizes aliases and modifier order', () => {
    expect(normalizeAccelerator('cmd+shift+t')).toBe('CmdOrCtrl+Shift+T');
    expect(normalizeAccelerator('Shift+Option+Control+Command+k')).toBe('CmdOrCtrl+Ctrl+Alt+Shift+K');
    expect(normalizeAccelerator('Cmd+Return')).toBe('CmdOrCtrl+Enter');
    expect(normalizeAccelerator('Cmd+Bogus')).toBeNull();
    expect(normalizeAccelerator('Hyper+T')).toBeNull();
  });

  it('gives the ARIA word form', () => {
    expect(toAria('CmdOrCtrl+Shift+T')).toBe('Meta+Shift+T');
    expect(toAria('Ctrl+Space')).toBe('Control+Space');
  });
});

describe('keycap splitting', () => {
  it('puts every modifier and the key on its own cap', () => {
    expect(splitKeys('⌘⇧T')).toEqual([['⌘', '⇧', 'T']]);
    expect(splitKeys('⌥⌫')).toEqual([['⌥', '⌫']]);
    expect(splitKeys('⌘[')).toEqual([['⌘', '[']]);
  });

  it('keeps multi-character keys whole and separates alternatives', () => {
    expect(splitKeys('⇧F10')).toEqual([['⇧', 'F10']]);
    expect(splitKeys('↵ F2')).toEqual([['↵'], ['F2']]);
    expect(splitKeys('Home End')).toEqual([['Home'], ['End']]);
    expect(splitKeys('⇧↑ ⇧↓')).toEqual([['⇧', '↑'], ['⇧', '↓']]);
  });

  it('survives an empty or modifier-only string', () => {
    expect(splitKeys('')).toEqual([]);
    expect(splitKeys('⌘')).toEqual([['⌘']]);
  });
});

describe('recording keystrokes', () => {
  it('builds accelerators from the physical key, ignoring what Shift types', () => {
    expect(acceleratorFromEvent(key('KeyT', { metaKey: true, shiftKey: true }, 'T'))).toBe('CmdOrCtrl+Shift+T');
    expect(acceleratorFromEvent(key('BracketLeft', { metaKey: true, shiftKey: true }, '{'))).toBe('CmdOrCtrl+Shift+[');
    expect(acceleratorFromEvent(key('Digit1', { metaKey: true }, '1'))).toBe('CmdOrCtrl+1');
    expect(acceleratorFromEvent(key('ArrowUp', { altKey: true }))).toBe('Alt+Up');
    expect(acceleratorFromEvent(key('Backspace', { metaKey: true }))).toBe('CmdOrCtrl+Backspace');
    expect(acceleratorFromEvent(key('F5'))).toBe('F5');
  });

  it('returns null while only modifiers are held', () => {
    expect(acceleratorFromEvent(key('MetaLeft', { metaKey: true }, 'Meta'))).toBeNull();
    expect(acceleratorFromEvent(key('ShiftLeft', { shiftKey: true }, 'Shift'))).toBeNull();
  });

  it('matches events against accelerators exactly', () => {
    expect(matchesAccelerator(key('Backspace', { metaKey: true }), 'CmdOrCtrl+Backspace')).toBe(true);
    expect(matchesAccelerator(key('Backspace', { metaKey: true, shiftKey: true }), 'CmdOrCtrl+Backspace')).toBe(false);
    expect(matchesAccelerator(key('Backspace', { altKey: true }), 'Alt+Backspace')).toBe(true);
    expect(matchesAccelerator(key('Backspace', { altKey: true }), null)).toBe(false);
  });
});

describe('validation and conflicts', () => {
  it('requires a command modifier unless it is a function key', () => {
    expect(validateAccelerator('CmdOrCtrl+T')).toBeNull();
    expect(validateAccelerator('Alt+Up')).toBeNull();
    expect(validateAccelerator('F6')).toBeNull();
    expect(validateAccelerator('T')).not.toBeNull();
    expect(validateAccelerator('Shift+T')).not.toBeNull();
    expect(validateAccelerator('nonsense+')).not.toBeNull();
  });

  it('finds rebindable and built-in conflicts, ignoring the shortcut itself', () => {
    expect(findConflict('new-sql-tab', 'CmdOrCtrl+W', {})?.id).toBe('close-tab');
    expect(findConflict('close-tab', 'CmdOrCtrl+W', {})).toBeUndefined();
    expect(findConflict('new-sql-tab', 'CmdOrCtrl+C', {})?.id).toBe('sys-copy');
    expect(findConflict('new-sql-tab', 'CmdOrCtrl+Alt+Shift+9', {})).toBeUndefined();
  });

  it('honours overrides when checking conflicts', () => {
    expect(findConflict('new-sql-tab', 'CmdOrCtrl+W', { 'close-tab': null })).toBeUndefined();
    expect(findConflict('new-sql-tab', 'CmdOrCtrl+Alt+W', { 'close-tab': 'CmdOrCtrl+Alt+W' })?.id).toBe('close-tab');
  });
});

describe('overrides', () => {
  it('falls back to the default, and treats null as unbound', () => {
    expect(effectiveAccelerator('close-tab', {})).toBe('CmdOrCtrl+W');
    expect(effectiveAccelerator('close-tab', { 'close-tab': 'CmdOrCtrl+Alt+W' })).toBe('CmdOrCtrl+Alt+W');
    expect(effectiveAccelerator('close-tab', { 'close-tab': null })).toBeNull();
    expect(effectiveAccelerator('missing', {})).toBeNull();
  });

  it('cannot override built-in shortcuts', () => {
    expect(effectiveAccelerator('sys-copy', { 'sys-copy': 'CmdOrCtrl+K' })).toBe('CmdOrCtrl+C');
  });

  it('shows built-in shortcuts and the overridden ones', () => {
    expect(shortcutDisplay(shortcutDef('close-tab')!, {})).toBe('⌘W');
    expect(shortcutDisplay(shortcutDef('close-tab')!, { 'close-tab': null })).toBe('');
    expect(shortcutDisplay(shortcutDef('grid-move')!, {})).toBe('↑ ↓ ← →');
    expect(shortcutDisplay(shortcutDef('sys-copy')!, {})).toBe('⌘C');
  });

  it('sanitizes stored data', () => {
    expect(
      sanitizeOverrides({
        'close-tab': 'cmd+alt+w',
        'new-sql-tab': null,
        refresh: 'CmdOrCtrl+R',
        'sys-copy': 'CmdOrCtrl+K',
        bogus: 'CmdOrCtrl+B',
        run: 'T',
        cancel: 42,
      }),
    ).toEqual({ 'close-tab': 'CmdOrCtrl+Alt+W', 'new-sql-tab': null });
    expect(sanitizeOverrides('nope')).toEqual({});
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides([])).toEqual({});
  });
});
