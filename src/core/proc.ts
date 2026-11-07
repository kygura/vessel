export type JsonlLine = { json?: unknown; raw: string };
export type ProcExit = { exitCode: number | null; stderrTail: string };

const STDERR_TAIL = 2000;
const CAPTURE_MAX = 1_000_000;
const PIPE_GRACE_MS = 2000;

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Yields decoded chunks until the stream ends, or until `exited` resolves plus a grace period:
 * a grandchild that inherited the pipe would otherwise keep it open (and us waiting) forever.
 */
async function* chunks(stream: ReadableStream, exited: Promise<unknown>): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  const gone = exited.then(() => Bun.sleep(PIPE_GRACE_MS)).then(() => null);
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), gone]);
      if (!r || r.done) return;
      yield r.value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Drains a stream keeping only the last `max` chars (bounded memory for chatty stderr). */
async function tail(stream: ReadableStream, exited: Promise<unknown>, max: number): Promise<string> {
  let s = "";
  for await (const chunk of chunks(stream, exited)) s = (s + chunk).slice(-max);
  return s;
}

/**
 * Drains a stream keeping the first `max` chars (rest read and discarded so the child never blocks).
 * Reports progress through `set`, so a caller that stops waiting still has what arrived.
 */
async function head(stream: ReadableStream, max: number, set: (s: string) => void): Promise<void> {
  let s = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    if (s.length >= max) continue;
    s += chunk;
    set(s.length > max ? `${s.slice(0, max)}\n...[truncated]` : s);
  }
}

/**
 * Spawns argv and yields each non-empty stdout line, parsed as JSON when possible.
 * `exit` resolves after the process ends; `kill()` is safe to call any time (no-op once exited).
 * Throws synchronously if the binary cannot be spawned.
 */
export function spawnJsonl(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal } = {},
): { lines: AsyncIterable<JsonlLine>; exit: Promise<ProcExit>; kill: () => void } {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = tail(proc.stderr, proc.exited, STDERR_TAIL);
  const exit = Promise.all([proc.exited, stderr]).then(([code, err]) => ({
    exitCode: proc.signalCode ? null : code,
    stderrTail: err,
  }));

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

  return { lines: lines(), exit, kill: () => proc.kill("SIGKILL") };
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
 * The child gets its own process group; on timeout/abort the whole group is SIGKILLed. Output reads
 * get a short grace after exit so a grandchild still holding the pipes cannot hang the caller.
 * stdout/stderr are capped at ~1MB each.
 */
export async function runCapture(
  argv: string[],
  timeoutMs: number,
  opts: { cwd?: string; signal?: AbortSignal; env?: Record<string, string | undefined> } = {},
): Promise<Capture> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { exitCode: null, stdout: "", stderr: errMsg(e), timedOut: false };
  }
  let timedOut = false;
  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL"); // group already gone or unsupported platform
    }
  };
  const onAbort = () => killGroup();
  if (opts.signal?.aborted) killGroup();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);

  const out = { stdout: "", stderr: "" };
  const reads = Promise.all([
    head(proc.stdout, CAPTURE_MAX, (s) => (out.stdout = s)),
    head(proc.stderr, CAPTURE_MAX, (s) => (out.stderr = s)),
  ]).then(
    () => true,
    () => true,
  );
  try {
    const code = await proc.exited;
    const drained = await Promise.race([reads, Bun.sleep(PIPE_GRACE_MS).then(() => false)]);
    if (!drained) killGroup(); // leftover grandchildren still hold the pipes
    const killed = proc.signalCode !== null || timedOut || !!opts.signal?.aborted;
    return { exitCode: killed ? null : code, ...out, timedOut };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
