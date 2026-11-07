import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Autonomy } from "../../core/types.ts";

export const BASH_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT = 10_000;

export type ToolContext = { cwd: string; signal?: AbortSignal; hiddenEnv?: string[] };
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
 * Bash is cwd-locked only, NOT a sandbox: commands can read/write anywhere the user can.
 * Provider API key env vars (hiddenEnv) are removed from its environment.
 */
async function runBash(command: string, ctx: ToolContext): Promise<ToolResult> {
  const env = { ...process.env };
  for (const k of ctx.hiddenEnv ?? []) delete env[k];
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd: realpathSync(ctx.cwd),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: BASH_TIMEOUT_MS,
    signal: ctx.signal,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const killed = proc.signalCode ? `\n[killed: ${proc.signalCode}${ctx.signal?.aborted ? "" : ", timeout"}]` : "";
  const body = truncate(`${out}${err ? `\n[stderr]\n${err}` : ""}`);
  return { output: `exit ${code}${killed}\n${body}`, isError: code !== 0 || killed !== "" };
}

/** Executes one tool call. Never throws: failures come back as isError results for the model. */
export async function runTool(name: string, input: unknown, autonomy: Autonomy, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (!toolsFor(autonomy).some((t) => t.name === name)) throw new ToolError(`tool not available: ${name}`);
    switch (name) {
      case "read_file": {
        const a = parse(ReadArgs, input);
        return { output: truncate(readFileSync(guardPath(ctx.cwd, a.path), "utf8"), 100_000), isError: false };
      }
      case "write_file": {
        const a = parse(WriteArgs, input);
        const p = guardPath(ctx.cwd, a.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, a.content);
        return { output: `wrote ${a.content.length} chars to ${a.path}`, isError: false };
      }
      case "edit_file": {
        const a = parse(EditArgs, input);
        const p = guardPath(ctx.cwd, a.path);
        const text = readFileSync(p, "utf8");
        const n = text.split(a.old_string).length - 1;
        if (n !== 1) throw new ToolError(`old_string must match exactly once, found ${n} matches`);
        writeFileSync(p, text.replace(a.old_string, () => a.new_string));
        return { output: `edited ${a.path}`, isError: false };
      }
      case "bash":
        return await runBash(parse(BashArgs, input).command, ctx);
    }
    throw new ToolError(`unknown tool: ${name}`);
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}
