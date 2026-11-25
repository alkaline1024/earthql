import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function ContextSubmenu({ label, disabled, children }: { label: string; disabled?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open || !trigger.current || !submenu.current) return;
    const row = trigger.current.getBoundingClientRect();
    const parent = trigger.current.closest('[role="menu"]')!.getBoundingClientRect();
    const width = submenu.current.offsetWidth;
    const height = submenu.current.offsetHeight;
    setPosition({ left: Math.max(8, parent.right + width <= window.innerWidth - 8 ? parent.right - 2 : parent.left - width + 2), top: Math.max(8, Math.min(row.top - 5, window.innerHeight - height - 8)) });
  }, [open]);
  return <div className="conn-menu-branch" ref={root}
    onMouseEnter={() => { if (!disabled) setOpen(true); }}
    onMouseLeave={() => setOpen(false)}
    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(e) => {
      if (e.key === 'ArrowRight' && !disabled) { e.preventDefault(); e.stopPropagation(); setOpen(true); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')?.focus()); }
      if ((e.key === 'ArrowLeft' || e.key === 'Escape') && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    }}>
    <button ref={trigger} role="menuitem" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(!open)}>{label}<span aria-hidden="true" style={{ float: 'right' }}>›</span></button>
    {open && <div className="conn-submenu" ref={submenu} style={position} role="menu" aria-label={label}>{children}</div>}
  </div>;
}

