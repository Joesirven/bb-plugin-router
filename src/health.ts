import type Database from "better-sqlite3";
import { backends, type BackendDefinition } from "./config.js";

type Settings = {
  localBaseUrl: string;
  vercelAiGatewayBaseUrl: string;
  vercelAiGatewayApiKey?: string;
};

export type HealthState = Map<string, { ok: boolean; detail: string; checkedAt: string }>;

export async function checkAllBackends(
  db: Database.Database,
  settings: Settings,
  state: HealthState,
): Promise<void> {
  for (const backend of backends) {
    const result = await checkBackend(backend, settings);
    state.set(backend.id, result);
    db.prepare(
      `INSERT INTO backend_health (backend_id, ok, checked_at, detail)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(backend_id) DO UPDATE SET
         ok = excluded.ok,
         checked_at = excluded.checked_at,
         detail = excluded.detail`,
    ).run(backend.id, result.ok ? 1 : 0, result.checkedAt, result.detail);
  }
}

export async function checkBackend(
  backend: BackendDefinition,
  settings: Settings,
): Promise<{ ok: boolean; detail: string; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  if (backend.apiKeySetting && !settings[backend.apiKeySetting]) {
    return { ok: false, detail: `missing ${backend.apiKeySetting}`, checkedAt };
  }
  const baseUrl = backend.baseUrl === "localBaseUrl" ? settings.localBaseUrl : settings.vercelAiGatewayBaseUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: backend.apiKeySetting ? { authorization: `Bearer ${settings[backend.apiKeySetting]}` } : {},
      signal: controller.signal,
    });
    return { ok: response.ok, detail: response.ok ? "ok" : `HTTP ${response.status}`, checkedAt };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error), checkedAt };
  } finally {
    clearTimeout(timer);
  }
}

export function healthRows(db: Database.Database) {
  return db
    .prepare(
      `SELECT backend_id AS backendId, ok, checked_at AS checkedAt, detail
       FROM backend_health
       ORDER BY backend_id`,
    )
    .all() as Array<{ backendId: string; ok: 0 | 1; checkedAt: string; detail: string }>;
}
