import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { killProcessTree } from "../src/claude-cli.ts";

const posix = process.platform !== "win32";

function exited(child: ReturnType<typeof spawn>): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

test("ends Claude Code with SIGTERM first, so it can remove its session files", { skip: !posix }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-kill-"));
  const marker = join(root, "session.json");
  // Stands in for Claude Code: registers a file and removes it on SIGTERM, as the real one does.
  const child = spawn(
    process.execPath,
    ["-e", `const fs=require("fs");fs.writeFileSync(${JSON.stringify(marker)},"");process.on("SIGTERM",()=>{fs.rmSync(${JSON.stringify(marker)});process.exit(143)});console.log("ready");setInterval(()=>{},1000)`],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await new Promise((resolve) => child.stdout!.once("data", resolve));
    const done = exited(child);
    killProcessTree(child);
    await done;
    assert.equal(child.exitCode, 143);
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kills a child that ignores SIGTERM after the grace period", { skip: !posix }, async () => {
  const child = spawn(
    process.execPath,
    ["-e", `process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)`],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((resolve) => child.stdout!.once("data", resolve));
  const started = Date.now();
  const done = exited(child);
  killProcessTree(child, 200);
  assert.equal(await done, "SIGKILL");
  assert.ok(Date.now() - started >= 150);
});
