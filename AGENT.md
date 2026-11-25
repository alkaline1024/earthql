# EarthQL — project notes for Codex

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
