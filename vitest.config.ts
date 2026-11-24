import { defineConfig } from 'vitest/config';
import path from 'node:path';

const pkg = (n: string) => path.resolve(__dirname, `packages/${n}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@earthql/core': pkg('core'),
      '@earthql/driver-postgres': pkg('driver-postgres'),
      '@earthql/driver-mysql': pkg('driver-mysql'),
      '@earthql/driver-databricks': pkg('driver-databricks'),
      '@earthql/driver-mssql': pkg('driver-mssql'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['packages/*/test/**/*.integration.test.ts'],
  },
});
