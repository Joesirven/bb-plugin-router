import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { checkCeilings, getSpendWindow, migrations, recordSpend, refusalForCeiling, setCeiling } from "../src/ledger.js";
import { backends } from "../src/config.js";
import { costFromUsage, routedTargetsFor } from "../src/proxy.js";

function makeDb() {
  const db = new Database(":memory:");
  for (const migration of migrations) db.exec(migration);
  return db;
}

describe("ledger math", () => {
  it("sums daily and monthly spend for one target and consumer", () => {
    const db = makeDb();
    const now = new Date("2026-08-07T12:00:00.000Z");
    recordSpend(db, { target: "cheap", consumer: "workers", amountUsd: 1.25, source: "test", now });
    recordSpend(db, { target: "cheap", consumer: "workers", amountUsd: 2.5, source: "test", now });
    recordSpend(db, { target: "cheap", consumer: "voice", amountUsd: 9, source: "test", now });

    expect(getSpendWindow(db, "cheap", "workers", now)).toEqual({ dailyUsd: 3.75, monthlyUsd: 3.75 });
  });

  it("enforces target ceilings with a structured refusal", () => {
    const db = makeDb();
    const now = new Date("2026-08-07T12:00:00.000Z");
    setCeiling(db, "frontier", "*", 2, 10, now);
    recordSpend(db, { target: "frontier", consumer: "workers", amountUsd: 1.75, source: "test", now });

    const check = checkCeilings(db, "frontier", "workers", 0.5, now);
    expect(check.allowed).toBe(false);
    if (!check.allowed) {
      expect(refusalForCeiling(check)).toMatchObject({
        error: {
          code: "budget_ceiling_exceeded",
          target: "frontier",
          consumer: "workers",
          violated: [{ window: "daily", ceilingUsd: 2 }],
        },
      });
    }
  });

  it("enforces consumer ceilings across any target", () => {
    const db = makeDb();
    const now = new Date("2026-08-07T12:00:00.000Z");
    setCeiling(db, "*", "indexing", 1, 3, now);
    recordSpend(db, { target: "embed", consumer: "indexing", amountUsd: 0.75, source: "test", now });

    expect(checkCeilings(db, "fal", "indexing", 0.1, now).allowed).toBe(true);
    expect(checkCeilings(db, "fal", "indexing", 0.5, now).allowed).toBe(false);
  });
});

describe("proxy cost estimation", () => {
  it("uses carried-over token prices from the live config mapping", () => {
    const backend = backends.find((item) => item.id === "cheap-deepseek");
    expect(backend).toBeTruthy();
    expect(costFromUsage({ usage: { prompt_tokens: 1000, completion_tokens: 2000 } }, backend!)).toBeCloseTo(0.00112);
  });

  it("keeps the carried-over local failover order", () => {
    expect(routedTargetsFor("local")).toEqual(["local", "cheap"]);
  });
});
