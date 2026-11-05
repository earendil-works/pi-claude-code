import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureProcess, getClaudeStatus, INSTALL_HINT, LOGIN_HINT, runClaudeRequest } from "../src/claude-cli.ts";

const win32 = process.platform === "win32";
const skip = win32 ? false : "Windows-only launcher behavior";

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1]));

const STATUS_JSON = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });

/** Arguments that break naive cmd.exe or PowerShell quoting. */
const ARGUMENT_MATRIX: string[][] = [
  ["auth", "status"],
  ["has space"],
  ["a&b"],
  ["a|b"],
  ["a<b>c"],
  ["a^b"],
  ["(paren)"],
  ["semi;colon"],
  ["star*?"],
  ["trailing\\"],
  ['quote"inside'],
  ['backslash\\"quote'],
  [""],
  ["100%PATH%"],
  ["C:\\Program Files\\x y\\z.json"],
  [
    "--mcp-config",
    JSON.stringify({ mcpServers: { pi: { command: "C:\\Program Files\\node.exe", args: ["C:\\tmp dir\\server.mjs"] } } }),
  ],
];

/** Arguments that specifically stress argv reconstruction; used for the slower hosts. */
const SHORT_MATRIX = ARGUMENT_MATRIX.filter((_, index) => [1, 9, 10, 12, 13, 15].includes(index));

async function writeEchoScripts(root: string): Promise<{ cmd: string; ps1: string }> {
  const script = join(root, "echo args.cjs");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  const cmd = join(root, "claude shim.cmd");
  await writeFile(cmd, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  const ps1 = join(root, "claude shim.ps1");
  await writeFile(
    ps1,
    `[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @($args)))\r\n`,
    "utf8",
  );
  return { cmd, ps1 };
}

function received(stdout: string): string[] {
  const text = stdout.trim();
  assert.notEqual(text, "", "the shim printed no arguments");
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? (parsed as string[]) : [parsed as string];
}

async function assertArguments(
  executable: string,
  cases: string[][],
  extraEnv: Record<string, string> = {},
  leading: number = 0,
): Promise<void> {
  for (const args of cases) {
    const result = await captureProcess(executable, args, { ...env, ...extraEnv });
    assert.equal(result.code, 0, `${executable} failed: ${result.stderr}`);
    assert.deepEqual(
      received(result.stdout),
      args.slice(leading),
      `${executable} mangled ${JSON.stringify(args)}`,
    );
  }
}

test("launches a .cmd shim from a path with spaces and preserves every argument", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi claude code test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { cmd } = await writeEchoScripts(root);
  await assertArguments(cmd, ARGUMENT_MATRIX);
});

test("launches a .ps1 script through PowerShell and preserves every argument", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi claude code test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { ps1 } = await writeEchoScripts(root);

  // Default host resolution (PowerShell 7 when installed, else Windows PowerShell).
  await assertArguments(ps1, ARGUMENT_MATRIX);

  // An explicitly configured host wins and works for both installed hosts.
  for (const host of ["powershell.exe", "pwsh"]) {
    let available = true;
    try {
      await captureProcess(host, ["-NoLogo", "-NoProfile", "-Command", "exit 0"], env);
    } catch {
      available = false;
    }
    if (!available) continue;
    await assertArguments(ps1, SHORT_MATRIX, { PI_CLAUDE_CODE_POWERSHELL: host });
  }
});

test("reports Claude Code status through a .cmd shim", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi claude code test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const status = join(root, "claude status.cmd");
  await writeFile(status, `@ECHO off\r\necho ${STATUS_JSON}\r\n`, "utf8");

  const result = await getClaudeStatus({ ...env, PI_CLAUDE_CODE_COMMAND: status });
  assert.equal(result.available, true);
  assert.equal(result.loggedIn, true);
  assert.equal(result.subscription, true);
  assert.equal(result.plan, "max");
  assert.equal(result.command, status);
  assert.equal(result.diagnostic, undefined);
});

