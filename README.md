# lexcode

A minimal, open-source AI coding harness you can read in an afternoon.
Model, tools, memory, loop. Bring your own key: no OAuth, no account, your credits.

> Work in progress. Phases 0–1 of [`plan.md`](plan.md) are done. The interactive REPL (Phase 2) and `compare` (Phase 3A) are next.

## Try it

```bash
bun install
export AI_GATEWAY_API_KEY=...        # recommended: one key, every model
# or ANTHROPIC_API_KEY / OPENAI_API_KEY, or: bun src/cli.ts login
bun src/cli.ts "list the files here and summarize"
bun src/cli.ts --model gateway:openai/gpt-6.2-sol "fix the failing test"
bun src/cli.ts models                 # models your keys can reach
```

Flags: `--model`, `--yolo`, `--readonly`, `--cwd`, `--max-steps`, `--version`, `--help`.

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
  models.ts    gateway | anthropic | openai spec parsing and resolution
  auth.ts      BYO keys: env first, then ~/.lexcode/auth.json (0600)
  prompt.ts    system prompt builder (pure)
  context.ts   AGENTS.md / CLAUDE.md discovery, git branch, memory
  approval.ts  ask | yolo | readonly, operator-aware safe-command list
  io.ts        the single shared readline, prompts, spinner
  render.ts    stream chunks to the terminal, footer
  repl.ts      interactive loop (Phase 2)
  compare.ts   same task on N models (Phase 3A)
  types.ts     contracts shared between modules
  tools/       read ls grep write edit bash todo ask remember, index.ts
  util/        paths (path guard), fs, truncate, serialize
test/          bun test suites
```

## Safety

No sandbox. File tools are confined to the project directory (symlinks included). `bash`, `write` and `edit` ask before running. Use `--readonly` to only observe and `--yolo` to allow everything.

MIT licensed.
