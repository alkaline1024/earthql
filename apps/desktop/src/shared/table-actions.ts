import type { DriverId, ObjectPath } from '@earthql/core';
export type TableAction = 'clone' | 'truncate' | 'delete';
export interface TableActionRequest {
  action: TableAction;
  object: ObjectPath;
  cloneName: string;
  copyData: boolean;
  restartIdentity: boolean;
  ignoreForeignKeys: boolean;
  cascade: boolean;
}
export function tableActionOptions(driver: DriverId) {
  return {
    restartIdentity: driver === 'postgres',
    resetsIdentity: driver === 'mysql' || driver === 'mssql',
    ignoreForeignKeys: driver === 'mysql',
    cascade: driver === 'postgres',
  };
}

export type StructureEdit =
  | { kind: 'rename'; column: string; name: string }
  | { kind: 'add'; name: string; type: string }
  | { kind: 'columnType'; column: string; type: string }
  | { kind: 'drop'; column: string }
  | { kind: 'addIndex' | 'addConstraint'; name: string; columns: string; unique?: boolean }
  | { kind: 'dropIndex'; name: string }
  | { kind: 'dropConstraint'; name: string }
  | { kind: 'renameIndex'; name: string; next: string }
  | { kind: 'renameConstraint'; name: string; next: string };
