import { useMemo } from 'react';
import { effectiveAccelerator, splitKeys, toAria, toSymbols, type KeybindingOverrides } from '../../../shared/keybindings';
import { useApp } from '../store';

/** `⌘T`-style label for a registered shortcut, or '' when the user has unbound it. */
export function shortcutLabel(id: string, overrides: KeybindingOverrides): string {
  const accelerator = effectiveAccelerator(id, overrides);
  return accelerator ? toSymbols(accelerator) : '';
}

/** Reads the user's current shortcuts so hints and tooltips always match what is actually bound. */
export function useShortcuts() {
  const overrides = useApp((s) => s.keybindings);
  return useMemo(() => {
    const label = (id: string) => shortcutLabel(id, overrides);
    return {
      overrides,
      label,
      /** `Run (⌘↵)`, or just `Run` when unbound. */
      hint: (text: string, id: string) => {
        const symbols = label(id);
        return symbols ? `${text} (${symbols})` : text;
      },
      /** Value for `aria-keyshortcuts`. */
      aria: (id: string) => {
        const accelerator = effectiveAccelerator(id, overrides);
        return accelerator ? toAria(accelerator) : undefined;
      },
    };
  }, [overrides]);
}

/** Draws a shortcut as one keycap per key, e.g. ⌘ ⇧ T, in the style of a keybindings list. */
export function Keys({ keys }: { keys: string }) {
  return (
    <span className="keys">
      {splitKeys(keys).map((combo, i) => (
        <span className="key-combo" key={i}>
          {combo.map((key, j) => <kbd key={j}>{key}</kbd>)}
        </span>
      ))}
    </span>
  );
}

/** A registered shortcut as keycaps; renders nothing when it is unbound. */
export function Kbd({ id }: { id: string }) {
  const symbols = useApp((s) => shortcutLabel(id, s.keybindings));
  return symbols ? <Keys keys={symbols} /> : null;
}
