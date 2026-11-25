const VARIABLE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export function snippetVariables(sql: string): string[] {
  return [...new Set(Array.from(sql.matchAll(VARIABLE), (match) => match[1]))];
}

export function fillSnippet(sql: string, values: Record<string, string>): string {
  return sql.replace(VARIABLE, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Missing value for ${name}.`);
    return values[name];
  });
}
