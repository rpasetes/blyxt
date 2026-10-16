// Just enough of D1 over `wrangler d1 execute --remote` for maintenance scripts to reuse the Worker's queries.
// wrangler takes no bound parameters, so values are inlined as SQL literals.
import { $ } from "bun";

const literal = (v: unknown) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

function inline(sql: string, params: unknown[]) {
  let next = 0;
  return sql.replace(/\?(\d+)?/g, (_, n?: string) => literal(params[n ? Number(n) - 1 : next++]));
}

async function run(sql: string) {
  const out = await $`bunx wrangler d1 execute blyxt --remote --json --command ${sql}`.quiet().json();
  return (Array.isArray(out) ? out[0] : out).results as unknown[];
}

class Statement {
  constructor(readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) { return new Statement(this.sql, params); }
  async all<T>() { return { results: (await run(inline(this.sql, this.params))) as T[] }; }
  async first<T>() { return ((await run(inline(this.sql, this.params)))[0] ?? null) as T | null; }
  async run() { await run(inline(this.sql, this.params)); return { success: true }; }
}

export const remoteD1 = {
  prepare: (sql: string) => new Statement(sql),
  async batch(statements: Statement[]) { for (const s of statements) await s.run(); return []; },
} as unknown as D1Database;
