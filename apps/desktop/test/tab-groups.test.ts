import { describe, expect, it } from 'vitest';
import { assignTabGroup, type TabGroup } from '../src/renderer/src/tab-groups';

const groups: TabGroup[] = [
  { id: 'g1', name: 'Auth', color: '#e5484d', tabIds: ['a', 'b'], collapsed: false },
  { id: 'g2', name: 'Scratch', color: '#2f9e5b', tabIds: ['c'], collapsed: true },
];

describe('tab groups', () => {
  it('moves multiple tabs together without duplicating or changing the source', () => {
    const next = assignTabGroup(groups, ['a', 'c', 'a'], 'g2');
    expect(next.map((group) => group.tabIds)).toEqual([['b'], ['a', 'c']]);
    expect(groups[0].tabIds).toEqual(['a', 'b']);
  });
  it('ungroups tabs and leaves unknown targets unchanged', () => {
    expect(assignTabGroup(groups, ['a', 'c'], null).map((group) => group.tabIds)).toEqual([['b'], []]);
    expect(assignTabGroup(groups, ['a'], 'missing')).toBe(groups);
  });
});
