import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeStatusKey, type ClaudeStatus } from "../src/claude-cli.ts";
import { ClaudeStatusCache } from "../src/status-cache.ts";

const LOGGED_IN: ClaudeStatus = { available: true, loggedIn: true, subscription: true, plan: "max", command: "claude" };
const LOGGED_OUT: ClaudeStatus = { available: true, loggedIn: false, subscription: false, command: "claude" };
const ENV = { HOME: "/home/test" };

async function tempPath(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "cache", "claude-code-status.json");
}

function countingProbe(...results: ClaudeStatus[]) {
  const probe = async () => {
    probe.calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return results[Math.min(probe.calls - 1, results.length - 1)]!;
  };
  probe.calls = 0;
  return probe;
}

async function saveStatus(path: string, status: ClaudeStatus): Promise<void> {
  const seed = new ClaudeStatusCache({ path, probe: async () => status });
  await seed.check(ENV);
}

test("shares one live check across concurrent startup checks and saves it", async (t) => {
  const path = await tempPath(t);
  const probe = countingProbe(LOGGED_IN);
  const cache = new ClaudeStatusCache({ path, probe });

  const results = await Promise.all(Array.from({ length: 8 }, () => cache.check(ENV)));
  assert.equal(probe.calls, 1);
  for (const status of results) assert.equal(status.loggedIn, true);

  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.entries[claudeStatusKey(ENV)].loggedIn, true);
  assert.equal(saved.entries[claudeStatusKey(ENV)].plan, "max");
  assert.equal("command" in saved.entries[claudeStatusKey(ENV)], false);
});

test("answers from a saved logged-in status without waiting for Claude Code", async (t) => {
  const path = await tempPath(t);
  await saveStatus(path, LOGGED_IN);

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const cache = new ClaudeStatusCache({
    path,
    probe: async () => {
      await blocked;
      return LOGGED_IN;
    },
  });

  const status = await cache.check(ENV);
  assert.equal(status.loggedIn, true);
  assert.equal(status.plan, "max");
  release();
});

test("does not trust a saved logged-out status", async (t) => {
  const path = await tempPath(t);
  await saveStatus(path, LOGGED_OUT);

  const probe = countingProbe(LOGGED_IN);
  const cache = new ClaudeStatusCache({ path, probe });
  assert.equal((await cache.check(ENV)).loggedIn, true);
  assert.equal(probe.calls, 1);
});

test("revalidate reports a stale answer and later checks use the live result", async (t) => {
  const path = await tempPath(t);
  await saveStatus(path, LOGGED_IN);

  const probe = countingProbe(LOGGED_OUT);
  const cache = new ClaudeStatusCache({ path, probe });
  assert.equal((await cache.check(ENV)).loggedIn, true);
  assert.equal(probe.calls, 0);

  assert.equal(await cache.revalidate(ENV), true);
  assert.equal((await cache.check(ENV)).loggedIn, false);
  assert.equal(await cache.revalidate(ENV), false);
  assert.equal(probe.calls, 1);

  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.entries[claudeStatusKey(ENV)].loggedIn, false);
});

test("revalidate reports no change when the saved status is still correct", async (t) => {
  const path = await tempPath(t);
  await saveStatus(path, LOGGED_IN);

  const cache = new ClaudeStatusCache({ path, probe: countingProbe(LOGGED_IN) });
  await cache.check(ENV);
  assert.equal(await cache.revalidate(ENV), false);
});

test("keeps separate statuses for separate Claude Code configs", async (t) => {
  const path = await tempPath(t);
  await saveStatus(path, LOGGED_IN);

  const probe = countingProbe(LOGGED_OUT);
  const cache = new ClaudeStatusCache({ path, probe });
  const other = { ...ENV, PI_CLAUDE_CODE_CONFIG_DIR: "/home/test/.claude-work" };
  assert.equal((await cache.check(ENV)).loggedIn, true);
  assert.equal((await cache.check(other)).loggedIn, false);
  assert.equal(probe.calls, 1);
});

test("retries the live check after a failure and ignores a corrupt file", async (t) => {
  const path = await tempPath(t);
  await saveStatus(path, LOGGED_OUT);
  await writeFile(path, "not json", "utf8");

  let calls = 0;
  const cache = new ClaudeStatusCache({
    path,
    probe: async () => {
      calls++;
      if (calls === 1) throw new Error("spawn failed");
      return LOGGED_IN;
    },
  });
  await assert.rejects(cache.check(ENV), /spawn failed/);
  assert.equal((await cache.check(ENV)).loggedIn, true);
  assert.equal(calls, 2);
});

test("honors an already aborted signal", async (t) => {
  const path = await tempPath(t);
  const cache = new ClaudeStatusCache({ path, probe: countingProbe(LOGGED_IN) });
  await assert.rejects(cache.check(ENV, AbortSignal.abort()), { name: "AbortError" });
});

test("an aborted check rejects without waiting for the live probe, which still saves", async (t) => {
  const path = await tempPath(t);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const cache = new ClaudeStatusCache({
    path,
    probe: async () => {
      await blocked;
      return LOGGED_IN;
    },
  });

  const controller = new AbortController();
  const aborted = cache.check(ENV, controller.signal);
  const other = cache.check(ENV);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });

  release();
  assert.equal((await other).loggedIn, true);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.entries[claudeStatusKey(ENV)].loggedIn, true);
});

test("saves before the check resolves and leaves no temporary file", async (t) => {
  const path = await tempPath(t);
  const cache = new ClaudeStatusCache({ path, probe: countingProbe(LOGGED_IN) });
  await cache.check(ENV);
  // Nothing is left pending, so Pi exiting right after the check cannot cut off the write.
  assert.deepEqual(await readdir(join(path, "..")), ["claude-code-status.json"]);
});

test("the key covers PATH and the PowerShell override like the request-path cache", () => {
  const base = claudeStatusKey(ENV);
  assert.notEqual(claudeStatusKey({ ...ENV, PATH: "/opt/claude/bin" }), base);
  assert.notEqual(claudeStatusKey({ ...ENV, PI_CLAUDE_CODE_POWERSHELL: "pwsh" }), base);
  assert.equal(
    claudeStatusKey({ ...ENV, PI_CLAUDE_CODE_CONFIG_DIR: "/home/test/.claude-work" }),
    claudeStatusKey({ ...ENV, CLAUDE_CONFIG_DIR: "/home/test/.claude-work" }),
  );
});
