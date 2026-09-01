import migrationSql from '../drizzle/0000_magical_sleepwalker.sql?raw';

let initialization: Promise<void> | undefined;

export function ensureDatabase(db: D1Database) {
  if (!initialization) {
    initialization = initialize(db).catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

async function initialize(db: D1Database) {
  const statements = migrationSql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  await db.batch(statements.map((statement) => db.prepare(statement)));
  await db.prepare('PRAGMA optimize').run();
}
