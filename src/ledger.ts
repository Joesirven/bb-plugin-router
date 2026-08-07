import type Database from "better-sqlite3";

export type Ceiling = {
  target: string;
  consumer: string;
  dailyUsd: number;
  monthlyUsd: number;
};

export type SpendWindow = {
  dailyUsd: number;
  monthlyUsd: number;
};

export type CeilingCheck =
  | { allowed: true; target: string; consumer: string; projected: SpendWindow }
  | {
      allowed: false;
      target: string;
      consumer: string;
      projected: SpendWindow;
      violated: Array<{
        target: string;
        consumer: string;
        window: "daily" | "monthly";
        ceilingUsd: number;
        projectedUsd: number;
      }>;
    };

export const migrations = [
  `CREATE TABLE IF NOT EXISTS spend_events (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    consumer TEXT NOT NULL DEFAULT '*',
    amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
    note TEXT,
    source TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS spend_events_target_consumer_created_at
    ON spend_events(target, consumer, created_at)`,
  `CREATE TABLE IF NOT EXISTS ceilings (
    target TEXT NOT NULL,
    consumer TEXT NOT NULL DEFAULT '*',
    daily_usd REAL NOT NULL CHECK (daily_usd >= 0),
    monthly_usd REAL NOT NULL CHECK (monthly_usd >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (target, consumer)
  )`,
  `CREATE TABLE IF NOT EXISTS backend_health (
    backend_id TEXT PRIMARY KEY,
    ok INTEGER NOT NULL,
    checked_at TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  )`,
];

export function startOfUtcDay(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function startOfUtcMonth(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function getSpendWindow(
  db: Database.Database,
  target: string,
  consumer: string,
  now = new Date(),
): SpendWindow {
  const daily = sumSpend(db, target, consumer, startOfUtcDay(now));
  const monthly = sumSpend(db, target, consumer, startOfUtcMonth(now));
  return { dailyUsd: daily, monthlyUsd: monthly };
}

export function sumSpend(
  db: Database.Database,
  target: string,
  consumer: string,
  sinceIso: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS total
       FROM spend_events
       WHERE (? = '*' OR target = ?)
         AND (? = '*' OR consumer = ?)
         AND created_at >= ?`,
    )
    .get(target, target, consumer, consumer, sinceIso) as { total: number };
  return Number(row.total) || 0;
}

export function setCeiling(
  db: Database.Database,
  target: string,
  consumer: string,
  dailyUsd: number,
  monthlyUsd: number,
  now = new Date(),
): void {
  db.prepare(
    `INSERT INTO ceilings (target, consumer, daily_usd, monthly_usd, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(target, consumer) DO UPDATE SET
       daily_usd = excluded.daily_usd,
       monthly_usd = excluded.monthly_usd,
       updated_at = excluded.updated_at`,
  ).run(target, consumer, dailyUsd, monthlyUsd, now.toISOString());
}

export function listCeilings(db: Database.Database): Ceiling[] {
  return db
    .prepare(
      `SELECT target, consumer, daily_usd AS dailyUsd, monthly_usd AS monthlyUsd
       FROM ceilings
       ORDER BY target, consumer`,
    )
    .all() as Ceiling[];
}

export function checkCeilings(
  db: Database.Database,
  target: string,
  consumer: string,
  pendingUsd: number,
  now = new Date(),
): CeilingCheck {
  const matching = db
    .prepare(
      `SELECT target, consumer, daily_usd AS dailyUsd, monthly_usd AS monthlyUsd
       FROM ceilings
       WHERE (target = ? OR target = '*') AND (consumer = ? OR consumer = '*')`,
    )
    .all(target, consumer) as Ceiling[];
  const projected = {
    dailyUsd: getSpendWindow(db, target, consumer, now).dailyUsd + pendingUsd,
    monthlyUsd: getSpendWindow(db, target, consumer, now).monthlyUsd + pendingUsd,
  };
  const violated = [];
  for (const ceiling of matching) {
    const aggregateTarget = ceiling.target;
    const aggregateConsumer = ceiling.consumer;
    const current = getSpendWindow(db, aggregateTarget, aggregateConsumer, now);
    const ceilingProjected = {
      dailyUsd: current.dailyUsd + pendingUsd,
      monthlyUsd: current.monthlyUsd + pendingUsd,
    };
    if (ceiling.dailyUsd > 0 && ceilingProjected.dailyUsd > ceiling.dailyUsd) {
      violated.push({
        target: ceiling.target,
        consumer: ceiling.consumer,
        window: "daily" as const,
        ceilingUsd: ceiling.dailyUsd,
        projectedUsd: ceilingProjected.dailyUsd,
      });
    }
    if (ceiling.monthlyUsd > 0 && ceilingProjected.monthlyUsd > ceiling.monthlyUsd) {
      violated.push({
        target: ceiling.target,
        consumer: ceiling.consumer,
        window: "monthly" as const,
        ceilingUsd: ceiling.monthlyUsd,
        projectedUsd: ceilingProjected.monthlyUsd,
      });
    }
  }
  if (violated.length > 0) {
    return { allowed: false, target, consumer, projected, violated };
  }
  return { allowed: true, target, consumer, projected };
}

export function recordSpend(
  db: Database.Database,
  input: {
    target: string;
    consumer: string;
    amountUsd: number;
    note?: string;
    source: string;
    metadata?: unknown;
    now?: Date;
  },
): void {
  db.prepare(
    `INSERT INTO spend_events
      (id, target, consumer, amount_usd, note, source, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.target,
    input.consumer,
    input.amountUsd,
    input.note ?? null,
    input.source,
    JSON.stringify(input.metadata ?? {}),
    (input.now ?? new Date()).toISOString(),
  );
}

export function refusalForCeiling(check: Extract<CeilingCheck, { allowed: false }>) {
  return {
    error: {
      code: "budget_ceiling_exceeded",
      message: "The router refused this request because it would exceed a configured budget ceiling.",
      target: check.target,
      consumer: check.consumer,
      projected: check.projected,
      violated: check.violated,
    },
  };
}
