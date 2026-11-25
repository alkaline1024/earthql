import { useRef } from 'react';
import { useApp } from '../store';

export function SidebarResizeHandle() {
  const start = useRef<{ x: number; width: number } | null>(null);
  return <div className="sidebar-resize-handle" role="separator" aria-label="Resize sidebar" aria-orientation="vertical"
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      start.current = { x: event.clientX, width: useApp.getState().sidebarWidth };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!start.current) return;
      useApp.getState().setSidebarWidth(start.current.width + event.clientX - start.current.x);
    }}
    onPointerUp={(event) => {
      start.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { start.current = null; }}
    onLostPointerCapture={() => { start.current = null; }}
  />;
}