test("reports Claude Code status through a .ps1 script", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi claude code test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const status = join(root, "claude status.ps1");
  await writeFile(status, `[Console]::Out.WriteLine('${STATUS_JSON}')\r\n`, "utf8");

  const result = await getClaudeStatus({ ...env, PI_CLAUDE_CODE_COMMAND: status });
  assert.equal(result.loggedIn, true);
  assert.equal(result.subscription, true);
  assert.equal(result.command, status);
});

test("reports a failed status process as a diagnostic, not as a logout", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi claude code test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const crashing = join(root, "crashing.cmd");
  await writeFile(crashing, `@ECHO off\r\n>&2 echo boom\r\nexit /b 3\r\n`, "utf8");
  const crashStatus = await getClaudeStatus({ ...env, PI_CLAUDE_CODE_COMMAND: crashing });
  assert.equal(crashStatus.available, true);
  assert.equal(crashStatus.loggedIn, false);
  assert.equal(crashStatus.diagnostic, true);
  assert.match(crashStatus.detail ?? "", /exit 3/u);
  assert.match(crashStatus.detail ?? "", /boom/u);
  assert.notEqual(crashStatus.detail, LOGIN_HINT);

  // PowerShell must forward the script's exit code instead of collapsing it to 1.
  const crashingPs1 = join(root, "crashing.ps1");
  await writeFile(crashingPs1, `[Console]::Error.WriteLine('boom')\r\nexit 3\r\n`, "utf8");
  const ps1Status = await getClaudeStatus({ ...env, PI_CLAUDE_CODE_COMMAND: crashingPs1 });
  assert.equal(ps1Status.diagnostic, true);
  assert.match(ps1Status.detail ?? "", /exit 3/u);

  const garbage = join(root, "garbage.cmd");
  await writeFile(garbage, `@ECHO off\r\necho not-json-at-all\r\n`, "utf8");
  const garbageStatus = await getClaudeStatus({ ...env, PI_CLAUDE_CODE_COMMAND: garbage });
  assert.equal(garbageStatus.diagnostic, true);
  assert.match(garbageStatus.detail ?? "", /not-json-at-all/u);

  // A genuinely logged-out Claude Code is still reported as a login problem.
  const loggedOut = join(root, "logged-out.cmd");
  await writeFile(loggedOut, `@ECHO off\r\necho {"loggedIn":false}\r\nexit /b 1\r\n`, "utf8");
  const loggedOutStatus = await getClaudeStatus({ ...env, PI_CLAUDE_CODE_COMMAND: loggedOut });
  assert.equal(loggedOutStatus.loggedIn, false);
  assert.equal(loggedOutStatus.diagnostic, undefined);
  assert.equal(loggedOutStatus.detail, LOGIN_HINT);

  // A shell that cannot be spawned is a diagnostic as well.
  const spawnFailure = await getClaudeStatus({
    ...env,
    PI_CLAUDE_CODE_COMMAND: crashing,
    COMSPEC: join(root, "missing cmd.exe"),
  });
  assert.equal(spawnFailure.loggedIn, false);
  assert.equal(spawnFailure.diagnostic, true);
  assert.match(spawnFailure.detail ?? "", /status check failed/iu);

  // A command that does not exist is still an installation problem.
  const unspawnable = await getClaudeStatus({
    ...env,
    PI_CLAUDE_CODE_COMMAND: join(root, "missing.cmd"),
  });
  assert.equal(unspawnable.available, false);
  assert.equal(unspawnable.detail, INSTALL_HINT);
});

test("readiness errors surface the status diagnostic instead of a login hint", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi claude code test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const crashing = join(root, "broken status.cmd");
  await writeFile(crashing, `@ECHO off\r\n>&2 echo shim exploded\r\nexit /b 7\r\n`, "utf8");

  await assert.rejects(
    runClaudeRequest({
      model: "sonnet",
      frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }],
      systemPrompt: "system",
      manifest: [],
      extraBody: { tools: [] },
      env: { PI_CLAUDE_CODE_COMMAND: crashing },
      timeoutMs: 5_000,
    }),
    /exit 7[\s\S]*shim exploded/iu,
  );
});

test("spawns native executables directly without shell argument rewriting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi claude code test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "echo native args.cjs");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  await assertArguments(
    process.execPath,
    ARGUMENT_MATRIX.map((args) => [script, ...args]),
    undefined,
    1,
  );
});
