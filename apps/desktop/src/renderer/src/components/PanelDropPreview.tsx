import { useState, type DragEvent } from 'react';
import { useApp, type PaneId } from '../store';
import { panelDropZone, type PanelDropZone } from '../tab-drop';

export function PanelDropPreview({ pane }: { pane: PaneId }) {
  const draggedTabId = useApp((s) => s.draggedTabId);
  const splitPane = useApp((s) => s.splitPane);
  const [zone, setZone] = useState<PanelDropZone | null>(null);
  if (!draggedTabId) return null;

  function dropZone(event: DragEvent<HTMLDivElement>): PanelDropZone {
    // With two panels open, drop into that panel; with one, its edges create a split.
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return panelDropZone(x, y, !!splitPane);
  }

  return <div data-tab-drop-pane={pane} className="panel-drop-target" aria-hidden="true"
    onDragOver={(event) => {
      if (!event.dataTransfer.types.includes('application/x-earthql-tab')) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setZone(dropZone(event));
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setZone(null);
    }}
    onDrop={(event) => {
      const id = event.dataTransfer.getData('application/x-earthql-tab');
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      const target = dropZone(event);
      const state = useApp.getState();
      if (target === 'center') {
        state.moveTabToPane(id, pane);
        state.activateTab(id);
      } else state.openSplit(id, target);
      state.setDraggedTabId(null);
      setZone(null);
    }}>
    {zone && <div className={`panel-drop-preview ${zone}`} />}
  </div>;
}
