import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Separate config (not mergeConfig: that would concatenate the unit-test exclude list).
export default defineConfig({
  resolve: base.resolve,
  test: { include: ['packages/*/test/**/*.integration.test.ts'], testTimeout: 120000, hookTimeout: 120000, fileParallelism: false },
});
