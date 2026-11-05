import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverClaudeModels } from "../src/claude-cli.ts";

const PRIVACY_FLAGS = [
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_TELEMETRY",
  "DO_NOT_TRACK",
  "DISABLE_GROWTHBOOK",
] as const;

const SAFETY_FLAGS = [
  "DISABLE_AUTOUPDATER",
  "DISABLE_FEEDBACK_COMMAND",
  "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL",
  "DISABLE_ERROR_REPORTING",
] as const;

test("model discovery allows the served catalog while preserving explicit privacy choices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-discovery-"));
  const script = join(root, "fake-claude.mjs");
  const environmentLog = join(root, "environment.json");
  await writeFile(script, `#!/usr/bin/env node
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import readline from "node:readline";
const names = ${JSON.stringify([...PRIVACY_FLAGS, ...SAFETY_FLAGS])};
writeFileSync(process.env.ENVIRONMENT_LOG, JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name]]))));
const args = process.argv.slice(2);
assert.equal(args[args.indexOf("--setting-sources") + 1], "");
assert.equal(args[args.indexOf("--tools") + 1], "");
assert(args.includes("--no-session-persistence"));
let initialized = false;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    assert.equal(frame.request.subtype, "initialize");
    initialized = true;
    const privacy = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || process.env.DISABLE_TELEMETRY ||
      process.env.DISABLE_GROWTHBOOK || process.env.DO_NOT_TRACK === "1";
    const ids = privacy ? ["claude-opus-5-5"] : ["claude-opus-5-5", "claude-mythos-5-1"];
    console.log(JSON.stringify({type: "control_response", response: {
      subtype: "success", request_id: frame.request_id,
      response: {models: ids.map(id => ({value: id, resolvedModel: id, displayName: id, description: "Test model"}))}
    }}));
  } else {
    assert(initialized);
    assert.equal(frame.shouldQuery, false);
  }
}
`);
  // Windows cannot execute a shebang script directly; go through a .cmd shim.
  const executable = process.platform === "win32" ? join(root, "fake-claude.cmd") : script;
  if (executable !== script) {
    await writeFile(executable, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  }
  await chmod(executable, 0o755);
  const baseEnv: Record<string, string | undefined> = {
    ...Object.fromEntries(PRIVACY_FLAGS.map((name) => [name, undefined])),
    PI_CLAUDE_CODE_COMMAND: executable,
    ENVIRONMENT_LOG: environmentLog,
  };
  try {
    await t.test("discovers models beyond the built-in lineup without enabling updates or uploads", async () => {
      const models = await discoverClaudeModels(baseEnv);
      assert(models.some((model) => model.value === "claude-mythos-5-1"));
      const env = JSON.parse(await readFile(environmentLog, "utf8"));
      for (const name of PRIVACY_FLAGS) assert.equal(env[name], undefined, name);
      for (const name of SAFETY_FLAGS) assert.equal(env[name], "1", name);
    });

    for (const name of PRIVACY_FLAGS) {
      await t.test(`honors inherited ${name}`, async () => {
        const models = await discoverClaudeModels({ ...baseEnv, [name]: "1" });
        assert.equal(models.some((model) => model.value === "claude-mythos-5-1"), false);
        const env = JSON.parse(await readFile(environmentLog, "utf8"));
        assert.equal(env[name], "1");
        for (const safety of SAFETY_FLAGS) assert.equal(env[safety], "1", safety);
      });
    }

    await t.test("preserves non-empty privacy values verbatim, including zero", async () => {
      await discoverClaudeModels({ ...baseEnv, DISABLE_TELEMETRY: "0" });
      const env = JSON.parse(await readFile(environmentLog, "utf8"));
      assert.equal(env.DISABLE_TELEMETRY, "0");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
