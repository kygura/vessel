import { render } from "ink";
import { App } from "./App.tsx";

/** Entry point loaded by `vessel` / `vessel tui`; resolves when the user quits. */
export default async function main() {
  // Ctrl+C is handled by App (first press aborts a running session, second quits).
  const app = render(<App />, { exitOnCtrlC: false });
  await app.waitUntilExit();
}
