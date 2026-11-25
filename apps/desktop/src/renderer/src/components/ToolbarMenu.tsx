import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Open state + click-outside/Escape dismissal for a menu anchored under a toolbar button. */
function useAnchoredMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, root };
}

/** A toolbar button whose whole body opens a dropdown menu (e.g. the row-limit picker). */
export function ToolbarDropdown({
  trigger,
  title,
  disabled,
  align = 'left',
  children,
}: {
  trigger: ReactNode;
  title?: string;
  disabled?: boolean;
  align?: 'left' | 'right';
  /** Receives `close` — call it from each leaf item's onClick after running the action. */
  children: (close: () => void) => ReactNode;
}) {
  const { open, setOpen, root } = useAnchoredMenu();
  const close = () => setOpen(false);
  return (
    <div className="toolbar-dropdown no-drag" ref={root}>
      <button type="button" className="btn small" title={title} disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {trigger}
        <span aria-hidden="true" className="toolbar-dropdown-caret">⌄</span>
      </button>
      {open && (
        <div className={`toolbar-menu${align === 'right' ? ' align-right' : ''}`} role="menu">
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** A primary action button with a separate chevron that opens a menu of related actions (e.g. Run). */
export function SplitButton({
  label,
  title,
  onClick,
  disabled,
  className,
  menuLabel,
  align = 'left',
  children,
}: {
  label: ReactNode;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  menuLabel: string;
  align?: 'left' | 'right';
  /** Receives `close` — call it from each leaf item's onClick after running the action. */
  children: (close: () => void) => ReactNode;
}) {
  const { open, setOpen, root } = useAnchoredMenu();
  const close = () => setOpen(false);
  return (
    <div className="split-btn no-drag" ref={root}>
      <button type="button" className={`btn small${className ? ` ${className}` : ''}`} title={title} disabled={disabled} onClick={onClick}>
        {label}
      </button>
      <button
        type="button"
        className={`btn small split-btn-chevron${className ? ` ${className}` : ''}`}
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        ⌄
      </button>
      {open && (
        <div className={`toolbar-menu${align === 'right' ? ' align-right' : ''}`} role="menu" aria-label={menuLabel}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
