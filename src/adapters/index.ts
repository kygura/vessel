import type { Adapter } from "../core/types.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { droidAdapter } from "./droid.ts";
import { loopAdapter } from "./loop/index.ts";
import { opencode } from "./opencode.ts";
import { piAdapter } from "./pi.ts";

export const ADAPTERS: Adapter[] = [claude, codex, opencode, piAdapter, droidAdapter, loopAdapter];
