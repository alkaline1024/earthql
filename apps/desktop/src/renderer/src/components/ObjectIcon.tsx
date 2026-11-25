import type { TreeNode } from '@earthql/core';

/** Consistent outlines that stay legible at navigation sizes. */
export function ObjectIcon({ kind }: { kind: TreeNode['kind'] | 'sql' | 'create' }) {
  return (
    <svg className="object-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'sql' ? <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></> :
        kind === 'create' ? <path d="M12 5v14M5 12h14" /> :
        kind === 'database' ? <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></> :
        kind === 'catalog' ? <><path d="M3 7V4h7l2 3h9v13H3Z" /><path d="M3 10h18" /></> :
        kind === 'schema' ? <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12m0-6h12" /></> :
        kind === 'view' ? <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></> :
        <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 9v12m6-12v12" /></>}
    </svg>
  );
}
