export type JsonlLine = { json?: unknown; raw: string };
export type ProcExit = { exitCode: number | null; stderrTail: string };

const STDERR_TAIL = 2000;
const CAPTURE_MAX = 1_000_000;
const PIPE_GRACE_MS = 2000;

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const live = new Set<number>();
let handlersInstalled = false;

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // group already gone
  }
}

/** Process groups currently tracked for cleanup (exported for tests). */
export function liveGroups(): ReadonlySet<number> {
  return live;
}

/**
 * Children run detached in their own process group (so a kill reaches grandchildren), which also
 * means terminal Ctrl-C no longer reaches them. Live groups are therefore killed when we exit or get
 * SIGINT/SIGTERM. If we are the only listener for the signal, the default action is re-raised after.
 */
function track(pid: number): void {
  live.add(pid);
  if (handlersInstalled) return;
  handlersInstalled = true;
  const killAll = () => {
    for (const g of live) killGroup(g);
    live.clear();
  };
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const onSig = () => {
      killAll();
      if (process.listenerCount(sig) === 1) {
        process.removeListener(sig, onSig);
        process.kill(process.pid, sig);
      }
    };
    process.on(sig, onSig);
  }
}

/** After the leader exits and its pipes are drained (or the grace expired), kill leftovers and forget the group. */
function reap(pid: number, done: Promise<unknown>): void {
  done.finally(() => {
    killGroup(pid);
    live.delete(pid);
  });
}

/**
 * Yields decoded chunks until the stream ends. Once the leader has exited, a read that stays blocked
 * for the grace period ends the stream: a grandchild holding the pipe would otherwise hang us forever.
 * Data already buffered is still delivered however slowly the consumer reads.
 */
async function* chunks(stream: ReadableStream, exited: Promise<unknown>): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      let timer: Timer | undefined;
      const grace = exited.then(() => new Promise<null>((r) => (timer = setTimeout(() => r(null), PIPE_GRACE_MS))));
      const r = await Promise.race([reader.read(), grace]).finally(() => clearTimeout(timer));
      if (!r || r.done) return;
      yield r.value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Drains a stream keeping the first (`head`) or last (`tail`) `max` chars; the rest is discarded. */
async function collect(stream: ReadableStream, exited: Promise<unknown>, max: number, keep: "head" | "tail"): Promise<string> {
  let s = "";
  for await (const chunk of chunks(stream, exited)) {
    if (keep === "tail") s = (s + chunk).slice(-max);
    else if (s.length < max) s = (s + chunk).slice(0, max);
  }
  return s;
}

function spawnDetached(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }) {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  track(proc.pid);
  return proc;
}

/**
 * Spawns argv (own process group) and yields each non-empty stdout line, parsed as JSON when possible.
 * `exit` resolves after the process ends; `kill()` SIGKILLs the whole group and is safe any time.
 * Abort via `signal` does the same. Throws synchronously if the binary cannot be spawned.
 */
export function spawnJsonl(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal } = {},
): { lines: AsyncIterable<JsonlLine>; exit: Promise<ProcExit>; kill: () => void } {
  const proc = spawnDetached(argv, opts);
  const kill = () => killGroup(proc.pid);
  if (opts.signal?.aborted) kill();
  opts.signal?.addEventListener("abort", kill, { once: true });
  const stderr = collect(proc.stderr, proc.exited, STDERR_TAIL, "tail");
  const exit = Promise.all([proc.exited, stderr]).then(([code, err]) => {
    opts.signal?.removeEventListener("abort", kill);
    return { exitCode: proc.signalCode ? null : code, stderrTail: err };
  });
  reap(proc.pid, exit);

  async function* lines(): AsyncGenerator<JsonlLine> {
    let buf = "";
    for await (const chunk of chunks(proc.stdout, proc.exited)) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = toLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (line) yield line;
      }
    }
    const last = toLine(buf);
    if (last) yield last;
  }

  return { lines: lines(), exit, kill };
}

function toLine(s: string): JsonlLine | undefined {
  const raw = s.trim();
  if (!raw) return undefined;
  try {
    return { json: JSON.parse(raw), raw };
  } catch {
    return { raw };
  }
}

export type Capture = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

/**
 * Runs argv to completion. Never throws: spawn failure, timeout or abort yield exitCode null.
 * The child gets its own process group; on timeout/abort the whole group is SIGKILLed. A grandchild
 * still holding the pipes after exit gets the read grace, then is killed. stdout/stderr keep ~1MB each,
 * from the start (`keep: "head"`, default) or the end (`"tail"`, e.g. test failure summaries).
 */
export async function runCapture(
  argv: string[],
  timeoutMs: number,
  opts: { cwd?: string; signal?: AbortSignal; env?: Record<string, string | undefined>; keep?: "head" | "tail" } = {},
): Promise<Capture> {
  let proc: ReturnType<typeof spawnDetached>;
  try {
    proc = spawnDetached(argv, opts);
  } catch (e) {
    return { exitCode: null, stdout: "", stderr: errMsg(e), timedOut: false };
  }
  let timedOut = false;
  let killed = false;
  const kill = () => {
    killed = true;
    killGroup(proc.pid);
  };
  if (opts.signal?.aborted) kill();
  opts.signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const keep = opts.keep ?? "head";
  const reads = Promise.all([
    collect(proc.stdout, proc.exited, CAPTURE_MAX, keep),
    collect(proc.stderr, proc.exited, CAPTURE_MAX, keep),
  ]);
  reap(proc.pid, reads.catch(() => {}));
  const code = await proc.exited;
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", kill);
  const [stdout, stderr] = await reads.catch(() => ["", ""]);
  return { exitCode: killed || proc.signalCode !== null ? null : code, stdout, stderr, timedOut };
}
