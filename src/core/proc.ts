export type JsonlLine = { json?: unknown; raw: string };
export type ProcExit = { exitCode: number | null; stderrTail: string };

const STDERR_TAIL = 2000;

/**
 * Spawns argv and yields each non-empty stdout line, parsed as JSON when possible.
 * `exit` resolves after the process ends. Throws synchronously if the binary cannot be spawned.
 */
export function spawnJsonl(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal } = {},
): { lines: AsyncIterable<JsonlLine>; exit: Promise<ProcExit> } {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const exit = Promise.all([proc.exited, stderr]).then(([code, err]) => ({
    exitCode: proc.signalCode ? null : code,
    stderrTail: err.slice(-STDERR_TAIL),
  }));

  async function* lines(): AsyncGenerator<JsonlLine> {
    let buf = "";
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
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

  return { lines: lines(), exit };
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

export function which(bin: string): string | null {
  return Bun.which(bin);
}

/** Runs argv to completion for probes. Never throws: spawn failure or timeout yield exitCode null. */
export async function runCapture(
  argv: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const timedOut = proc.signalCode !== null;
    return { exitCode: timedOut ? null : code, stdout, stderr, timedOut };
  } catch (e) {
    return { exitCode: null, stdout: "", stderr: String(e), timedOut: false };
  }
}
