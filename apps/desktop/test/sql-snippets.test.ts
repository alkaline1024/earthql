import { describe, expect, it } from 'vitest';
import { fillSnippet, snippetVariables } from '../src/renderer/src/sql-snippets';

describe('SQL snippets', () => {
  it('substitutes repeated named placeholders literally without executing SQL', () => {
    const sql = 'SELECT {{column}} FROM {{table}} WHERE {{column}} = {{value}}';
    expect(snippetVariables(sql)).toEqual(['column', 'table', 'value']);
    expect(fillSnippet(sql, { column: 'id', table: 'orders', value: "'$1'" })).toBe("SELECT id FROM orders WHERE id = '$1'");
  });

  it('requires every placeholder and ignores unrelated braces', () => {
    expect(snippetVariables('SELECT {{bad name}}, {{ok}}')).toEqual(['ok']);
    expect(() => fillSnippet('SELECT {{missing}}', {})).toThrow('Missing value');
  });
});
