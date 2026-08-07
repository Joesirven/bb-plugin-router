export type SpendTargetKind = "model-tier" | "external-service";

export type ModelCost = {
  inputCostPerToken: number;
  outputCostPerToken: number;
};

export type BackendDefinition = {
  id: string;
  target: string;
  tier: "local" | "cheap" | "mid" | "frontier";
  model: string;
  baseUrl?: string;
  apiKeySetting?: "vercelAiGatewayApiKey";
  timeoutMs: number;
  cost: ModelCost;
};

export type SpendTargetDefinition = {
  name: string;
  kind: SpendTargetKind;
  description: string;
};

export const spendTargets: SpendTargetDefinition[] = [
  { name: "local", kind: "model-tier", description: "LM Studio on the Mac Mini." },
  { name: "cheap", kind: "model-tier", description: "Hosted low-cost completion tier." },
  { name: "mid", kind: "model-tier", description: "Hosted middle completion tier." },
  { name: "frontier", kind: "model-tier", description: "Hosted frontier completion tier." },
  { name: "classify", kind: "model-tier", description: "Hosted classification tier." },
  { name: "embed", kind: "model-tier", description: "Hosted embedding tier." },
  { name: "local-embed", kind: "model-tier", description: "Local Nomic embedding tier." },
  { name: "fal", kind: "external-service", description: "FAL external service spend." },
  { name: "vercel-ai-gateway", kind: "external-service", description: "Vercel AI Gateway spend." },
];

export const backends: BackendDefinition[] = [
  {
    id: "local-qwen",
    target: "local",
    tier: "local",
    model: "qwen/qwen3.5-9b",
    baseUrl: "localBaseUrl",
    timeoutMs: 120_000,
    cost: { inputCostPerToken: 0, outputCostPerToken: 0 },
  },
  {
    id: "cheap-deepseek",
    target: "cheap",
    tier: "cheap",
    model: "vercel_ai_gateway/deepseek/deepseek-v3.2",
    apiKeySetting: "vercelAiGatewayApiKey",
    timeoutMs: 120_000,
    cost: { inputCostPerToken: 2.8e-7, outputCostPerToken: 4.2e-7 },
  },
  {
    id: "cheap-gemini-flash-lite",
    target: "cheap",
    tier: "cheap",
    model: "vercel_ai_gateway/google/gemini-3.1-flash-lite",
    apiKeySetting: "vercelAiGatewayApiKey",
    timeoutMs: 120_000,
    cost: { inputCostPerToken: 1.0e-7, outputCostPerToken: 4.0e-7 },
  },
  {
    id: "mid-kimi",
    target: "mid",
    tier: "mid",
    model: "vercel_ai_gateway/moonshotai/kimi-k2.6",
    apiKeySetting: "vercelAiGatewayApiKey",
    timeoutMs: 120_000,
    cost: { inputCostPerToken: 9.5e-7, outputCostPerToken: 4.0e-6 },
  },
  {
    id: "mid-glm",
    target: "mid",
    tier: "mid",
    model: "vercel_ai_gateway/zai/glm-4.6",
    apiKeySetting: "vercelAiGatewayApiKey",
    timeoutMs: 120_000,
    cost: { inputCostPerToken: 6.0e-7, outputCostPerToken: 2.2e-6 },
  },
  {
    id: "frontier-fable",
    target: "frontier",
    tier: "frontier",
    model: "vercel_ai_gateway/anthropic/claude-fable-5",
    apiKeySetting: "vercelAiGatewayApiKey",
    timeoutMs: 180_000,
    cost: { inputCostPerToken: 1.0e-5, outputCostPerToken: 5.0e-5 },
  },
  {
    id: "frontier-opus",
    target: "frontier",
    tier: "frontier",
    model: "vercel_ai_gateway/anthropic/claude-opus-4.8",
    apiKeySetting: "vercelAiGatewayApiKey",
    timeoutMs: 180_000,
    cost: { inputCostPerToken: 5.0e-6, outputCostPerToken: 2.5e-5 },
  },
  {
    id: "frontier-gemini",
    target: "frontier",
    tier: "frontier",
    model: "vercel_ai_gateway/google/gemini-3-pro-preview",
    apiKeySetting: "vercelAiGatewayApiKey",
    timeoutMs: 180_000,
    cost: { inputCostPerToken: 2.0e-6, outputCostPerToken: 1.2e-5 },
  },
];

export const fallbackTargets: Record<string, string[]> = {
  cheap: ["classify"],
  mid: ["cheap"],
  smart: ["cheap"],
  local: ["cheap"],
  auto: ["cheap", "local"],
};

export function normalizeTarget(model: string | undefined): string {
  if (!model || model === "auto") return "mid";
  if (model === "smart") return "mid";
  if (model === "frontier-fable" || model === "frontier-opus" || model === "frontier-gemini") {
    return "frontier";
  }
  if (model === "frontier") return "frontier";
  return model;
}

export function candidatesForTarget(target: string): BackendDefinition[] {
  return backends.filter((backend) => backend.target === target);
}
