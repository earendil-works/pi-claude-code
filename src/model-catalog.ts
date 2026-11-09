import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export const PROVIDER_ID = "claude-code";
export const API_ID = "claude-code-stream-json";

export type ClaudeCodeModel = Model<typeof API_ID>;

export interface DiscoveredClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

// Pi exposes providers/all to extensions, but not individual generated model files.
const BUILTIN_ANTHROPIC_MODELS: Record<string, Model<"anthropic-messages">> = Object.fromEntries(
  getBuiltinModels("anthropic").map((model) => [model.id, model]),
);

/** What Claude Code's catalog and Pi's built-in models say about each discovered model id. */
interface ModelTraits {
  route: string;
  nativeToolChanges: boolean;
  adaptiveThinking: boolean;
  disabledThinking: boolean;
}
const TRAITS_BY_ID = new Map<string, ModelTraits>();

const FALLBACK_DISCOVERY: DiscoveredClaudeModel[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for the hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

function withoutContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/u, "");
}

function canonicalModelId(info: DiscoveredClaudeModel): string {
  if (info.value === "default") return "default";
  return withoutContextSuffix(info.resolvedModel || ALIASES[withoutContextSuffix(info.value)] || info.value);
}

function fallbackModel(info: DiscoveredClaudeModel, id: string): ClaudeCodeModel {
  const supported = info.supportedEffortLevels;
  const thinkingLevelMap = supported?.length
    ? (Object.fromEntries(supported.map((level) => [level, level])) as ClaudeCodeModel["thinkingLevelMap"])
    : undefined;
  return {
    id,
    name: `${info.displayName} (Claude Code)`,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-code",
    reasoning: info.supportsAdaptiveThinking === true || info.supportsEffort === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: /\b1M context\b/iu.test(info.description) ? 1_000_000 : 200_000,
    maxTokens: 64_000,
  };
}

function fromBuiltin(info: DiscoveredClaudeModel, id: string, builtin: Model<"anthropic-messages">): ClaudeCodeModel {
  const {
    api: _api,
    provider: _provider,
    baseUrl: _baseUrl,
    compat: _compat,
    ...metadata
  } = builtin;
  return {
    ...metadata,
    id,
    name: id === "default" ? `Default (${builtin.name})` : builtin.name,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-code",
  };
}

/** Convert a Claude Code catalog row into Pi's built-in Anthropic naming and pricing. */
export function modelFromDiscovery(info: DiscoveredClaudeModel): ClaudeCodeModel {
  const id = canonicalModelId(info);
  const builtinId = id === "default" ? withoutContextSuffix(info.resolvedModel || "") : id;
  const builtin = BUILTIN_ANTHROPIC_MODELS[builtinId];
  TRAITS_BY_ID.set(id, {
    route: info.value,
    nativeToolChanges: builtin?.compat?.supportsMidConvoToolChanges === true,
    adaptiveThinking: info.supportsAdaptiveThinking === true,
    // Pi marks models that reject `thinking.type: disabled` with `off: null`. Unknown
    // adaptive models are assumed to be newer and therefore unable to disable thinking.
    disabledThinking: builtin ? builtin.thinkingLevelMap?.off !== null : info.supportsAdaptiveThinking !== true,
  });
  return builtin ? fromBuiltin(info, id, builtin) : fallbackModel(info, id);
}

export const CLAUDE_CODE_MODELS: ClaudeCodeModel[] = FALLBACK_DISCOVERY.map(modelFromDiscovery);

export function nativeModel(model: string): string {
  const direct = TRAITS_BY_ID.get(model)?.route;
  if (direct) return direct;
  if (model === "default") return model;
  const canonical = canonicalRoute(model);
  return model.endsWith("[1m]") ? `${canonical}[1m]` : canonical;
}

function canonicalRoute(model: string): string {
  const withoutSuffix = withoutContextSuffix(model);
  return ALIASES[withoutSuffix] ?? withoutSuffix;
}

/** Traits recorded for this exact id, else for its canonical route. */
function knownTraits(model: string): ModelTraits | undefined {
  return TRAITS_BY_ID.get(model) ?? TRAITS_BY_ID.get(canonicalRoute(model));
}

/** Whether Claude Code reports adaptive thinking for this model. Unknown models are assumed to support it. */
export function supportsAdaptiveThinking(model: string): boolean {
  return knownTraits(model)?.adaptiveThinking ?? true;
}

/** Whether the API accepts `thinking: { type: "disabled" }` for this model. */
export function supportsDisabledThinking(model: string): boolean {
  const known = knownTraits(model)?.disabledThinking;
  if (known !== undefined) return known;
  const builtin = BUILTIN_ANTHROPIC_MODELS[canonicalRoute(model)];
  return builtin ? builtin.thinkingLevelMap?.off !== null : !supportsAdaptiveThinking(model);
}

/** Whether Anthropic currently accepts native mid-conversation tool blocks for this route. */
export function supportsNativeToolChanges(model: string): boolean {
  return (
    knownTraits(model)?.nativeToolChanges ??
    BUILTIN_ANTHROPIC_MODELS[canonicalRoute(model)]?.compat?.supportsMidConvoToolChanges === true
  );
}
