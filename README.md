# lex

A minimal, open-source AI coding harness you can read in an afternoon.
Model, tools, memory, loop. Bring your own key: no OAuth, no account, your credits.

> Work in progress. Phases 0–2 of [`plan.md`](plan.md) are done (one-shot + interactive REPL). `compare` (Phase 3A) is next.

## Try it

```bash
bun install
export AI_GATEWAY_API_KEY=...        # recommended: one key, every model
# or ANTHROPIC_API_KEY / OPENAI_API_KEY, or: bun src/cli.ts login
bun src/cli.ts                        # interactive session
bun src/cli.ts "list the files here and summarize"   # one-shot
bun src/cli.ts --model gateway:openai/gpt-6.2-sol "fix the failing test"
bun src/cli.ts models                 # models your keys can reach
```

Flags: `--model`, `--yolo`, `--readonly`, `--cwd`, `--max-steps`, `--version`, `--help`.

In the REPL: `/model [spec|n]` switches models mid-conversation (history is kept), plus `/clear`, `/memory`, `/todo`, `/usage`, `/yolo`, `/readonly`, `/login`, `/help`, `/exit`. Ctrl-C cancels a running turn (including at an approval prompt); Ctrl-D exits.

## Providers

Bring your own key for any of these (set the env var, or run `lex login`). `lex --help` prints the full list.

| Provider | Key | | Provider | Key |
|---|---|---|---|---|
| `gateway` (recommended) | `AI_GATEWAY_API_KEY` | | `groq` | `GROQ_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` | | `cerebras` | `CEREBRAS_API_KEY` |
| `openai` | `OPENAI_API_KEY` | | `together` | `TOGETHER_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` | | `fireworks` | `FIREWORKS_API_KEY` |
| `google` | `GEMINI_API_KEY` | | `moonshot` | `MOONSHOT_API_KEY` |
| `xai` | `XAI_API_KEY` | | `zai` | `ZAI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` | | `minimax` | `MINIMAX_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` | | `nvidia` | `NVIDIA_API_KEY` |
| `ollama`, `lmstudio` (local) | none | | `huggingface` | `HF_TOKEN` |

Model specs: `provider:model` (`groq:openai/gpt-oss-120b`, `ollama:qwen3:8b`), a provider name for its default (`--model deepseek`), or a bare id (`claude-opus-5-5`, `gemini-4-neon`, `grok-4.7`, `zai/glm-5.3`). Bare ids go to the direct provider if you have its key, otherwise through the gateway. Override any base URL with `<PROVIDER>_BASE_URL` (e.g. `OLLAMA_BASE_URL`).

Add any OpenAI-compatible endpoint (vLLM, LiteLLM, a company proxy) in `~/.lex/config.json`:

```json
{ "providers": { "vllm": { "baseURL": "http://localhost:8000/v1", "apiKeyEnv": "VLLM_API_KEY", "models": ["qwen3"] } } }
```

## Develop

```bash
bun test          # unit tests
bun check         # type check
bun run build     # bundle to dist/cli.js for Node 22+
node dist/cli.js --help
```

## Layout

```
src/
  cli.ts       args, subcommands, one-shot mode
  agent.ts     ToolLoopAgent + streaming turn runner (the whole loop)
  providers.ts provider registry: one row per provider (19 built in + custom)
  models.ts    model spec parsing, resolution, live model catalogs
  auth.ts      BYO keys: env first, then ~/.lex/auth.json (0600); config.json
  prompt.ts    system prompt builder (pure)
  context.ts   AGENTS.md / CLAUDE.md discovery, git branch, memory
  approval.ts  ask | yolo | readonly, operator-aware safe-command list
  io.ts        the single shared readline, prompts, spinner
  render.ts    stream chunks to the terminal, footer
  session.ts   one conversation: model, tools, history (shared by one-shot and REPL)
  repl.ts      interactive loop, banner, slash commands
  compare.ts   same task on N models (Phase 3A)
  types.ts     contracts shared between modules
  tools/       read ls grep write edit bash todo ask remember, index.ts
  util/        paths (path guard), fs, truncate, serialize
test/          bun test suites
```

## Safety

No sandbox. File tools are confined to the project directory (symlinks included). `bash`, `write` and `edit` ask before running. Use `--readonly` to only observe and `--yolo` to allow everything.

MIT licensed.
