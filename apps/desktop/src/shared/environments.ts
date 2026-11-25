import type { EnvironmentTag } from '@earthql/core';

export const ENV_PRESETS: readonly EnvironmentTag[] = [
  { name: 'Development', color: '#2f9e5b' },
  { name: 'Staging', color: '#d48806' },
  { name: 'Production', color: '#e5484d' },
  { name: 'Local', color: '#6e56cf' },
];
