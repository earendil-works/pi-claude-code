import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClaudeStatus } from "../src/claude-cli.ts";
import { ClaudeStatusCache, statusKey } from "../src/status-cache.ts";

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
  await seed.flush();
}

test("shares one live check across concurrent startup checks and saves it", async (t) => {
  const path = await tempPath(t);
  const probe = countingProbe(LOGGED_IN);
  const cache = new ClaudeStatusCache({ path, probe });

  const results = await Promise.all(Array.from({ length: 8 }, () => cache.check(ENV)));
  assert.equal(probe.calls, 1);
  for (const status of results) assert.equal(status.loggedIn, true);

  await cache.flush();
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.entries[statusKey(ENV)].loggedIn, true);
  assert.equal(saved.entries[statusKey(ENV)].plan, "max");
  assert.equal("command" in saved.entries[statusKey(ENV)], false);
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

  await cache.flush();
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.entries[statusKey(ENV)].loggedIn, false);
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

test("honors an aborted signal", async (t) => {
  const path = await tempPath(t);
  const cache = new ClaudeStatusCache({ path, probe: countingProbe(LOGGED_IN) });
  await assert.rejects(cache.check(ENV, AbortSignal.abort()), { name: "AbortError" });
});
