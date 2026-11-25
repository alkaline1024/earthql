import { describe, expect, it } from 'vitest';
import { panelDropZone, tabInsertionTarget } from '../src/renderer/src/tab-drop';

describe('tab drop destinations', () => {
  it.each([
    [0.5, 0.5, 'center'],
    [0.1, 0.5, 'left'],
    [0.9, 0.5, 'right'],
    [0.5, 0.1, 'up'],
    [0.5, 0.9, 'down'],
    [0.2, 0.05, 'up'],
    [0.98, 0.8, 'right'],
  ] as const)('previews the destination at (%s, %s)', (x, y, expected) => {
    expect(panelDropZone(x, y, false)).toBe(expected);
  });

  it('moves into an existing panel rather than previewing an unsupported third panel', () => {
    for (const [x, y] of [[0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1], [0.5, 0.5]]) {
      expect(panelDropZone(x, y, true)).toBe('center');
    }
  });
});

describe('Chrome-style tab insertion', () => {
  const slots = [{ id: 'a', center: 100 }, { id: 'c', center: 500 }];
  it('reserves a slot before, between and after the other tabs', () => {
    expect(tabInsertionTarget(slots, 20)).toEqual({ id: 'a', after: false });
    expect(tabInsertionTarget(slots, 300)).toEqual({ id: 'c', after: false });
    expect(tabInsertionTarget(slots, 700)).toEqual({ id: 'c', after: true });
  });
  it('keeps the target stable while neighbors move to make room', () => {
    const snapshot = slots.map((slot) => ({ ...slot }));
    for (const x of [301, 299, 302, 300]) {
      expect(tabInsertionTarget(snapshot, x)).toEqual({ id: 'c', after: false });
    }
    expect(snapshot).toEqual(slots);
  });
  it('reserves the first slot for an empty destination panel', () => {
    expect(tabInsertionTarget([], 200)).toEqual({ id: null, after: true });
  });
});
