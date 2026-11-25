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
