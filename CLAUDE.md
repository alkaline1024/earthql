# EarthQL — project notes for Claude

## Git workflow

When the user says "commit" or "push" (in Thai or English), commit (and push) directly to `main` — do not create
or switch to a new branch first. This overrides the general default of branching away from the default branch
before committing.

## UI text: keyboard shortcuts use symbols, never spelled-out words

Anywhere the UI shows a keyboard shortcut to the user (tooltips, `data-tooltip`, `title`, `<kbd>`, menu items,
placeholder text, empty-state copy, etc.), render it with the Mac modifier symbols — never the words "Command",
"Option", "Control", "Shift", "Backspace", "Enter/Return", "Escape", or "Tab".

| Key                | Symbol |
| ------------------ | ------ |
| Command            | ⌘      |
| Option             | ⌥      |
| Control            | ⌃      |
| Shift              | ⇧      |
| Backspace / Delete | ⌫      |
| Return / Enter     | ⏎ or ↵ |
| Escape             | ⎋      |
| Tab                | ⇥      |

Combine symbols with no separator and no spaces, e.g. `⌘T`, `⌘⇧W`, `⌥⌫`. This already matches almost every
shortcut hint in `apps/desktop/src/renderer/src` (see `TabBar.tsx`, `Sidebar.tsx`, `SqlTab.tsx`, `TableTab.tsx`,
`App.tsx`) — keep new UI consistent with it. `aria-keyshortcuts` attributes are the one exception: they keep the
ARIA spec's word form (e.g. `"Meta+T"`, `"Alt+Backspace"`), since that attribute is read by assistive tech, not
shown on screen.

## Keyboard shortcuts: every shortcut lives in the keybinding registry

All shortcuts are registered in `apps/desktop/src/shared/keybindings.ts` (`SHORTCUTS`). **Settings > Shortcuts** is
rendered from that list (grouped by category, rebindable, with conflict detection), and the native menu
accelerators and every on-screen hint are read from it. So whenever you add, change or remove a shortcut — a menu
accelerator, a renderer key handler, or a built-in key in a component/CodeMirror — update the registry in the same
change:

- Add a `SHORTCUTS` entry with an `id`, `label`, `category` (see `SHORTCUT_CATEGORIES`) and a `kind`:
  - `menu` — bound through the native menu. Add the item to the template in `apps/desktop/src/main/index.ts` with
    `item('<id>')` (never a hardcoded `accelerator`), set the entry's `command`, and handle that `menu:command` in the
    renderer.
  - `app` — a renderer key handler. Match with `matchesAccelerator(event, effectiveAccelerator(id, overrides))`
    (see `tableShortcut` in `Sidebar.tsx`), never a literal `event.key` / `metaKey` check.
  - `fixed` — built in and not rebindable (OS, CodeMirror, grid navigation). List it for reference; give it an
    `accelerator` if it should also be reserved so rebinding can't collide with it, otherwise a display-only `keys`.
- Never hardcode a symbol string such as `⌘T` for a registered shortcut in the UI. Use `useShortcuts()`
  (`sc.hint('Close', 'close-tab')`, `sc.label(id)`, `sc.aria(id)`) or `<Kbd id="close-tab" />` from
  `apps/desktop/src/renderer/src/components/Shortcut.tsx`, so the hint follows the user's rebinding (and disappears
  when unbound). The symbol convention above still applies — `toSymbols` produces it. For a shortcut that is not in
  the registry (a fixed hint), use `<Keys keys="⌘↵" />` rather than a bare `<kbd>`: it draws one keycap per key, which
  is how shortcuts look everywhere in the app.
- Keep `apps/desktop/test/keybindings.test.ts` passing; it checks the registry for duplicate ids, duplicate default
  keys and non-canonical accelerators.
