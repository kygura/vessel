# Headless CLI contracts

Captured 2026-11-07 from live `--help` (claude 2.1.319, pi 1.0.0, droid 0.143.1) and source checkouts in `/home/nca/projects/agents/{claude-code,codex,opencode,pi}`. Event shapes come from source/docs, not captured output — adapters must tolerate unknown event types and missing fields.

## Summary

| | claude | codex | opencode | pi | droid |
|---|---|---|---|---|---|
| headless argv | `claude -p "<p>"` | `codex exec "<p>"` | `opencode run "<p>"` | `pi -p "<p>"` | `droid exec "<p>"` |
| JSON mode | `--output-format stream-json --verbose` | `--json` | `--format json` | `--mode json` | `-o stream-json` |
| model flag | `--model` (alias or full id) | `-m` | `-m provider/model#variant` | `--model [provider/]id[:thinking]` | `-m <id>` |
| effort flag | `--effort low\|medium\|high\|xhigh\|max` | `-c model_reasoning_effort="high"` | `#variant` suffix on model | `--thinking off..max` | `-r <level>` |
| resume | `-r <id>` | `codex exec resume <id> "<p>"` | `-s <id>` | `--session <id>` | `-s <id>` |
| cwd | spawn cwd | `-C DIR` (+ `--skip-git-repo-check` outside git) | spawn cwd + set `PWD` env | spawn cwd | `--cwd PATH` |
| list models | none | `codex debug models` | `opencode models` (`provider/id` lines) | `pi --list-models` (text table) | list at end of `droid exec --help` |
| auth check | `claude auth status` (JSON `loggedIn`) | `codex login status` (exit 0) | `opencode auth list --format json` (empty = none) | `pi auth check --provider X --json` (exit 0/1/2) | unknown; `FACTORY_API_KEY` env |
| session id | `session_id` on every event | `thread.started.thread_id` | `sessionID` on every event | first line `{"type":"session","id"}` | `session_id` on `init`/`completion` |
| cost | `result.total_cost_usd` | tokens only | `step_finish.part.cost` | `message_end.message.usage.cost.total` | tokens only |
| done signal | `{"type":"result"}` | `turn.completed` / `turn.failed` | process exit (1 = error) | `agent_settled` | `completion` |

## Autonomy flags (router `edit` level = default; `full` = explicit opt-in only)

| CLI | read-only | edit (default) | full (opt-in, bypass) |
|---|---|---|---|
| claude | `--permission-mode plan` | `--permission-mode acceptEdits --allowedTools "Read Edit Write Bash Glob Grep"` | `--dangerously-skip-permissions` |
| codex | `-s read-only` | `-s workspace-write` (headless approval is already `never`) | `--dangerously-bypass-approvals-and-sandbox` |
| opencode | (no `--auto`: permission requests auto-rejected) | `--auto` | `--dangerously-skip-permissions` |
| pi | `--tools read,grep,find,ls` | `--tools read,edit,write,bash,grep,find,ls` (no sandbox exists) | same as edit |
| droid | default | `--auto medium` | `--skip-permissions-unsafe` |

## Event examples

claude:
- `{"type":"system","subtype":"init","session_id":"..","cwd":"..","model":".."}`
- `{"type":"assistant","message":{"content":[{"type":"text","text":".."},{"type":"tool_use","name":"Bash","input":{..}}]},"session_id":".."}`
- `{"type":"result","subtype":"success","is_error":false,"result":"..","total_cost_usd":0.01,"usage":{..},"num_turns":1,"session_id":".."}` (error subtypes: `error_during_execution`, `error_max_turns`, `error_max_budget_usd`)

codex:
- `{"type":"thread.started","thread_id":".."}`
- `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":".."}}`
- `{"type":"item.started","item":{"type":"command_execution","command":"ls","status":"in_progress"}}` (other item types: `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `reasoning`, `error`)
- `{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}`, `{"type":"turn.failed","error":{"message":".."}}`
- Final answer = last `agent_message`.

opencode (every line has `type`, `timestamp`, `sessionID`):
- `{"type":"text","sessionID":"ses_..","part":{"type":"text","text":".."}}`
- `{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{..},"output":".."}}}`
- `{"type":"step_finish","part":{"reason":"stop","cost":0.01,"tokens":{..}}}`
- `{"type":"error","error":{"type":"unknown","message":".."}}`

pi (strict JSONL):
- `{"type":"session","version":3,"id":"uuid","cwd":"/path"}`
- `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hi"}}`
- `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":".."}],"model":"..","usage":{"input":1,"output":1,"cost":{"total":0}},"stopReason":"stop"}}`
- `{"type":"tool_execution_start","toolCallId":"..","toolName":"bash","args":{..}}` / `tool_execution_end` (`result`, `isError`)
- `{"type":"agent_settled","aborted":false}` = done. Errors: `stopReason:"error"` + `errorMessage`.

droid (field names inferred from binary strings — unverified):
- `{"type":"system","subtype":"init","session_id":"..","model":".."}`
- `{"type":"message","role":"assistant","text":"..","session_id":".."}`
- `{"type":"tool_call","toolName":".."}`, `{"type":"tool_result","isError":false,"content":".."}`
- `{"type":"completion","finalText":"..","numTurns":1,"durationMs":1,"session_id":"..","usage":{..}}`
- `{"type":"error","error":..}`

## Custom OpenAI-compatible providers

- opencode: `~/.config/opencode/opencode.json` → `{"provider":{"myid":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://.../v1"},"models":{"<id>":{}}}}}`, use `-m myid/<id>`.
- pi: `~/.pi/agent/models.json` → `{"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1","api":"openai-completions","apiKey":"ollama","models":[{"id":"qwen2.5-coder:7b"}]}}}`, use `--model ollama/qwen2.5-coder:7b`.
