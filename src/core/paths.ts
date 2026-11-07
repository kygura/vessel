import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function routerHome(): string {
  return process.env.VESSEL_HOME || join(homedir(), ".vessel");
}

/** Resolves all storage paths under VESSEL_HOME (read at call time) and creates home + sessions dir. */
export function routerPaths() {
  const home = routerHome();
  const sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true });
  return {
    home,
    config: join(home, "config.json"),
    evidence: join(home, "evidence.json"),
    roster: join(home, "roster.json"),
    outcomes: join(home, "outcomes.jsonl"),
    sessions,
    sessionLog: (id: string) => join(sessions, `${id}.jsonl`),
  };
}
