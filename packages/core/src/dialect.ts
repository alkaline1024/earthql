import type {
  BrowseRequest,
  BuiltStatement,
  ColumnInfo,
  ColumnSpec,
  CreateTableSpec,
  DriverId,
  Filter,
  InsertSpec,
  ObjectPath,
  SqlParam,
  TypeOption,
} from './types';
import { checkRawCondition } from './raw-filter';
import { kindFromTypeName } from './values';

/**
 * Dialect: pure SQL generation for one database family. No I/O, fully unit-testable.
 * User-entered values are always bound as parameters; only identifiers (quoted) and
 * explicitly chosen default expressions are written into SQL text.
 */
export abstract class Dialect {
  abstract readonly driver: DriverId;
  abstract readonly types: TypeOption[];
  /** Max rows per multi-row INSERT statement. */
  readonly maxInsertRows: number = 1000;

  abstract quoteIdent(name: string): string;
  /** Placeholder for the i-th (0-based) parameter. */
  abstract placeholder(i: number): string;
  /** A string literal, escaped for this dialect. */
  abstract stringLiteral(value: string): string;
  /** Cast an expression to text for LIKE comparisons. */
  abstract castToText(expr: string): string;
  /** Case-insensitive LIKE comparison of `textExpr` with a pattern placeholder. */
  abstract ilike(textExpr: string, placeholder: string): string;
  /** Case-sensitive LIKE; most engines already compare case-sensitively, so that is the default. */
  likeCaseSensitive(textExpr: string, placeholder: string): string {
    return `${textExpr} LIKE ${placeholder}`;
  }
  /** Path parts that appear in SQL text, outermost first. */
  abstract pathParts(p: ObjectPath): string[];

  qualify(p: ObjectPath): string {
    return this.pathParts(p)
      .map((x) => this.quoteIdent(x))
      .join('.');
  }

  displayTarget(p: ObjectPath): string {
    return this.pathParts(p).join('.');
  }

  /** Expression used to bind a value into an INSERT for a column of the given type. */
  insertValueExpr(placeholder: string, _column: { type: string }): string {
    return placeholder;
  }

  gridUpdateMatch(column: ColumnInfo, placeholder: string, _compareOriginal: boolean): string {
    return `${this.quoteIdent(column.name)} = ${this.insertValueExpr(placeholder, column)}`;
  }

  /** Select-list expression for a column when browsing (lets dialects preserve precision). */
  browseSelectExpr(column: Pick<ColumnInfo, 'name' | 'type'>): string {
    return this.quoteIdent(column.name);
  }

  /** Pagination. `orderBy` is '' or ' ORDER BY ...'. */
  paginate(base: string, orderBy: string, limit: number, offset: number): string {
    return `${base}${orderBy} LIMIT ${limit} OFFSET ${offset}`;
  }

  escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (m) => '\\' + m);
  }

  /** Clause appended after LIKE to declare the escape character, when the dialect needs it. */
  likeEscapeClause(): string {
    return " ESCAPE '\\'";
  }

  // -------------------------------------------------------------------------
  // Browse
  // -------------------------------------------------------------------------

  buildBrowse(req: BrowseRequest, columns?: Pick<ColumnInfo, 'name' | 'type'>[]): BuiltStatement {
    const errors: string[] = [];
    const params: SqlParam[] = [];
    const known = columns ? new Set(columns.map((c) => c.name)) : null;

    const selectList = columns && columns.length > 0 ? columns.map((c) => this.browseSelectExpr(c)).join(', ') : '*';

    // Consecutive AND-ed filters form a group; groups are OR-ed. A skipped filter drops out entirely,
    // so the next one joins whatever came before it.
    const groups: string[][] = [];
    for (const f of req.filters) {
      let clause: string | null;
      if (f.op === 'raw') {
        const raw = (f.value ?? '').trim();
        const problem = checkRawCondition(raw);
        if (problem) {
          errors.push(`Raw SQL filter: ${problem}`);
          continue;
        }
        // Parenthesised so its own OR can't leak into the other filters; the newline ends a trailing `--` comment.
        clause = `(${raw}${raw.includes('--') ? '\n' : ''})`;
      } else {
        if (known && !known.has(f.column)) {
          errors.push(`Unknown column in filter: ${f.column}`);
          continue;
        }
        clause = this.filterClause(f, params);
        if (!clause) errors.push(`Filter on ${f.column} needs a value`);
      }
      if (!clause) continue;
      if (!groups.length || f.join === 'or') groups.push([clause]);
      else groups[groups.length - 1].push(clause);
    }
    const where = groups.map((group) => (groups.length > 1 && group.length > 1 ? `(${group.join(' AND ')})` : group.join(' AND '))).join(' OR ');

    let orderBy = '';
    if (req.sort) {
      if (known && !known.has(req.sort.column)) errors.push(`Unknown sort column: ${req.sort.column}`);
      else orderBy = ` ORDER BY ${this.quoteIdent(req.sort.column)} ${req.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
    }

    const base = `SELECT ${selectList} FROM ${this.qualify(req.object)}${where ? ` WHERE ${where}` : ''}`;
    const limit = Math.max(1, Math.floor(req.pageSize)) + 1; // +1 to detect "has more"
    const offset = Math.max(0, Math.floor(req.offset));
    return { sql: this.paginate(base, orderBy, limit, offset), params, target: this.displayTarget(req.object), errors, warnings: [] };
  }

  /** Same as browse but without pagination: used for "export all rows matching the filter". */
  buildBrowseAll(req: Omit<BrowseRequest, 'offset' | 'pageSize'>, columns?: Pick<ColumnInfo, 'name' | 'type'>[]): BuiltStatement {
    const b = this.buildBrowse({ ...req, offset: 0, pageSize: 1 }, columns);
    // strip the pagination we just added
    const sql = this.stripPagination(b.sql);
    return { ...b, sql };
  }

  protected stripPagination(sql: string): string {
    return sql.replace(/ LIMIT \d+ OFFSET \d+$/, '');
  }

  protected filterClause(f: Filter, params: SqlParam[]): string | null {
    const col = this.quoteIdent(f.column);
    const bind = (v: string) => {
      params.push({ value: v });
      return this.placeholder(params.length - 1);
    };
    switch (f.op) {
      case 'is_null':
        return `${col} IS NULL`;
      case 'is_not_null':
        return `${col} IS NOT NULL`;
      case 'contains':
        if (f.value === undefined || f.value === '') return null;
        return this.ilike(this.castToText(col), bind(`%${this.escapeLike(f.value)}%`)) + this.likeEscapeClause();
      case 'not_contains':
        if (f.value === undefined || f.value === '') return null;
        return `NOT (${this.ilike(this.castToText(col), bind(`%${this.escapeLike(f.value)}%`))}${this.likeEscapeClause()})`;
      case 'starts_with':
        if (f.value === undefined || f.value === '') return null;
        return this.ilike(this.castToText(col), bind(`${this.escapeLike(f.value)}%`)) + this.likeEscapeClause();
      case 'ends_with':
        if (f.value === undefined || f.value === '') return null;
        return this.ilike(this.castToText(col), bind(`%${this.escapeLike(f.value)}`)) + this.likeEscapeClause();
      case 'contains_cs':
        if (f.value === undefined || f.value === '') return null;
        return this.likeCaseSensitive(this.castToText(col), bind(`%${this.escapeLike(f.value)}%`)) + this.likeEscapeClause();
      case 'not_contains_cs':
        if (f.value === undefined || f.value === '') return null;
        return `NOT (${this.likeCaseSensitive(this.castToText(col), bind(`%${this.escapeLike(f.value)}%`))}${this.likeEscapeClause()})`;
      case 'starts_with_cs':
        if (f.value === undefined || f.value === '') return null;
        return this.likeCaseSensitive(this.castToText(col), bind(`${this.escapeLike(f.value)}%`)) + this.likeEscapeClause();
      case 'ends_with_cs':
        if (f.value === undefined || f.value === '') return null;
        return this.likeCaseSensitive(this.castToText(col), bind(`%${this.escapeLike(f.value)}`)) + this.likeEscapeClause();
      case 'like':
        if (f.value === undefined || f.value === '') return null;
        return `${this.castToText(col)} LIKE ${bind(f.value)}${this.likeEscapeClause()}`;
      case 'between':
      case 'not_between':
        if (!f.value || !f.value2) return null;
        return `${col} ${f.op === 'not_between' ? 'NOT BETWEEN' : 'BETWEEN'} ${bind(f.value)} AND ${bind(f.value2)}`;
      case 'in':
      case 'not_in': {
        const values = (f.value ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '');
        if (!values.length) return null;
        return `${col} ${f.op === 'not_in' ? 'NOT IN' : 'IN'} (${values.map(bind).join(', ')})`;
      }
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (f.value === undefined) return null;
        const op = f.op === '!=' ? '<>' : f.op;
        return `${col} ${op} ${bind(f.value)}`;
      }
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Insert
  // -------------------------------------------------------------------------

  buildInsert(spec: InsertSpec): BuiltStatement {
    const errors: string[] = [];
    const warnings: string[] = [];
    const params: SqlParam[] = [];
    const target = this.displayTarget(spec.object);
    if (spec.rows.length === 0) errors.push('Add at least one row.');
    if (spec.rows.length > this.maxInsertRows) errors.push(`At most ${this.maxInsertRows} rows can be inserted at once.`);

    const colByName = new Map(spec.columns.map((c) => [c.name, c]));
    for (const r of spec.rows) {
      for (const k of Object.keys(r)) if (!colByName.has(k)) errors.push(`Unknown column: ${k}`);
    }
    // Columns that receive an explicit value or NULL in at least one row.
    let used = spec.columns.filter((c) => spec.rows.some((r) => r[c.name] && r[c.name].kind !== 'default'));
    if (used.length === 0) {
      // Every cell uses the default: list all columns with DEFAULT so one statement works for every dialect.
      used = spec.columns;
      if (!this.supportsDefaultKeyword()) errors.push('This database does not support DEFAULT in INSERT.');
    }
    if (used.length === 0) errors.push('The table has no columns.');

    const tuples = spec.rows.map((r) =>
      used
        .map((c) => {
          const cell = r[c.name] ?? { kind: 'default' };
          if (cell.kind === 'null') return 'NULL';
          if (cell.kind === 'default') return 'DEFAULT';
          params.push({ value: cell.value });
          return this.insertValueExpr(this.placeholder(params.length - 1), c);
        })
        .join(', '),
    );
    if (!this.supportsDefaultKeyword() && tuples.some((t) => /\bDEFAULT\b/.test(t))) {
      errors.push('This database does not support DEFAULT in INSERT; enter a value or NULL.');
    }

    const sql =
      `INSERT INTO ${this.qualify(spec.object)} (${used.map((c) => this.quoteIdent(c.name)).join(', ')})\n` +
      `VALUES\n  ${tuples.map((t) => `(${t})`).join(',\n  ')}`;
    return { sql, params, target, errors: dedupe(errors), warnings };
  }

  supportsDefaultKeyword(): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Create table
  // -------------------------------------------------------------------------

  validateTypeName(type: string): boolean {
    // Letters/digits/spaces, optional (n), (p,s) or (max), optional [] array suffix, or Databricks <...> complex types.
    return /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*(\d+|max|MAX)(\s*,\s*\d+)?\s*\))?(\s*(\[\])+)?$/.test(type.trim()) ||
      /^(ARRAY|MAP|STRUCT)<[A-Za-z0-9_ ,:<>()]+>$/i.test(type.trim());
  }

  columnDefinition(c: ColumnSpec, _spec: CreateTableSpec): string {
    let def = `${this.quoteIdent(c.name)} ${c.type.trim()}`;
    if (!c.nullable) def += ' NOT NULL';
    const d = this.defaultClause(c);
    if (d) def += ` DEFAULT ${d}`;
    return def;
  }

  defaultClause(c: ColumnSpec): string | null {
    if (c.default.kind === 'none') return null;
    if (c.default.kind === 'expression') return c.default.value.trim();
    return this.literalForType(c.default.value, c.type);
  }

  /** Literal SQL for a default value given as text, typed by the column type. */
  literalForType(value: string, type: string): string {
    const kind = kindFromTypeName(type);
    if (kind === 'number' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) return value.trim();
    if (kind === 'bool' && /^(true|false)$/i.test(value.trim())) return this.booleanLiteral(/^true$/i.test(value.trim()));
    return this.stringLiteral(value);
  }

  booleanLiteral(v: boolean): string {
    return v ? 'TRUE' : 'FALSE';
  }

  createTablePrefix(spec: CreateTableSpec): string {
    return `CREATE TABLE ${spec.ifNotExists ? 'IF NOT EXISTS ' : ''}${this.qualify(spec.object)}`;
  }

  createTableSuffix(_spec: CreateTableSpec): string {
    return '';
  }

  validateCreate(spec: CreateTableSpec): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!spec.object.name.trim()) errors.push('Enter a table name.');
    if (spec.columns.length === 0) errors.push('Add at least one column.');
    const seen = new Set<string>();
    spec.columns.forEach((c, i) => {
      const label = c.name.trim() || `Column ${i + 1}`;
      if (!c.name.trim()) errors.push(`Column ${i + 1}: enter a name.`);
      const key = c.name.trim().toLowerCase();
      if (key && seen.has(key)) errors.push(`${label}: duplicate column name.`);
      seen.add(key);
      if (!c.type.trim()) errors.push(`${label}: choose a data type.`);
      else if (!this.validateTypeName(c.type)) errors.push(`${label}: "${c.type}" is not a valid type.`);
      if (c.primaryKey && c.nullable) warnings.push(`${label}: primary key columns are created NOT NULL.`);
      if (c.default.kind === 'expression') {
        if (!c.default.value.trim()) errors.push(`${label}: enter a default expression.`);
        else if (/;/.test(c.default.value)) errors.push(`${label}: default expression must not contain ';'.`);
        else warnings.push(`${label}: default expression is written into the SQL as-is.`);
      }
      if (c.default.kind === 'literal' && c.default.value === '' && kindFromTypeName(c.type) !== 'text') {
        warnings.push(`${label}: empty default for a non-text column.`);
      }
    });
    return { errors, warnings };
  }

  buildCreateTable(spec: CreateTableSpec): BuiltStatement {
    const normalized: CreateTableSpec = {
      ...spec,
      columns: spec.columns.map((c) => ({ ...c, nullable: c.primaryKey ? false : c.nullable })),
    };
    const { errors, warnings } = this.validateCreate(spec);
    const lines = normalized.columns.map((c) => '  ' + this.columnDefinition(c, normalized));
    const pk = normalized.columns.filter((c) => c.primaryKey);
    if (pk.length > 0) lines.push(`  ${this.primaryKeyClause(normalized, pk)}`);
    const sql = `${this.createTablePrefix(normalized)} (\n${lines.join(',\n')}\n)${this.createTableSuffix(normalized)}`;
    return { sql, params: [], target: this.displayTarget(spec.object), errors, warnings };
  }

  primaryKeyClause(_spec: CreateTableSpec, pk: ColumnSpec[]): string {
    return `PRIMARY KEY (${pk.map((c) => this.quoteIdent(c.name)).join(', ')})`;
  }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Inline parameters for display only (never executed). */
export function previewWithParams(stmt: BuiltStatement, dialect: Dialect): string {
  let q = 0;
  return stmt.sql.replace(/\$(\d+)|@p(\d+)|:p(\d+)|\?/g, (m, pg, ms, db) => {
    const idx = pg ? Number(pg) - 1 : ms ? Number(ms) : db ? Number(db) : q++;
    const p = stmt.params[idx];
    if (!p) return m;
    return p.value === null ? 'NULL' : dialect.stringLiteral(p.value);
  });
}
