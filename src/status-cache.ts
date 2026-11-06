import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ClaudeStatus } from "./claude-cli.ts";

/** The part of a status check that decides whether Pi shows the provider. */
export type StoredStatus = Pick<ClaudeStatus, "available" | "loggedIn" | "subscription" | "plan">;

type Env = Record<string, string | undefined>;

interface StatusFile {
  version: 1;
  entries: Record<string, StoredStatus & { checkedAt: number }>;
}

export interface StatusCacheOptions {
  /** JSON file that keeps the last status between Pi runs, resolved on each use. */
  path: string | (() => string);
  /** Runs the real check, normally `getClaudeStatus`. */
  probe: (env: Env) => Promise<ClaudeStatus>;
  /** How long one live check is shared by later calls in this process. */
  liveTtlMs?: number;
}

/** Statuses for different Claude Code installations or accounts are stored separately. */
export function statusKey(env: Env): string {
  return JSON.stringify([
    env.PI_CLAUDE_CODE_COMMAND ?? "",
    env.PI_CLAUDE_CODE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? "",
    env.HOME ?? env.USERPROFILE ?? "",
  ]);
}

function stored(status: StoredStatus): StoredStatus {
  return {
    available: status.available,
    loggedIn: status.loggedIn,
    subscription: status.subscription,
    ...(status.plan === undefined ? {} : { plan: status.plan }),
  };
}

function sameStatus(a: StoredStatus, b: StoredStatus): boolean {
  return a.available === b.available && a.loggedIn === b.loggedIn && a.subscription === b.subscription && a.plan === b.plan;
}

/**
 * Stale-while-revalidate cache for `claude auth status`.
 *
 * Pi awaits every provider's auth check before startup finishes and runs that
 * check several times while starting, and each `claude auth status` takes
 * 100-200 ms. `check()` answers from the last saved logged-in status, so
 * startup does not wait for Claude Code. `revalidate()` then runs the real
 * check and reports whether Pi was told something out of date. A status that
 * was not logged in is never trusted from disk: a fresh login shows up on the
 * next start without waiting for a background check.
 */
export class ClaudeStatusCache {
  private readonly resolvePath: () => string;
  private readonly probe: (env: Env) => Promise<ClaudeStatus>;
  private readonly liveTtlMs: number;
  private readonly live = new Map<string, { promise: Promise<StoredStatus>; expires: number }>();
  /** Results of live checks in this process, which win over the saved file. */
  private readonly fresh = new Map<string, StoredStatus>();
  /** What `check()` last returned per key, to detect stale answers. */
  private readonly served = new Map<string, StoredStatus>();
  private writes: Promise<void> = Promise.resolve();

  constructor(options: StatusCacheOptions) {
    const { path } = options;
    this.resolvePath = typeof path === "string" ? () => path : path;
    this.probe = options.probe;
    this.liveTtlMs = options.liveTtlMs ?? 30_000;
  }

  /** Status for Pi's auth check: in-process result, else saved logged-in result, else a live check. */
  async check(env: Env, signal?: AbortSignal): Promise<StoredStatus> {
    signal?.throwIfAborted();
    const key = statusKey(env);
    const known = this.fresh.get(key) ?? (await this.readSaved(key));
    const status = known?.loggedIn ? known : await this.liveStatus(env, key);
    signal?.throwIfAborted();
    this.served.set(key, status);
    return status;
  }

  /**
   * Run a live check now. Resolves true when it differs from the last status
   * `check()` returned, meaning Pi should check the provider again.
   */
  async revalidate(env: Env): Promise<boolean> {
    const key = statusKey(env);
    const status = await this.liveStatus(env, key);
    const served = this.served.get(key);
    return served !== undefined && !sameStatus(served, status);
  }

  /** Wait for pending writes to the saved file. */
  flush(): Promise<void> {
    return this.writes;
  }

  private liveStatus(env: Env, key: string): Promise<StoredStatus> {
    const cached = this.live.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = this.probe(env).then((result) => {
      const status = stored(result);
      this.fresh.set(key, status);
      this.save(key, status);
      return status;
    });
    // Share one probe across the burst of startup checks. Retry at once after a failure.
    this.live.set(key, { promise, expires: Number.POSITIVE_INFINITY });
    promise.then(
      () => {
        const entry = this.live.get(key);
        if (entry?.promise === promise) entry.expires = Date.now() + this.liveTtlMs;
      },
      () => {
        if (this.live.get(key)?.promise === promise) this.live.delete(key);
      },
    );
    return promise;
  }

  private async readFile(): Promise<StatusFile | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.resolvePath(), "utf8")) as Partial<StatusFile>;
      return parsed.version === 1 && parsed.entries && typeof parsed.entries === "object"
        ? (parsed as StatusFile)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async readSaved(key: string): Promise<StoredStatus | undefined> {
    const entry = (await this.readFile())?.entries[key];
    return entry && typeof entry.loggedIn === "boolean" ? stored(entry) : undefined;
  }

  private save(key: string, status: StoredStatus): void {
    this.writes = this.writes.then(async () => {
      try {
        const file = (await this.readFile()) ?? { version: 1, entries: {} };
        file.entries[key] = { ...status, checkedAt: Date.now() };
        const path = this.resolvePath();
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
      } catch {
        // The cache only speeds up startup; a failed write means the next start checks live.
      }
    });
  }
}
