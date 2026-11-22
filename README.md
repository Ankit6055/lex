# lex

A minimal, open-source AI coding harness for your terminal. It's about 3k lines of TypeScript you can read in an afternoon.
Model, tools, memory, loop. Bring your own key: no OAuth, no account, your credits. 19 providers built in.

## Try it (60 seconds)

```bash
export AI_GATEWAY_API_KEY=...       # recommended: one key, hundreds of models
# or ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ... (see Providers), or: npx @ankit6055/lex login
cd your-project
npx @ankit6055/lex                  # interactive session
npx @ankit6055/lex "fix the failing test"   # one-shot: run, print, exit
```

Install it globally (`npm i -g @ankit6055/lex`) and the command is just `lex`. Requires Node 22+.

## Swap the model

```bash
lex --model gateway:openai/gpt-6.2-sol
lex --model anthropic:claude-opus-5-5
lex --model groq:openai/gpt-oss-120b
lex --model ollama:qwen3:8b          # local, no key
lex models                           # every model your keys can reach
```

Inside a session, `/model gemini-4-neon` switches mid-conversation and the history is kept, so a model from another lab picks up where the last one stopped. `/model` alone shows a numbered list.

## Same task, two models

```bash
lex compare --models gateway:anthropic/claude-sonnet-5.5,gateway:openai/gpt-6.2-sol "add input validation to createUser"
```

Each model runs in parallel, in its own throwaway git copy of your project. Lex prints a table (result, steps, tool calls, tokens, time, files changed), each model's final message and diff stat, and the temp paths so you can inspect them. Add `--diff` for full diffs. Your files are never touched.

## The session

A real run against [`examples/toy-repo`](examples/toy-repo):

```
lex 0.2.0 · gateway:anthropic/claude-sonnet-5.5
~/code/toy-repo (main) · instructions: AGENTS.md · memory: 0 entries
/help for commands · Ctrl-C cancels a turn · Ctrl-D exits

› fix the failing test
Allow bash: npm test 2>&1 | tail -40 ? [y]es / [n]o / [a]lways for "npm test 2>&1 | tail -40" y
● bash npm test 2>&1 | tail -40 → exit 0
● ls . → 5 entries
● bash cat src/*.js test/math.test.js → exit 0
@@ line 2 @@
- return a - b;
+ return a + b;
Allow edit: src/math.js (+1 −1) ? [y]es / [n]o / [a]lways for all edit calls this session y
● edit src/math.js (+1 −1)
Allow bash: npm test 2>&1 | grep -E "^ℹ (pass|fail)" ? [y]es / [n]o / [a]lways for "npm test 2>&1 | grep -E "^ℹ (pass|fail)"" y
● bash npm test 2>&1 | grep -E "^ℹ (pass|fail)" → exit 0
I fixed the failing test. `add` in `src/math.js` was subtracting (`a - b`), and I changed it to `a + b`. That also fixed the `average` test, because `average` calls `add`.

I re-ran `npm test` afterwards: 4 tests pass and 0 fail.
4 steps · 33.6k in / 443 out · 8.6s · gateway:anthropic/claude-sonnet-5.5
```

Commands: `/model [spec|n]`, `/clear`, `/memory`, `/todo`, `/usage`, `/yolo`, `/readonly`, `/login`, `/help`, `/exit`. Ctrl-C cancels a running turn (including at an approval prompt), and Ctrl-D exits.

## How it works

```
 you ──► repl.ts / cli.ts ──► session.ts ──────────────► agent.ts (ToolLoopAgent)
                                │  history, model,           │  model ⇄ tool calls, ≤25 steps
                                │  approvals                 ▼
                                │                      tools/*  read ls grep write edit bash
                                │                               todo ask_user remember load_skill task
                                ▼                            │  path guard · output caps · approval gate
                     prompt.ts + context.ts                  ▼
                     (cwd, git, AGENTS.md, memory, skills)   render.ts ──► your terminal
```

