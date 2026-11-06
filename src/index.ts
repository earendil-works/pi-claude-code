import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getClaudeStatus } from "./claude-cli.ts";
import { PROVIDER_ID } from "./model-catalog.ts";
import { claudeCodeEnv, createClaudeCodeProvider, revalidateClaudeStatus } from "./provider.ts";

export default function claudeCodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createClaudeCodeProvider());

  // Startup answered the auth check from the saved login status. Check for real
  // in the background and, if the status changed, have Pi check the provider
  // again so its models appear or disappear without a restart.
  pi.on("session_start", (_event, ctx) => {
    void revalidateClaudeStatus()
      .then((changed) =>
        changed ? ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], allowNetwork: false }) : undefined,
      )
      .catch(() => {});
  });

  pi.registerCommand("claude-code-status", {
    description: "Check the Claude Code executable and subscription login",
    handler: async (_args, ctx) => {
      const status = await getClaudeStatus(claudeCodeEnv(), ctx.signal);
      if (!status.available || !status.loggedIn) {
        ctx.ui.notify(status.detail ?? "Claude Code is not ready", "error");
        return;
      }
      const plan = status.plan ? ` (${status.plan})` : "";
      ctx.ui.notify(`Claude Code is installed and logged in${plan}`, "info");
    },
  });
}

export { createClaudeCodeProvider } from "./provider.ts";
export { streamClaudeCode } from "./stream.ts";
