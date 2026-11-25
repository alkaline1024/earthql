import { describe, expect, it } from 'vitest';
import { assignConnectionGroup, parseConnectionGroups, type ConnectionGroup } from '../src/renderer/src/connection-groups';

const groups: ConnectionGroup[] = [
  { id: 'g1', name: 'Production', profileIds: ['a', 'b'], collapsed: false },
  { id: 'g2', name: 'Local', profileIds: ['c'], collapsed: true },
];

describe('connection groups', () => {
  it('restores membership, names and collapsed state after persistence', () => {
    expect(parseConnectionGroups(JSON.stringify(groups))).toEqual(groups);
  });
  it('recovers malformed storage and removes duplicate membership', () => {
    expect(parseConnectionGroups('{')).toEqual([]);
    expect(parseConnectionGroups('{}')).toEqual([]);
    expect(parseConnectionGroups(JSON.stringify([null, {}, groups[0], groups[0], { ...groups[1], profileIds: ['b', 'c', 'c', 9] }]))).toEqual(groups);
  });
  it('moves multiple connections together without duplicating or changing the source', () => {
    const next = assignConnectionGroup(groups, ['a', 'c', 'a'], 'g2');
    expect(next.map((group) => group.profileIds)).toEqual([['b'], ['a', 'c']]);
    expect(groups[0].profileIds).toEqual(['a', 'b']);
    expect(parseConnectionGroups(JSON.stringify(next))).toEqual(next);
  });
  it('ungroups connections and leaves unknown targets unchanged', () => {
    expect(assignConnectionGroup(groups, ['a', 'c'], null).map((group) => group.profileIds)).toEqual([['b'], []]);
    expect(assignConnectionGroup(groups, ['a'], 'missing')).toBe(groups);
  });
});
