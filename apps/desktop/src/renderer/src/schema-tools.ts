import { describePath, type ObjectPath, type TableStructure, type TreeNode } from '@earthql/core';

export interface SchemaSnapshot {
  objects: TableStructure[];
  errors: string[];
}

export async function readSchema(options: {
  parent: TreeNode;
  children(parent: TreeNode): Promise<TreeNode[]>;
  structure(path: ObjectPath): Promise<TableStructure>;
  errorMessage(error: unknown): string;
  cancelled(): boolean;
  progress(done: number, total: number): void;
}): Promise<SchemaSnapshot> {
  const objects: TableStructure[] = [];
  const errors: string[] = [];
  const nodes = (await options.children(options.parent)).filter((node) =>
    !node.hasChildren && (node.kind === 'table' || node.kind === 'view') && node.path.name);
  for (const [index, node] of nodes.entries()) {
    if (options.cancelled()) break;
    const object = { ...node.path, name: node.path.name! };
    try {
      const structure = await options.structure(object);
      if (options.cancelled()) break;
      objects.push(structure);
      for (const [name, status] of [['columns', structure.columnsStatus], ['indexes', structure.indexesStatus], ['constraints', structure.constraintsStatus]] as const) {
        if (status.state === 'denied' || status.state === 'unsupported') errors.push(`${describePath(object)} ${name}: ${status.message}`);
      }
    } catch (error) {
      if (options.cancelled()) break;
      errors.push(`${describePath(object)}: ${options.errorMessage(error)}`);
    }
    options.progress(index + 1, nodes.length);
  }
  return { objects, errors };
}

export interface SchemaDifference {
  object: string;
  detail: string;
}

export function compareSchemas(source: SchemaSnapshot, target: SchemaSnapshot): SchemaDifference[] {
  const differences: SchemaDifference[] = [];
  const left = new Map(source.objects.map((object) => [object.object.name, object]));
  const right = new Map(target.objects.map((object) => [object.object.name, object]));
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(name), b = right.get(name);
    if (!a || !b) {
      differences.push({ object: name, detail: a ? 'Only in source' : 'Only in target' });
      continue;
    }
    if (a.kind !== b.kind) differences.push({ object: name, detail: `Kind: ${a.kind} → ${b.kind}` });
    if (a.columnsStatus.state === 'ok' || a.columnsStatus.state === 'empty') {
      if (b.columnsStatus.state === 'ok' || b.columnsStatus.state === 'empty') {
        const colsA = new Map(a.columns.map((column) => [column.name, column]));
        const colsB = new Map(b.columns.map((column) => [column.name, column]));
        for (const column of [...new Set([...colsA.keys(), ...colsB.keys()])].sort()) {
          const x = colsA.get(column), y = colsB.get(column);
          if (!x || !y) differences.push({ object: name, detail: `Column ${column}: ${x ? 'only in source' : 'only in target'}` });
          else {
            const fields = ['type', 'nullable', 'defaultValue', 'isPrimaryKey', 'isIdentity', 'isGenerated'] as const;
            const changed = fields.filter((field) => (x[field] ?? null) !== (y[field] ?? null));
            if (changed.length) differences.push({ object: name, detail: `Column ${column}: changed ${changed.join(', ')}` });
          }
        }
      }
    }
    for (const section of ['indexes', 'constraints'] as const) {
      const status = `${section}Status` as const;
      if ((a[status].state === 'ok' || a[status].state === 'empty') && (b[status].state === 'ok' || b[status].state === 'empty')) {
        const summarize = (items: TableStructure[typeof section]) => JSON.stringify(items.map((item) => ({
          name: item.name, columns: item.columns,
          ...(section === 'indexes' && 'unique' in item ? { unique: item.unique, primary: item.primary, definition: item.definition } : {}),
          ...(section === 'constraints' && 'type' in item ? { type: item.type, definition: item.definition, references: item.references, foreignColumns: item.foreignTarget?.columns } : {}),
        })).sort((x, y) => x.name.localeCompare(y.name)));
        if (summarize(a[section]) !== summarize(b[section])) differences.push({ object: name, detail: `${section[0].toUpperCase()}${section.slice(1)} differ` });
      }
    }
  }
  return differences;
}

export function schemaObjectKey(path: ObjectPath): string {
  return JSON.stringify([path.catalog ?? '', path.database ?? '', path.schema ?? '', path.name]);
}

export function schemaDiagram(snapshot: SchemaSnapshot) {
  const nodes = snapshot.objects.filter((object) => object.kind === 'table').map((object) => ({
    key: schemaObjectKey(object.object), path: object.object, columns: object.columns.map((column) => column.name), external: false,
  }));
  const keys = new Set(nodes.map((node) => node.key));
  const edges: { source: string; target: string; label: string }[] = [];
  for (const object of snapshot.objects) {
    if (object.kind !== 'table') continue;
    for (const constraint of object.constraints) {
      if (!constraint.foreignTarget) continue;
      const target = schemaObjectKey(constraint.foreignTarget.object);
      if (!keys.has(target)) {
        nodes.push({ key: target, path: constraint.foreignTarget.object, columns: [], external: true });
        keys.add(target);
      }
      edges.push({ source: schemaObjectKey(object.object), target,
        label: `${constraint.name}: ${constraint.columns.join(', ')} → ${constraint.foreignTarget.columns.join(', ')}` });
    }
  }
  return { nodes, edges };
}