- **Loop** ([`agent.ts`](src/agent.ts)): an AI SDK `ToolLoopAgent` with a step cap, streamed one turn at a time. Before each step, tool output from earlier turns is pruned and the current turn is kept whole, so the model never forgets the file it just read.
- **Model** ([`providers.ts`](src/providers.ts), [`models.ts`](src/models.ts), [`auth.ts`](src/auth.ts)): a one-row-per-provider registry, spec parsing (`provider:model`, bare ids, provider defaults picked from each provider's live catalog), and keys from env vars or `~/.lex/auth.json` (chmod 600).
- **Tools** ([`tools/`](src/tools)): every tool returns a string (errors included), caps its output and says when it cut something. `task` runs a read-only explorer subagent on a cheaper model, and `load_skill` loads `skills/<name>/SKILL.md` on demand.
- **Context** ([`prompt.ts`](src/prompt.ts), [`context.ts`](src/context.ts)): the system prompt is rebuilt every turn from the cwd, git branch, the nearest `AGENTS.md` / `CLAUDE.md` / `LEX.md`, memory and skills.
- **Memory**: `.lex/memory.md` in your project. The agent appends durable facts with `remember`, and they're loaded into every session.
- **Session** ([`session.ts`](src/session.ts), [`repl.ts`](src/repl.ts), [`compare.ts`](src/compare.ts)): one conversation (model, tools, history) shared by one-shot mode, the REPL and compare.
- **Safety** ([`approval.ts`](src/approval.ts), [`util/paths.ts`](src/util/paths.ts)): see below.

## Providers

Bring your own key for any of these (set the env var, or run `lex login`).

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

Model specs can be `provider:model` (`groq:openai/gpt-oss-120b`, `ollama:qwen3:8b`), a provider name for its default model (`--model deepseek`), or a bare id (`claude-opus-5-5`, `gemini-4-neon`, `grok-4.7`, `zai/glm-5.3`). A bare id goes to the direct provider if you have its key, otherwise through the gateway. Override any base URL with `<PROVIDER>_BASE_URL` (e.g. `OLLAMA_BASE_URL`). Set a default with `LEX_MODEL` or `"defaultModel"` in `~/.lex/config.json`.

Add any OpenAI-compatible endpoint (vLLM, LiteLLM, a company proxy) in `~/.lex/config.json`:

```json
{ "providers": { "vllm": { "baseURL": "http://localhost:8000/v1", "apiKeyEnv": "VLLM_API_KEY", "models": ["qwen3"] } } }
```

## Skills

Put instructions in `skills/<name>/SKILL.md` (project) or `~/.lex/skills/<name>/SKILL.md` (yours):

```markdown
---
name: release
description: How to cut a release of this project
---
1. Bump the version in package.json ...
```

Only each skill's name and description go into the prompt. The agent loads the full text with `load_skill` when a task matches.

## Safety

There's no sandbox, so lex relies on these instead:
- **Path guard:** file tools can't leave the project directory, and that includes symlinks pointing outside it.
- **Approval:** `bash`, `write` and `edit` ask before running. Answer `[y]es`, `[n]o`, or `[a]lways` for the rest of the session.
- **Safe commands:** a few read-only commands (`ls`, `cat`, `git status`, …) run without asking, but only when they contain no `;`, `&&`, `|`, `>`, `$(` or backticks.
- **Modes:** `--readonly` refuses all changes, and `--yolo` allows everything.
- **compare** runs unattended, but only inside throwaway temp copies.
- **Keys** are never printed. Anything key-shaped is redacted from error messages.

## Develop

```bash
bun install
bun test               # unit tests
bun check              # type check
bun run build          # bundle to dist/cli.js for Node 22+
bash scripts/smoke.sh  # pack, clean-room install under Node, run it
bun src/cli.ts         # run from source
```

`plan.md` is the build plan, and `examples/toy-repo` is a tiny project with a failing test for trying things out.

MIT licensed.
