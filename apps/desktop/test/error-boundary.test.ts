import { expect, it, vi } from 'vitest';

const { setState } = vi.hoisted(() => ({ setState: vi.fn() }));
vi.mock('../src/renderer/src/store', () => ({ useApp: { setState } }));
import { ErrorBoundary } from '../src/renderer/src/components/ErrorBoundary';

it('returns Home and clears the error without clearing tabs, drafts or connections', () => {
  const boundary = new ErrorBoundary({ children: null });
  const reset = vi.spyOn(boundary, 'setState').mockImplementation(() => {});
  boundary.state = { error: new Error('render failed') };

  boundary.backToHome();

  expect(setState).toHaveBeenCalledExactlyOnceWith({
    screen: 'connections', editProfileId: undefined, draggedTabId: null,
  });
  expect(reset).toHaveBeenCalledExactlyOnceWith({ error: null });
  expect(setState.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]);
});
