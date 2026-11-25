export type PanelDropZone = 'center' | 'left' | 'right' | 'up' | 'down';

/** Use the original tab centers so moving the gap cannot make the target oscillate. */
export function tabInsertionTarget(slots: readonly { id: string; center: number }[], x: number): { id: string | null; after: boolean } {
  const next = slots.find((slot) => x < slot.center);
  return next ? { id: next.id, after: false } : { id: slots.at(-1)?.id ?? null, after: true };
}

/** Normalized coordinates keep the preview and drop behavior identical at any panel size. */
export function panelDropZone(x: number, y: number, hasSplit: boolean): PanelDropZone {
  if (hasSplit) return 'center';
  const edge = Math.min(x, 1 - x, y, 1 - y);
  if (edge > 0.25) return 'center';
  return edge === x ? 'left' : edge === 1 - x ? 'right' : edge === y ? 'up' : 'down';
}
