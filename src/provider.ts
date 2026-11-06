import { join } from "node:path";
import { createProvider, type AuthContext, type ProviderEnv } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverClaudeModels, getClaudeStatus, LOGIN_HINT, POWERSHELL_ENV } from "./claude-cli.ts";
import { API_ID, CLAUDE_CODE_MODELS, modelFromDiscovery, PROVIDER_ID } from "./model-catalog.ts";
import { ClaudeStatusCache } from "./status-cache.ts";
import { streamClaudeCode } from "./stream.ts";

const PROVIDER_ENV_NAMES = [
  "PI_CLAUDE_CODE_COMMAND",
  "PI_CLAUDE_CODE_CONFIG_DIR",
  "CLAUDE_CONFIG_DIR",
  POWERSHELL_ENV,
] as const;

async function providerEnvironment(ctx: AuthContext): Promise<ProviderEnv | undefined> {
  const env: ProviderEnv = {};
  await Promise.all(
    PROVIDER_ENV_NAMES.map(async (name) => {
      const value = await ctx.env(name);
      if (value !== undefined) env[name] = value;
    }),
  );
  return Object.keys(env).length ? env : undefined;
}

// Pi resolves provider-scoped settings (such as PI_CLAUDE_CODE_COMMAND) only
// through auth hooks. Remember the latest values so model discovery and the
// status command look at the same Claude Code installation as requests do.
let lastProviderEnv: ProviderEnv | undefined;

/** The environment used to locate and configure Claude Code. */
export function claudeCodeEnv(): Record<string, string | undefined> {
  return { ...process.env, ...lastProviderEnv };
}

/**
 * Login status for Pi's auth check. Startup uses the last saved logged-in
 * status instead of waiting for `claude auth status`; `revalidateClaudeStatus`
 * corrects it in the background.
 */
export const claudeStatusCache = new ClaudeStatusCache({
  path: join(getAgentDir(), "cache", "claude-code-status.json"),
  probe: (env) => getClaudeStatus(env),
});

/** Run a live status check. Resolves true when Pi was given an out-of-date status. */
export function revalidateClaudeStatus(): Promise<boolean> {
  return claudeStatusCache.revalidate(claudeCodeEnv());
}

export function createClaudeCodeProvider() {
  let discoveredIds: Set<string> | undefined;
  const externalOAuthMarker = () => ({
    type: "oauth" as const,
    access: "claude-code-external",
    refresh: "claude-code-external",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1_000,
  });
  return createProvider({
    id: PROVIDER_ID,
    name: "Claude Code Subscription (Experimental)",
    baseUrl: "process://claude-code",
    auth: {
      apiKey: {
        name: "Claude Code login",
        // Report the external Claude Code subscription as OAuth-shaped auth so
        // Pi can label list-price accounting as "(sub)". Requests still resolve
        // through this ambient method; credentials remain owned by Claude Code.
        async check({ ctx, signal }) {
          const providerEnv = await providerEnvironment(ctx);
          lastProviderEnv = providerEnv;
          const status = await claudeStatusCache.check(claudeCodeEnv(), signal);
          // Only report the provider as configured when Claude Code is
          // installed and logged in, so Pi hides its models otherwise.
          if (!status.available || !status.loggedIn) return undefined;
          return {
            type: status.subscription ? "oauth" : "api_key",
            source: status.subscription ? `Claude Code ${status.plan ?? "subscription"}` : "Claude Code CLI",
          };
        },
        async resolve({ ctx, signal }) {
          signal.throwIfAborted();
          const providerEnv = await providerEnvironment(ctx);
          lastProviderEnv = providerEnv;
          return {
            auth: { apiKey: "external-process" },
            env: providerEnv,
            source: "Claude Code CLI",
          };
        },
      },
      // Metadata marker for Pi's subscription-aware UI. This is deliberately
      // not the request auth path and never imports Claude Code credentials.
      // Login and logout are handled by the Claude Code CLI itself.
      oauth: {
        name: "Claude Code subscription (managed by Claude Code)",
        isSubscription: true,
        async login() {
          throw new Error(
            "Claude Code manages its own login. Run `claude auth login` in a terminal instead; " +
              "this provider uses it automatically.",
          );
        },
        async refresh(_credential, signal) {
          const status = await getClaudeStatus(claudeCodeEnv(), signal);
          if (!status.subscription) throw new Error(status.detail ?? LOGIN_HINT);
          return externalOAuthMarker();
        },
        async toAuth() {
          return { apiKey: "external-process" };
        },
      },
    },
    models: CLAUDE_CODE_MODELS,
    async fetchModels({ signal }) {
      const models = (await discoverClaudeModels(claudeCodeEnv(), signal)).map(modelFromDiscovery);
      discoveredIds = new Set(models.map((model) => model.id));
      return models;
    },
    filterModels(models) {
      const ids = discoveredIds;
      return ids ? models.filter((model) => ids.has(model.id)) : models;
    },
    api: {
      stream: streamClaudeCode,
      streamSimple: streamClaudeCode,
    },
  });
}

export { API_ID, PROVIDER_ID };
