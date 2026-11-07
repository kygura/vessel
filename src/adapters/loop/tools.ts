import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { errMsg, runCapture } from "../../core/proc.ts";
import type { Autonomy } from "../../core/types.ts";

export const BASH_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT = 10_000;

/** secrets: values redacted from all tool output (before truncation, so no partial key survives a cut). */
export type ToolContext = { cwd: string; signal?: AbortSignal; secrets?: string[] };

const BASH_ENV_ALLOW = ["PATH", "HOME", "LANG", "TERM", "TMPDIR", "USER", "SHELL"];
// 0 where unsupported (Windows): falls back to the realpath check alone.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
export type ToolResult = { output: string; isError: boolean };
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };

class ToolError extends Error {}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * Resolves `p` against cwd and rejects anything that ends up outside it: `..` traversal,
 * absolute paths elsewhere, and symlinks (including dangling ones) pointing out. For paths that
 * don't exist yet, the nearest existing ancestor is realpath'd. Check-then-use, so a concurrent
 * symlink swap (TOCTOU) is not defended against.
 */
export function guardPath(cwd: string, p: string): string {
  if (typeof p !== "string" || p === "" || p.includes("\0")) throw new ToolError("invalid path");
  const root = realpathSync(cwd);
  const target = resolve(root, p);
  if (!inside(root, target)) throw new ToolError(`path escapes working directory: ${p}`);
  let probe = target;
  for (;;) {
    let exists = true;
    try {
      lstatSync(probe);
    } catch {
      exists = false;
    }
    if (exists) {
      let real: string;
      try {
        real = realpathSync(probe); // throws on dangling symlink
      } catch {
        throw new ToolError(`unresolvable path (dangling symlink?): ${p}`);
      }
      if (!inside(root, real)) throw new ToolError(`path escapes working directory via symlink: ${p}`);
      return probe === target ? real : resolve(real, relative(probe, target));
    }
    const parent = dirname(probe);
    if (parent === probe) throw new ToolError(`path escapes working directory: ${p}`);
    probe = parent;
  }
}

/** Denies writes into any `.git` directory (hooks/config there would run code on the next git command). */
function guardWrite(cwd: string, p: string): string {
  const real = guardPath(cwd, p);
  if (relative(realpathSync(cwd), real).split(sep).some((seg) => seg.toLowerCase() === ".git"))
    throw new ToolError(`writes under .git/ are denied: ${p}`);
  return real;
}

/** O_NOFOLLOW on the final component closes the swap-to-symlink window after guardPath for that component. */
function readNoFollow(p: string): string {
  const fd = openSync(p, constants.O_RDONLY | O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function writeNoFollow(p: string, data: string): void {
  const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW, 0o666);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

const ReadArgs = z.object({ path: z.string() });
const WriteArgs = z.object({ path: z.string(), content: z.string() });
const EditArgs = z.object({ path: z.string(), old_string: z.string().min(1), new_string: z.string() });
const BashArgs = z.object({ command: z.string().min(1) });

const DEFS: Record<string, ToolDef> = {
  read_file: {
    name: "read_file",
    description: "Read a UTF-8 text file. Path is relative to the working directory.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  write_file: {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Creates parent directories.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  edit_file: {
    name: "edit_file",
    description: "Replace old_string with new_string in a file. old_string must occur exactly once.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
    },
  },
  bash: {
    name: "bash",
    description: "Run a bash command in the working directory (120s timeout, output truncated to 10KB).",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

/** `read` autonomy exposes read_file only; `edit`/`full` expose all four (matches pi/claude edit level). */
export function toolsFor(autonomy: Autonomy): ToolDef[] {
  const names = autonomy === "read" ? ["read_file"] : ["read_file", "write_file", "edit_file", "bash"];
  return names.map((n) => DEFS[n]!);
}

function truncate(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ToolError(`invalid arguments: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
}

/**
 * Bash is cwd-locked only, NOT a sandbox: commands run with the user's privileges and can read/write
 * anywhere the user can. The env is an allowlist so API keys aren't inherited, but the parent's
 * /proc/$PPID/environ is still readable by the same uid. SPEC "Autonomy" accepts this for `edit`.
 */
async function runBash(command: string, ctx: ToolContext): Promise<ToolResult> {
  const env: Record<string, string> = {};
  for (const k of BASH_ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  const r = await runCapture(["bash", "-c", command], BASH_TIMEOUT_MS, { cwd: realpathSync(ctx.cwd), env, signal: ctx.signal });
  const status = r.timedOut ? "killed: timeout" : r.exitCode === null ? (ctx.signal?.aborted ? "killed: aborted" : "failed to run") : `exit ${r.exitCode}`;
  const body = truncate(redact(`${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`, ctx.secrets ?? []));
  return { output: `${status}\n${body}`, isError: r.exitCode !== 0 };
}

/** Executes one tool call. Never throws: failures come back as isError results for the model. */
export async function runTool(name: string, input: unknown, autonomy: Autonomy, ctx: ToolContext): Promise<ToolResult> {
  const r = await runToolRaw(name, input, autonomy, ctx);
  return { ...r, output: redact(r.output, ctx.secrets ?? []) };
}

async function runToolRaw(name: string, input: unknown, autonomy: Autonomy, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (!toolsFor(autonomy).some((t) => t.name === name)) throw new ToolError(`tool not available: ${name}`);
    switch (name) {
      case "read_file": {
        const a = parse(ReadArgs, input);
        return { output: truncate(redact(readNoFollow(guardPath(ctx.cwd, a.path)), ctx.secrets ?? []), 100_000), isError: false };
      }
      case "write_file": {
        const a = parse(WriteArgs, input);
        const p = guardWrite(ctx.cwd, a.path);
        mkdirSync(dirname(p), { recursive: true });
        writeNoFollow(p, a.content);
        return { output: `wrote ${a.content.length} chars to ${a.path}`, isError: false };
      }
      case "edit_file": {
        const a = parse(EditArgs, input);
        const p = guardWrite(ctx.cwd, a.path);
        const text = readNoFollow(p);
        const n = text.split(a.old_string).length - 1;
        if (n !== 1) throw new ToolError(`old_string must match exactly once, found ${n} matches`);
        writeNoFollow(p, text.replace(a.old_string, () => a.new_string));
        return { output: `edited ${a.path}`, isError: false };
      }
      case "bash":
        return await runBash(parse(BashArgs, input).command, ctx);
    }
    throw new ToolError(`unknown tool: ${name}`);
  } catch (e) {
    return { output: errMsg(e), isError: true };
  }
}

/** Replaces every occurrence of each secret (empty strings ignored) with [redacted]. */
export function redact(s: string, secrets: string[]): string {
  for (const k of secrets) if (k) s = s.split(k).join("[redacted]");
  return s;
}
