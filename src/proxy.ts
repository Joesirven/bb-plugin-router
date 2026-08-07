import type Database from "better-sqlite3";
import type { Context } from "hono";
import { candidatesForTarget, fallbackTargets, normalizeTarget, type BackendDefinition } from "./config.js";
import { checkCeilings, recordSpend, refusalForCeiling } from "./ledger.js";

type Settings = {
  localBaseUrl: string;
  vercelAiGatewayBaseUrl: string;
  vercelAiGatewayApiKey?: string;
};

type HealthLookup = (backendId: string) => boolean | undefined;

export async function handleChatCompletions(
  context: Context,
  db: Database.Database,
  settings: Settings,
  health: HealthLookup,
): Promise<Response> {
  const body = await context.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return context.json({ error: { code: "invalid_json", message: "Expected a JSON request body." } }, 400);
  }
  const requestedModel = typeof body.model === "string" ? body.model : "auto";
  const target = normalizeTarget(requestedModel);
  const consumer = context.req.header("x-bb-router-consumer") ?? body.user ?? "anonymous";
  const pendingUsd = Number(context.req.header("x-bb-router-estimated-usd") ?? 0);
  const estimatedUsd = Number.isFinite(pendingUsd) ? pendingUsd : 0;
  const preflight = checkCeilings(db, target, String(consumer), estimatedUsd);
  if (!preflight.allowed) {
    return context.json(refusalForCeiling(preflight), 402);
  }

  const targetOrder = [target, ...(fallbackTargets[target] ?? [])];
  if (targetOrder.every((candidateTarget) => candidatesForTarget(candidateTarget).length === 0)) {
    return context.json({ error: { code: "unknown_spend_target", message: `No backend is configured for ${target}.` } }, 400);
  }

  const failures: string[] = [];
  for (const routedTarget of targetOrder) {
    const routedPreflight = checkCeilings(db, routedTarget, String(consumer), estimatedUsd);
    if (!routedPreflight.allowed) {
      return context.json(refusalForCeiling(routedPreflight), 402);
    }
    for (const backend of candidatesForTarget(routedTarget)) {
      if (health(backend.id) === false) {
        failures.push(`${backend.id}: unhealthy`);
        continue;
      }
      const forward = await forwardToBackend(backend, body, settings, context.req.raw.signal).catch((error: unknown) => {
        failures.push(`${backend.id}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (!forward) continue;
      if (!forward.response.ok) {
        failures.push(`${backend.id}: ${forward.response.status}`);
        continue;
      }
      const responseBody = forward.body;
      const amountUsd = costFromUsage(responseBody, backend);
      const postflight = checkCeilings(db, routedTarget, String(consumer), amountUsd);
      if (!postflight.allowed) {
        return context.json(refusalForCeiling(postflight), 402);
      }
      recordSpend(db, {
        target: routedTarget,
        consumer: String(consumer),
        amountUsd,
        source: "proxy",
        metadata: {
          requestedModel,
          requestedTarget: target,
          routedTarget,
          backendId: backend.id,
          backendModel: backend.model,
          usage: responseBody?.usage ?? null,
        },
      });
      return context.json(responseBody, 200);
    }
  }

  return context.json(
    {
      error: {
        code: "backend_unavailable",
        message: "No healthy configured backend accepted the request.",
        target,
        failures,
      },
    },
    503,
  );
}

export function routedTargetsFor(requestedTarget: string): string[] {
  return [requestedTarget, ...(fallbackTargets[requestedTarget] ?? [])];
}

async function forwardToBackend(
  backend: BackendDefinition,
  originalBody: Record<string, unknown>,
  settings: Settings,
  signal: AbortSignal,
): Promise<{ response: Response; body: any }> {
  const baseUrl = resolveBaseUrl(backend, settings);
  const apiKey = backend.apiKeySetting ? settings[backend.apiKeySetting] : undefined;
  if (backend.apiKeySetting && !apiKey) {
    throw new Error(`missing ${backend.apiKeySetting}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), backend.timeoutMs);
  signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...originalBody, model: backend.model }),
      signal: controller.signal,
    });
    const body = await response.json().catch(async () => ({ raw: await response.text().catch(() => "") }));
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function resolveBaseUrl(backend: BackendDefinition, settings: Settings): string {
  if (backend.baseUrl === "localBaseUrl") return settings.localBaseUrl;
  return settings.vercelAiGatewayBaseUrl;
}

export function costFromUsage(responseBody: any, backend: BackendDefinition): number {
  const usage = responseBody?.usage;
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return 0;
  return inputTokens * backend.cost.inputCostPerToken + outputTokens * backend.cost.outputCostPerToken;
}
