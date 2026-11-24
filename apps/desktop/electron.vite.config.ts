import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const pkg = (n: string) => path.join(root, `packages/${n}/src/index.ts`);
const alias = {
  '@earthql/core': pkg('core'),
  '@earthql/driver-postgres': pkg('driver-postgres'),
  '@earthql/driver-mysql': pkg('driver-mysql'),
  '@earthql/driver-databricks': pkg('driver-databricks'),
  '@earthql/driver-mssql': pkg('driver-mssql'),
};
// Workspace packages are TypeScript sources: bundle them; keep real npm dependencies external.
const workspace = Object.keys(alias);

// Strict CSP for the packaged app (the dev server needs inline scripts for React Fast Refresh).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'";
const cspPlugin = {
  name: 'earthql-csp',
  apply: 'build' as const,
  transformIndexHtml(html: string) {
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
  },
};

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      externalizeDeps: { exclude: workspace },
      rollupOptions: {
        external: ['pg', 'pg-cursor', 'mysql2', 'mssql', '@databricks/sql', '@napi-rs/keyring', 'pg-native'],
      },
    },
  },
  preload: {
    resolve: { alias },
    build: { externalizeDeps: { exclude: workspace } },
  },
  renderer: {
    root: path.resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@earthql/core': pkg('core') } },
    plugins: [react(), cspPlugin],
    build: { rollupOptions: { input: path.resolve(__dirname, 'src/renderer/index.html') } },
  },
});
