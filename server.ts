import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { backends, fallbackTargets, spendTargets } from "./src/config.js";
import { checkAllBackends, healthRows, type HealthState } from "./src/health.js";
import {
  checkCeilings,
  getSpendWindow,
  listCeilings,
  migrations,
  recordSpend,
  refusalForCeiling,
  setCeiling,
  sumSpend,
} from "./src/ledger.js";
import { handleChatCompletions } from "./src/proxy.js";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    vercelAiGatewayApiKey: { type: "string", label: "Vercel AI Gateway API key", secret: true },
    vercelAiGatewayBaseUrl: {
      type: "string",
      label: "Vercel AI Gateway OpenAI-compatible base URL",
      default: "https://ai-gateway.vercel.sh/v1",
    },
    localBaseUrl: {
      type: "string",
      label: "LM Studio OpenAI-compatible base URL",
      default: "http://100.79.149.24:1234/v1",
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const initialSettings = await settings.get();
  if (!initialSettings.vercelAiGatewayApiKey) {
    bb.status.needsConfiguration(
      "Set vercelAiGatewayApiKey with `bb plugin config router`, then reload. The local tier can still be health-checked.",
    );
  }

  const health: HealthState = new Map();
  for (const row of healthRows(db)) {
    health.set(row.backendId, { ok: row.ok === 1, checkedAt: row.checkedAt, detail: row.detail });
  }

  bb.http.route(
    "POST",
    "/v1/chat/completions",
    async (context) => handleChatCompletions(context, db, await settings.get(), (id) => health.get(id)?.ok),
    { auth: "token" },
  );
  bb.http.route(
    "POST",
    "/chat/completions",
    async (context) => handleChatCompletions(context, db, await settings.get(), (id) => health.get(id)?.ok),
    { auth: "token" },
  );

  bb.agents.registerTool({
    name: "router_spend",
    description: "Check remaining router budget before cost-bearing model or external service calls.",
    instructions:
      "Use router_spend before expensive model calls or cost-bearing external services such as FAL and the Vercel AI Gateway.",
    experimental_statusLabels: {
      pending: "Checking router spend",
      completed: "Checked router spend",
    },
    parameters: z.object({
      target: z.string().min(1),
      estimatedUsd: z.number().min(0).default(0),
      consumer: z.string().min(1).default("agent"),
    }),
    execute({ target, estimatedUsd, consumer }) {
      const check = checkCeilings(db, target, consumer, estimatedUsd);
      if (!check.allowed) {
        return { content: [{ type: "text", text: JSON.stringify(refusalForCeiling(check), null, 2) }], isError: true };
      }
      const spend = getSpendWindow(db, target, consumer);
      return JSON.stringify({ target, consumer, allowed: true, current: spend, projected: check.projected }, null, 2);
    },
  });

  bb.agents.configure(() => ({
    tools: ["router_spend"],
    skills: [],
  }));

  bb.agents.contributeInstructions(() => {
    const localDown = [...health.entries()].some(([id, value]) => id.startsWith("local-") && !value.ok);
    if (!localDown) return null;
    return "Router notice: the local model tier is currently down. Use the router_spend tool before cost-bearing fallbacks and expect local requests to fail over when hosted budget permits.";
  });

  bb.cli.register({
    name: "router",
    summary: "Inspect and manage model-router tiers, health, spend, and ceilings.",
    commands: [
      { name: "status", summary: "Show router status.", usage: "bb router status" },
      { name: "tiers", summary: "List configured model tiers.", usage: "bb router tiers" },
      { name: "spend", summary: "Show spend ledger totals.", usage: "bb router spend [--target X --consumer Y --since YYYY-MM-DD]" },
      { name: "ceiling", summary: "Set a budget ceiling.", usage: "bb router ceiling <target> <daily> <monthly> [--consumer Y]" },
      { name: "health", summary: "Check backend health.", usage: "bb router health" },
      { name: "record", summary: "Record external service spend.", usage: "bb router record <target> <usd> [--note text] [--consumer Y]" },
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      if (command === "status") return { exitCode: 0, stdout: renderStatus(db, health) };
      if (command === "tiers") return { exitCode: 0, stdout: renderTiers() };
      if (command === "health") {
        await checkAllBackends(db, await settings.get(), health);
        return { exitCode: 0, stdout: renderHealth(db) };
      }
      if (command === "spend") return { exitCode: 0, stdout: renderSpend(db, argv.slice(1)) };
      if (command === "ceiling") return setCeilingFromArgv(db, argv.slice(1));
      if (command === "record") return recordFromArgv(db, argv.slice(1));
      return { exitCode: 2, stderr: "Usage: bb router status | tiers | spend | ceiling | health | record\n" };
    },
  });

  bb.background.service("health", {
    async start(signal) {
      while (!signal.aborted) {
        await checkAllBackends(db, await settings.get(), health);
        await sleep(60_000, signal);
      }
    },
  });
}

