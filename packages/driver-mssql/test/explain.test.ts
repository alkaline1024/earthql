import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MssqlProfile } from '@earthql/core';

const state = vi.hoisted(() => ({
  batches: [] as string[],
  fail: '',
  hold: false,
  closed: 0,
}));

vi.mock('tedious', async () => {
  const { EventEmitter } = await import('node:events');
  class Request extends EventEmitter {
    constructor(public text: string, public callback: (error?: Error) => void) { super(); }
  }
  class Connection extends EventEmitter {
    connect(callback: (error?: Error) => void) { queueMicrotask(() => callback()); }
    execSqlBatch(request: Request) {
      state.batches.push(request.text);
      if (state.hold && request.text !== 'SET SHOWPLAN_XML ON') return;
      queueMicrotask(() => {
        if (state.fail === request.text) request.callback(new Error('Failed to produce plan'));
        else {
          if (request.text !== 'SET SHOWPLAN_XML ON') request.emit('row', [{ value: '<ShowPlanXML />' }]);
          request.callback();
        }
      });
    }
    close() { state.closed++; queueMicrotask(() => this.emit('end')); }
  }
  return { Connection, Request };
});

import { mssqlDriver } from '../src';

const profile: MssqlProfile = {
  id: 'test', name: 'Test', driver: 'mssql', host: 'localhost', port: 1433, database: 'master', user: 'user',
  tls: { mode: 'require' }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
};

describe('SQL Server estimated plans', () => {
  beforeEach(() => { state.batches = []; state.fail = ''; state.hold = false; state.closed = 0; });
  const cursor = () => mssqlDriver.connect(profile, {}).openExplainCursor!({ sql: 'SELECT 1' }, {});

  it('enables SHOWPLAN before sending the query and closes the isolated connection', async () => {
    const result = await cursor().fetch(100);
    expect(state.batches).toEqual(['SET SHOWPLAN_XML ON', 'SELECT 1']);
    expect(result.rows).toEqual([['<ShowPlanXML />']]);
    expect(state.closed).toBe(1);
  });

  it('never sends the query when SHOWPLAN setup fails', async () => {
    state.fail = 'SET SHOWPLAN_XML ON';
    await expect(cursor().fetch(100)).rejects.toThrow('Failed to produce plan');
    expect(state.batches).toEqual(['SET SHOWPLAN_XML ON']);
    expect(state.closed).toBe(1);
  });

  it('closes the connection on plan failure or cancellation', async () => {
    state.fail = 'SELECT 1';
    await expect(cursor().fetch(100)).rejects.toThrow('Failed to produce plan');
    expect(state.closed).toBe(1);
    state.fail = '';
    state.hold = true;
    const c = cursor();
    const result = c.fetch(100);
    await vi.waitFor(() => expect(state.batches).toEqual([
      'SET SHOWPLAN_XML ON', 'SELECT 1', 'SET SHOWPLAN_XML ON', 'SELECT 1',
    ]));
    expect(await c.cancel()).toBe('requested');
    await expect(result).rejects.toMatchObject({ category: 'cancelled' });
  });
});
