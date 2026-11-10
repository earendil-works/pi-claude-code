import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureProcess, getClaudeStatus, LOGIN_HINT, runClaudeRequest } from "../src/claude-cli.ts";
import { createClaudeCodeProvider } from "../src/provider.ts";

async function withFakeClaude(script: string, run: (command: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-auth-"));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(executable, `#!${process.execPath}\n${script}\n`);
  await chmod(executable, 0o755);
  try {
    await run(executable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const env = (command: string) => ({ PATH: process.env.PATH, HOME: process.env.HOME, PI_CLAUDE_CODE_COMMAND: command });
const missingFieldDetail =
  "Claude Code status check failed (exit 0): unexpected auth status output (no boolean loggedIn field)";

for (const value of [undefined, "false", 0, null, {}]) {
  test(`auth status treats loggedIn=${JSON.stringify(value)} as a failed check, not a logout`, async () => {
    const payload = { loggedIn: value, email: "user@example.com", orgId: "private-org" };
    await withFakeClaude(`console.log(${JSON.stringify(JSON.stringify(payload))});`, async (command) => {
      const status = await getClaudeStatus(env(command));
      assert.equal(status.available, true);
      assert.equal(status.loggedIn, false);
      assert.equal(status.subscription, false);
      assert.equal(status.diagnostic, true);
      assert.equal(status.detail, missingFieldDetail);
    });
  });
}

for (const loggedIn of [false, true]) {
  test(`auth status preserves boolean loggedIn=${loggedIn}, including nonzero logout exits`, async () => {
    const payload = { loggedIn, authMethod: "claude.ai", subscriptionType: "max" };
    await withFakeClaude(
      `console.log(${JSON.stringify(JSON.stringify(payload))}); process.exit(${loggedIn ? 0 : 1});`,
      async (command) => {
        const status = await getClaudeStatus(env(command));
        assert.equal(status.loggedIn, loggedIn);
        assert.equal(status.subscription, loggedIn);
        assert.equal(status.diagnostic, undefined);
        assert.equal(status.detail, loggedIn ? undefined : LOGIN_HINT);
      },
    );
  });
}

test("auth status still accepts leading CLI noise before a boolean login payload", async () => {
  await withFakeClaude('console.log(\'notice\\n{"loggedIn":true,"subscriptionType":"max"}\');', async (command) => {
    const status = await getClaudeStatus(env(command));
    assert.equal(status.loggedIn, true);
    assert.equal(status.diagnostic, undefined);
  });
});

test("auth status reports its configured timeout, not the termination signal", async () => {
  await withFakeClaude("setTimeout(() => {}, 10000);", async (command) => {
    const status = await getClaudeStatus(env(command), undefined, 150);
    assert.equal(status.diagnostic, true);
    assert.equal(status.detail, "Claude Code status check failed: timed out after 150ms");
  });
});

test("captureProcess reports timeout independently of auth status", async () => {
  await assert.rejects(
    captureProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {}, undefined, 150),
    /^Error: timed out after 150ms$/,
  );
});

test("aborting auth status preserves the abort reason instead of reporting a timeout", async () => {
  await withFakeClaude("setTimeout(() => {}, 10000);", async (command) => {
    const controller = new AbortController();
    const reason = new Error("cancel status check");
    const timer = setTimeout(() => controller.abort(reason), 100);
    try {
      await assert.rejects(getClaudeStatus(env(command), controller.signal, 5000), (error) => error === reason);
    } finally {
      clearTimeout(timer);
    }
  });
});

test("request readiness surfaces a missing loggedIn diagnostic, not a login hint", async () => {
  await withFakeClaude('console.log("{}");', async (command) => {
    await assert.rejects(
      runClaudeRequest({
        model: "sonnet",
        frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }],
        systemPrompt: "",
        manifest: [],
        extraBody: {},
        env: env(command),
      }),
      (error: Error) => error.message === missingFieldDetail,
    );
  });
});

test("oauth refresh surfaces a missing loggedIn diagnostic, not a login hint", async () => {
  await withFakeClaude('console.log("{}");', async (command) => {
    const provider = createClaudeCodeProvider();
    const signal = new AbortController().signal;
    const check = await provider.auth.apiKey?.check?.({
      ctx: {
        env: async (name) => (name === "PI_CLAUDE_CODE_COMMAND" ? command : undefined),
        fileExists: async () => false,
      },
      signal,
    });
    assert.equal(check, undefined);
    await assert.rejects(
      provider.auth.oauth!.refresh!({} as never, signal),
      (error: Error) => error.message === missingFieldDetail,
    );
  });
});