function renderStatus(db: import("better-sqlite3").Database, health: HealthState): string {
  const local = [...health.entries()].filter(([id]) => id.startsWith("local-"));
  const localOk = local.some(([, value]) => value.ok);
  return JSON.stringify(
    {
      status: "ok",
      localTier: localOk ? "available" : "down-or-unchecked",
      targets: spendTargets.map((target) => target.name),
      ceilings: listCeilings(db),
    },
    null,
    2,
  );
}

function renderTiers(): string {
  return JSON.stringify({ backends, fallbacks: fallbackTargets, spendTargets }, null, 2);
}

function renderHealth(db: import("better-sqlite3").Database): string {
  return JSON.stringify({ health: healthRows(db) }, null, 2);
}

function renderSpend(db: import("better-sqlite3").Database, argv: string[]): string {
  const target = option(argv, "--target") ?? "%";
  const consumer = option(argv, "--consumer") ?? "%";
  const since = option(argv, "--since") ?? new Date(0).toISOString();
  const rows = db
    .prepare(
      `SELECT target, consumer, COALESCE(SUM(amount_usd), 0) AS amountUsd
       FROM spend_events
       WHERE target LIKE ? AND consumer LIKE ? AND created_at >= ?
       GROUP BY target, consumer
       ORDER BY target, consumer`,
    )
    .all(target, consumer, since) as Array<{ target: string; consumer: string; amountUsd: number }>;
  return JSON.stringify({ since, rows }, null, 2);
}

function setCeilingFromArgv(db: import("better-sqlite3").Database, argv: string[]) {
  const [target, daily, monthly] = argv;
  const consumer = option(argv, "--consumer") ?? "*";
  if (!target || !daily || !monthly) {
    return { exitCode: 2, stderr: "Usage: bb router ceiling <target> <daily> <monthly> [--consumer Y]\n" };
  }
  setCeiling(db, target, consumer, Number(daily), Number(monthly));
  return { exitCode: 0, stdout: JSON.stringify({ target, consumer, dailyUsd: Number(daily), monthlyUsd: Number(monthly) }, null, 2) };
}

function recordFromArgv(db: import("better-sqlite3").Database, argv: string[]) {
  const [target, amount] = argv;
  const note = option(argv, "--note");
  const consumer = option(argv, "--consumer") ?? "self-reported";
  if (!target || !amount) return { exitCode: 2, stderr: "Usage: bb router record <target> <usd> [--note text] [--consumer Y]\n" };
  const amountUsd = Number(amount);
  const check = checkCeilings(db, target, consumer, amountUsd);
  if (!check.allowed) return { exitCode: 1, stdout: JSON.stringify(refusalForCeiling(check), null, 2) };
  recordSpend(db, { target, consumer, amountUsd, note, source: "cli" });
  return { exitCode: 0, stdout: JSON.stringify({ recorded: true, target, consumer, amountUsd }, null, 2) };
}

function option(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}
