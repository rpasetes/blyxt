// Just enough of D1 over bun:sqlite to run store and subscribe code against the real migrations.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

class Statement {
  constructor(readonly sqlite: Database, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new Statement(this.sqlite, this.sql, params);
  }
  async all<T>() {
    return { results: this.sqlite.query(this.sql).all(...(this.params as never[])) as T[] };
  }
  async first<T>() {
    return (this.sqlite.query(this.sql).get(...(this.params as never[])) ?? null) as T | null;
  }
  async run() {
    this.sqlite.query(this.sql).run(...(this.params as never[]));
    return { success: true };
  }
}

// a D1 with migrations applied up to (not including) `before`, e.g. "0004"
export function d1(before?: string) {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = {
    sqlite,
    prepare: (sql: string) => new Statement(sqlite, sql),
    batch: async (stmts: Statement[]) => sqlite.transaction(() => stmts.map((s) => s.sqlite.query(s.sql).run(...(s.params as never[]))))(),
    migrate(until?: string) {
      for (const file of readdirSync(MIGRATIONS).sort()) {
        if (until && file >= until) break;
        if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE name = '_migrations'").get()) sqlite.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)");
        if (sqlite.query("SELECT 1 FROM _migrations WHERE name = ?").get(file)) continue;
        sqlite.exec(readFileSync(MIGRATIONS + file, "utf8"));
        sqlite.query("INSERT INTO _migrations (name) VALUES (?)").run(file);
      }
      return db;
    },
  };
  return db.migrate(before) as typeof db & D1Database;
}
