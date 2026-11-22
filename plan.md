# Lexcode: Build Plan (3 hours)

> An open-source, local AI coding harness you can read in an afternoon.
> Swap the model with one flag, and run the same task on two models side by side.
> Install with `npx lexcode`.

References:
- [Vercel Academy, Build an AI Agent Harness](https://vercel.com/academy/build-ai-agent-harness). This plan keeps the harness modules and leaves out every sandbox module (see §10).
- [earendil-works/pi](https://github.com/earendil-works/pi): a production minimal harness. We borrow its model resolution, key storage, tool set, truncation and session ideas (see §12).

**Auth model: bring your own key, no OAuth.** Users bring their own API key and pay with their own credits. v1 supports exactly three providers: **Vercel AI Gateway** (one key that reaches hundreds of models from every major lab), **OpenAI**, and **Anthropic**.

---

## 1. What we're building

The brief describes a harness as "the tools it can call, the context it sees, its memory and the loop that keeps it working." Lexcode is that and no more:

| Harness part | In Lexcode |
|---|---|
| **Model** | Three providers, each with your own key: **AI Gateway** (any model it serves, e.g. `gateway:anthropic/claude-sonnet-5-5`, `gateway:openai/gpt-6.2-sol`, `gateway:zai/glm-5.3`), **Anthropic** direct, and **OpenAI** direct. Pick with `--model`, or switch mid-session with `/model`. |
| **Loop** | AI SDK `ToolLoopAgent`, run in a multi-turn REPL that streams output. |
| **Tools** | `read`, `ls`, `grep`, `write`, `edit`, `bash`, `todo`, `ask_user`, `remember` (plus `load_skill` and `task` as stretch goals). |
| **Context** | A system prompt built at runtime from the cwd, git branch, tool list, `AGENTS.md`/`CLAUDE.md`, and memory. Tool output is capped and old tool results are pruned. |
| **Memory** | `.lexcode/memory.md` in the project. The agent writes to it with `remember`, and it is loaded into the prompt every session. |
| **Safety (no sandbox)** | File tools can't leave the project root. `bash`, `write` and `edit` ask y/n/always before running. Modes: `--yolo` and `--readonly`. |
| **Showcase** | `lexcode compare --models a,b "task"` runs one task on two models, each in its own temp copy of the repo. It prints steps, tokens, time and the diff for each. |

**Distribution:** an npm package, `lexcode`, built to plain Node ESM so judges can run it without Bun:
```bash
npx lexcode            # or: npm i -g lexcode && lexcode
```

---

## 2. Key decisions (made up front so we don't debate them mid-build)

1. **Package name `lexcode`, bin name `lexcode`.** `lex` is already taken on npm, and `/usr/bin/lex` (the lexer generator) already exists on macOS and Linux. `lexcode` and `lex-code` were both free when checked. **Claim the name in the first 15 minutes.**
2. **Develop with Bun, ship for Node.** `bun build src/cli.ts --target=node` produces `dist/cli.js` with a `#!/usr/bin/env node` shebang.
   - ⚠️ **This overrides CLAUDE.md for runtime code only.** Code under `src/` must not use `Bun.file`, `Bun.$` or `Bun.serve`, because judges may run it on Node. Use `node:fs/promises`, `node:child_process`, `node:readline`. Bun stays the dev, test and build tool.
   - Require `engines.node >= 22`. That gives us `fs.promises.glob` and stable `parseArgs`.
3. **AI SDK v7** (`ai@7.0.x`, which is `latest` on npm) with `@ai-sdk/anthropic` and `@ai-sdk/openai` pinned at `4.0.x`. AI Gateway comes from the `gateway` provider (`@ai-sdk/gateway`, which `ai` re-exports, so check that) and reads `AI_GATEWAY_API_KEY`. Use `ToolLoopAgent`, `tool()`, `isStepCount`, `pruneMessages`, `prepareStep` and `agent.stream()`, as the course does. **Check every API name against `node_modules/ai` before writing code**, since the course might lag the SDK.
4. **Approval is gated inside `execute`, not through the SDK's `toolApproval`.** We're an interactive CLI, so `execute` can `await` a readline prompt while the stream waits. That is simpler than the approval-request/response round trip, and `ask_user` gets a real pause the same way. (The course only fakes it with "Awaiting user response".)
5. **No TUI framework.** Use `node:readline`, `picocolors` and our own small renderer. Ink or a markdown renderer would cost an hour we don't have.
6. **Bring your own key, no OAuth, three providers.** Keys come from env vars or from `lexcode login`, which asks for a key and saves it to `~/.lexcode/auth.json` with mode `0600` (pi's `auth.json` pattern, API keys only). With no key, the first run prints a 3-line message saying which key to get. **AI Gateway is the recommended path for judges**: one key, every model, and it makes `compare` across labs trivial. Google, OpenRouter, Ollama and OAuth logins are out of scope for v1.

---

## 3. Architecture

```
lexcode/
├── src/
│   ├── cli.ts            # parseArgs, subcommands (chat | run | compare | login | models), SIGINT
│   ├── repl.ts           # multi-turn loop, slash commands, message history
│   ├── agent.ts          # createAgent({ model, tools, ctx }) -> ToolLoopAgent
│   ├── models.ts         # gateway | anthropic | openai, spec parsing, resolution, listAvailable
│   ├── auth.ts           # BYO keys: env first, then ~/.lexcode/auth.json (0600); login flow
│   ├── prompt.ts         # buildSystemPrompt(ctx): pure, unit tested
│   ├── context.ts        # discover AGENTS.md/CLAUDE.md, git branch, memory file
│   ├── approval.ts       # mode (ask | yolo | readonly) + session "always" set
│   ├── render.ts         # stream chunks -> terminal (text to stdout, tools to stderr)
│   ├── compare.ts        # same task, N models, temp copies, summary table
│   ├── io.ts             # the single shared readline instance: confirm(), choose()
│   ├── util/
│   │   ├── paths.ts      # safeResolve(root, p): throws if p escapes root
│   │   └── truncate.ts   # capLines / capChars / capTail with truncation notices
│   └── tools/
│       ├── index.ts      # buildTools(ctx, approval) -> { read, ls, grep, ... }
│       ├── read.ts  ls.ts  grep.ts  write.ts  edit.ts  bash.ts
│       ├── todo.ts  ask.ts  remember.ts
│       └── skill.ts  task.ts          # stretch
├── test/                 # bun test: prompt, edit, paths, truncate, approval
├── dist/cli.js           # build output, the only thing published
├── package.json  README.md  LICENSE (MIT)
```

**Data flow for one turn:**
```
user input ─► repl.ts pushes {role:"user"} onto messages
          ─► agent.stream({ messages })            (ToolLoopAgent)
               prepareStep: pruneMessages(..., "before-last-3-messages")
               loop: model ─► tool-call ─► execute (approval gate, caps) ─► tool-result ─► model …
               stopWhen: isStepCount(25)
          ─► render.ts prints text deltas and tool lines as they arrive
          ─► append the response messages to history, print the usage footer
```

---

## 4. Components in detail

### 4.1 Model layer: `models.ts` and `auth.ts` (what makes the model swappable)
**Providers (v1):**

| Provider key | Package | Key (env, or `~/.lexcode/auth.json`) | Model id format | Default |
|---|---|---|---|---|
| `gateway` | `gateway` from `ai` / `@ai-sdk/gateway` | `AI_GATEWAY_API_KEY` | `creator/model`, e.g. `anthropic/claude-sonnet-5-5`, `openai/gpt-6.2-sol`, `zai/glm-5.3` | `anthropic/claude-sonnet-5-5` |
| `anthropic` | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5` | `claude-sonnet-5-5` |
| `openai` | `@ai-sdk/openai` | `OPENAI_API_KEY` | e.g. `gpt-6.2-sol` (pi's current OpenAI default) | `gpt-6.2-sol` |

Confirm the default IDs at 0:00 against the provider docs or `gateway.getAvailableModels()`. Pi's `defaultModelPerProvider` is a good cross-check.

**Model spec grammar** (modeled on pi's `model-resolver.ts`, simplified):
- `provider:id`, the explicit form: `gateway:openai/gpt-6.2-sol`, `anthropic:claude-opus-5-5`, `openai:gpt-6.2-sol`.
- A bare id containing `/`, such as `openai/gpt-6.2-sol`, goes through `gateway` (that's the gateway's own id format).
- A bare id without `/`, such as `claude-opus-5-5`, goes to whichever direct provider owns that prefix (`claude-` is Anthropic, `gpt-`/`o` is OpenAI) if its key exists, and otherwise to the gateway with the creator prefix added.
- Fuzzy matching (`sonnet` → the latest Sonnet) is stretch. If a spec doesn't resolve, print the close matches.

**Resolution order:** `--model` flag, then `LEXCODE_MODEL` env, then `~/.lexcode/config.json` `defaultModel`, then the first provider with a key, in the order **gateway → anthropic → openai**. If there's no key at all, print:
```
No API key found. Lexcode is bring-your-own-key. Set one of:
  AI_GATEWAY_API_KEY   (recommended: one key, every model. vercel.com/ai-gateway)
  ANTHROPIC_API_KEY    OPENAI_API_KEY
or run: lexcode login
```

**`auth.ts`:** `getKey(provider)` checks env first, then `~/.lexcode/auth.json` (`{ "gateway": { "type": "api_key", "key": "..." } }`, written with mode `0600`, the same shape as pi). `saveKey(provider, key)` is used by `lexcode login` and `/login`, which ask which of the 3 providers and then take the key as masked input. Keys are passed to providers explicitly (`createAnthropic({ apiKey })`, `createOpenAI({ apiKey })`, `createGateway({ apiKey })`) and **never printed or logged**.

**`listAvailable()` powers `/model`:** a static shortlist for Anthropic and OpenAI, plus the live list from `gateway.getAvailableModels()` when a gateway key is present (cache it for the session; on failure fall back to a shortlist). `/model` with no args prints the current model and a numbered list. `/model <spec>` switches.

### 4.2 Agent loop: `agent.ts`
```ts
new ToolLoopAgent({
  model: registry.languageModel(spec),
  instructions: buildSystemPrompt(ctx),
  tools,
  stopWhen: isStepCount(25),
  prepareStep: ({ messages }) => ({
    messages: pruneMessages({ messages, toolCalls: "before-last-3-messages" }),
  }),
  onStepEnd: ({ usage }) => meter.add(usage),
});
```
- Rebuild the agent whenever the model changes (`/model`). Message history lives in `repl.ts`, so it carries over when the model is swapped. **That's a demo moment.**
- Multi-turn: call `agent.stream({ messages })` with the full history, not `{ prompt }`. The course only does one-shot runs.
- Ctrl-C during a turn aborts that turn through an `AbortController` and returns to the prompt. Ctrl-C at an empty prompt exits.

### 4.3 Tools
Every tool follows the course's **description contract**: WHEN TO USE / WHEN NOT TO USE / DO NOT USE FOR / EXAMPLES. Every tool returns a **string**, errors included (for example `Error: file not found: x`), so the model can recover and the loop never throws. Every output is **capped and says so when it's cut**.

| Tool | Input (zod) | Behavior | Cap | Gate |
|---|---|---|---|---|
| `read` | `path`, `offset?`, `limit?` | Lines prefixed with line numbers | 500 lines, with a "use offset" hint | none |
| `ls` | `path?`, `pattern?` (glob) | `fs.promises.glob`; skips `node_modules`, `.git`, `dist` | 200 entries | none |
| `grep` | `pattern` (regex), `path?`, `glob?` | Uses `rg` if it's on PATH, otherwise a pure-JS walk with a regex (portable, Windows-safe) | 50 matches, plus total count | none |
| `write` | `path`, `content` | Creates or overwrites, and makes parent dirs | n/a | **ask** (show path + line count) |
| `edit` | `path`, `old_string`, `new_string`, `replace_all?` | Exact string replace. Fails if there are 0 matches or more than one match without `replace_all`, and tells the model why | n/a | **ask** (show a colored mini diff) |
| `bash` | `command`, `timeout_ms?` | `spawn(cmd, { shell: true, cwd })`, 60s default timeout, returns `exit N` + output | **last** 5,000 chars (errors show up at the end) | auto-allow safe list, otherwise **ask** |
| `todo` | `action: add\|start\|complete\|list`, `description?`, `id?` | In memory, only one item `in_progress` at a time, re-rendered as a checklist after each change | n/a | none |
| `ask_user` | `question`, `options[2..4]` | **Actually blocks** on a readline numbered choice (or free text) and returns the answer | n/a | none |
| `remember` | `fact` | Appends `- (YYYY-MM-DD) fact` to `.lexcode/memory.md` | file kept at 4k chars or less | none |
| `load_skill` *(stretch)* | `name` | Loads `skills/<name>/SKILL.md` on demand. Only names and descriptions go in the prompt | 4,000 chars | none |
| `task` *(stretch)* | `description` | Runs an explorer subagent with read-only tools (`read`, `ls`, `grep`) on a cheap model, `isStepCount(8)`, and returns a summary string | summary only | none |

**Path guard (our replacement for a sandbox):** `safeResolve(root, p)` resolves `p` against `root`, follows symlinks (`realpath`), and refuses anything outside `root`. Every file tool calls it.

### 4.4 Approval: `approval.ts`
- Modes: `ask` (default), `yolo` (`--yolo`, allow everything), `readonly` (`--readonly`; write, edit and non-safe bash are refused with a string so the model knows).
- Prompt: `Allow bash: npm test ? [y]es / [n]o / [a]lways for "npm test"`. The `always` choice adds the command (or the tool, for write/edit) to a session `Set`.
- Safe bash auto-allow: `ls pwd cat head tail wc git status/log/diff/show which echo`. **It applies only when the command contains none of** `; && || | > < $( \` `. This closes the `git status && rm -rf` bypass the course leaves open, and it uses exact first-token matching, so `catastrophe` doesn't pass as `cat`.
- When the user says no, the tool returns `User denied this action. Ask them how to proceed.`, and the model adapts.

### 4.5 Context and system prompt: `prompt.ts` and `context.ts`
`buildSystemPrompt(ctx)` is a pure function that builds a `sections[]` array and joins it:
1. Identity: "You are Lexcode, a coding agent working in `<cwd>` on `<os>`." Plus the date and git branch (if any).
2. `# Agency`: act, don't explain. Search before creating. Make minimal changes. Read before editing. Run tests or typecheck after changes if the project has them.
3. `# Tools`: the available tool names, plus "prefer read/grep over bash for files."
4. `# Handling ambiguity`: search, then ask (`ask_user`), then act.
5. `# Planning`: use `todo` for tasks with 3 or more steps.
6. `# Project instructions`: the first match among `AGENTS.md`, `CLAUDE.md`, `LEXCODE.md`, searched in cwd and then up to the git root (capped at 8k chars).
7. `# Memory`: the contents of `.lexcode/memory.md`, plus "use `remember` for durable facts (commands, conventions, user preferences)."
8. `# Skills` *(stretch)*: one line per skill.

Context budget: tool caps (prevention) plus `pruneMessages` (cleanup), with a token meter in the footer. Anthropic prompt caching on the system prompt is P2.

### 4.6 Surface: `cli.ts`, `repl.ts`, `render.ts`
```
lexcode                          # interactive REPL in cwd
lexcode "fix the failing test"   # one-shot: run, print, exit (pipe-friendly)
lexcode compare --models gateway:anthropic/claude-sonnet-5-5,gateway:openai/gpt-6.2-sol "add input validation to src/api.ts"
lexcode login                    # pick gateway | anthropic | openai, paste key -> ~/.lexcode/auth.json (0600)
lexcode models                   # list models available with your keys
Flags: --model, --yolo, --readonly, --cwd, --max-steps, --version, --help
```
- **Rendering:** text deltas go to stdout. Tool lines go to stderr, dimmed, one per call, with a per-tool summary:
  `● read src/api.ts (120 lines)` · `● grep "TODO" → 7 matches` · `● bash npm test → exit 1` · `● edit src/api.ts (+3 −1)`.
  Show a spinner while the model is thinking, and stop it before any approval prompt.
- **Footer after each turn:** `4 steps · 12.3k in / 0.8k out · 9.1s · anthropic:claude-sonnet-5-5`
- **Slash commands:** `/model [spec]`, `/clear`, `/memory`, `/todo`, `/usage`, `/yolo`, `/help`, `/exit`.
- **Banner:** name, version, model, cwd, project-instructions file found (yes/no), memory entries count.

### 4.7 Compare: `compare.ts` (the brief's "same task on two models")
1. For each model: `fs.cp(cwd, tmpdir/lexcode-<model>, { filter: skip node_modules/.git/dist })`, then `git init && git add -A && git commit` inside the copy so the diff is clean.
2. Run the agent headless in that copy with `yolo` approval (it's a throwaway copy) and a step cap. Run the models in parallel with `Promise.all`, and buffer each one's output.
3. Print a table: model | steps | tool calls | tokens in/out | wall time | finished? Then each model's final message and its `git diff --stat` (`--diff` for the full diff).
4. Print the temp paths so judges can inspect them.

> Without a sandbox, compare mode is the one place commands run unattended, and it runs them only inside a temp copy. Print that clearly when it starts.

---

## 5. Phases for coding agents

The build runs in **6 phases across 4 waves**. Phases in the same wave run **in parallel on separate agents**. Each wave waits for the one before it to finish.

```
Wave 0  ── Phase 0  Foundation & contracts ───────────────┐   (1 agent, 0:00–0:20)
                                                          ▼
Wave 1  ── Phase 1A Model + loop + render + one-shot CLI  │
        ── Phase 1B File tools (read/ls/grep/write/edit)  │   (4 agents in parallel, 0:20–1:05)
        ── Phase 1C Safety + interactive tools            │
        ── Phase 1D System prompt + context + memory      │
                                                          ▼
Wave 2  ── Phase 2  Integration: REPL, wiring, publish MVP ┐   (1 agent, 1:05–1:45)
                                                          ▼
Wave 3  ── Phase 3A Compare mode                          │
        ── Phase 3B Docs, tests, smoke script             │   (2–3 agents in parallel, 1:45–2:30)
        ── Phase 3C Stretch: task subagent + skills       │
                                                          ▼
Wave 4  ── Phase 4  Release & demo                        (1 agent or you, 2:30–3:00)
```

### 5.0 Rules for every agent (paste these into each brief)
1. **Only touch the files your phase owns** (see the ownership matrix in §5.7). If you need a change somewhere else, stop and report it. Don't make the edit.
2. **Don't change `src/types.ts`.** It's the contract between phases. If it's wrong, report that.
3. Runtime code must run on **Node 22**: use `node:fs/promises`, `node:child_process`, `node:readline`. No `Bun.*` APIs in `src/`. Use Bun for tests (`bun test`), type checks (`bun check`) and builds only.
4. Every tool returns a **string** and never throws to the model. Every output is capped and says when it's been cut.
5. Your phase is done when its **acceptance checks pass** and `bun check` is clean. End with a short report: files changed, checks run, anything left open.
6. Read `plan.md` §4 for the full behavior spec of whatever you're building.

Parallel agents can share one working tree, since the file-ownership rule prevents collisions. Or give each one its own git worktree/branch and merge between waves. Run `git init` in Phase 0 either way.

---

### Phase 0: Foundation and contracts *(Wave 0 · 1 agent · about 20 min · blocks everything)*
**Goal:** a skeleton that type-checks, builds to Node, and is published as `lexcode@0.0.1`, with shared contracts frozen so Wave 1 agents can work without coordinating.

**Tasks**
- `git init`, `.gitignore` (`node_modules`, `dist`, `.lexcode/`), MIT `LICENSE`.
- `bun add ai @ai-sdk/anthropic @ai-sdk/openai zod picocolors`. Add `@ai-sdk/gateway` only if `ai` doesn't re-export `gateway`/`createGateway`.
- Update `package.json` to the shape in §6: remove `private` and `peerDependencies`, add `bin`, `files`, `engines`, scripts.
- **Check the AI SDK v7 API** in `node_modules/ai`: `ToolLoopAgent` options (`instructions`, `stopWhen`, `prepareStep`, `onStepEnd`), `isStepCount`, `pruneMessages`, `tool()` (`inputSchema`), `agent.stream({ messages, abortSignal })`, and the chunk type names (`text-delta`, `tool-call`, `tool-result`, `finish`). Record the real names in `docs/ai-sdk-notes.md` (around 20 lines) for the other agents.
- Write `src/types.ts` (below) **exactly as shown**, adjusting only the AI SDK type imports to match v7.
- Implement `src/util/truncate.ts` and `src/util/paths.ts` with their tests. They're small and pure, and every other phase uses them.
- Create stub files for every module in §3 that export the agreed signatures and `throw new Error("TODO")`, so imports resolve from the start.
- `src/cli.ts` stub: shebang, `--version`, `--help`.
- `bun run build`, `npm pack`, install the tarball globally under Node, run `lexcode --version`. **`npm publish --access public` as `0.0.1`.** You'll need npm login and OTP, so do this one yourself.

**Contract: `src/types.ts`**
```ts
import type { Tool, LanguageModel } from "ai";

export type ApprovalMode = "ask" | "yolo" | "readonly";

export interface ApprovalRequest {
  tool: string;          // "bash" | "write" | "edit"
  summary: string;       // one line, e.g. `npm test` or `src/api.ts (+3 −1)`
  detail?: string;       // optional multi-line, e.g. a colored diff
  alwaysKey: string;     // what "always" remembers, e.g. "bash:npm test" or "edit"
}
export type ApprovalResult = "allow" | "deny" | "readonly";

export interface Approver {
  mode: ApprovalMode;
  setMode(mode: ApprovalMode): void;
  request(req: ApprovalRequest): Promise<ApprovalResult>;
  isSafeCommand(command: string): boolean;   // operator-aware allowlist
}

export interface IO {
  confirm(question: string): Promise<"y" | "n" | "a">;
  choose(question: string, options: string[]): Promise<string>; // allows free text
  prompt(label: string): Promise<string | null>;                // null on EOF / Ctrl-D
  secret(label: string): Promise<string>;                       // masked input for API keys
  withPaused<T>(fn: () => Promise<T>): Promise<T>;              // stops the spinner around prompts
  info(msg: string): void;                                      // dim line to stderr
}

export interface ToolContext {
  root: string;          // realpath of project root; all file access is confined here
  approver: Approver;
  io: IO;
  memoryPath: string;    // <root>/.lexcode/memory.md
}
export type ToolFactory = (ctx: ToolContext) => Tool;

export type ProviderId = "gateway" | "anthropic" | "openai";
export interface ModelInfo { spec: string; provider: ProviderId; id: string }
export interface ResolvedModel extends ModelInfo { model: LanguageModel }

export interface PromptContext {
  cwd: string;
  os: string;
  date: string;
  toolNames: string[];
  gitBranch?: string;
  projectInstructions?: { file: string; content: string };
  memory?: string;
  skills?: { name: string; description: string }[];
}

export interface TurnUsage { steps: number; toolCalls: number; inputTokens: number; outputTokens: number; ms: number }
```

**Agreed signatures (stubs in Phase 0, implemented in Wave 1)**
```ts
// models.ts      resolveModel(spec?: string): Promise<ResolvedModel>; listAvailable(): Promise<ModelInfo[]>; DEFAULTS: Record<ProviderId, string>
// auth.ts        getKey(p: ProviderId): Promise<string | undefined>; saveKey(p: ProviderId, key: string): Promise<void>; login(io: IO): Promise<void>
// agent.ts       createAgent(o: { model: ResolvedModel; tools: Record<string, Tool>; instructions: string; maxSteps?: number }): Agent
//                runTurn(agent, messages, o: { signal?: AbortSignal; onChunk?: (c) => void }): Promise<{ responseMessages; text; usage: TurnUsage }>
// render.ts      createRenderer(): { onChunk(c): void; footer(u: TurnUsage, spec: string): void }
// tools/*.ts     export const createReadTool: ToolFactory   (same for Ls, Grep, Write, Edit, Bash, Todo, AskUser, Remember)
// tools/index.ts buildTools(ctx: ToolContext): Record<string, Tool>
// approval.ts    createApprover(io: IO, mode: ApprovalMode): Approver
// io.ts          createIO(): IO
// prompt.ts      buildSystemPrompt(ctx: PromptContext): string
// context.ts     loadContext(root: string): Promise<Omit<PromptContext, "toolNames">>
// util/paths.ts  safeResolve(root: string, p: string): Promise<string>   // throws PathEscapeError
// util/truncate  capLines(s, n, hint?) / capChars(s, n) / capTail(s, n)
```

**Acceptance:** `bun check` is clean, `bun test` passes (paths and truncate), `lexcode@0.0.1` is on npm, and `npx lexcode --version` works under Node.

---

### Phase 1A: Model layer, agent loop, renderer, one-shot CLI *(Wave 1 · about 45 min)*
**Owns:** `src/models.ts`, `src/auth.ts`, `src/agent.ts`, `src/render.ts`, `src/cli.ts`
**Spec:** §4.1, §4.2, the rendering part of §4.6.
**Tasks**
- `auth.ts`: `getKey(provider)` (env first, then `~/.lexcode/auth.json`), `saveKey` (mode `0600`), and the `login` flow (choose from 3 providers, masked key input through `IO`). **API keys only, no OAuth.** Never log keys.
- `models.ts`: **only `gateway`, `anthropic`, `openai`**. Parse the spec grammar from §4.1 (`provider:id`, a bare id with `/` → gateway, a bare `claude-*`/`gpt-*` → direct provider if its key exists, otherwise gateway). Build providers lazily with explicit `apiKey`. Apply the resolution order gateway → anthropic → openai. Print the no-key message from §4.1. `listAvailable()` uses `gateway.getAvailableModels()` when a gateway key exists, plus static shortlists. Fill in `DEFAULTS` with **verified** IDs.
- `cli.ts` subcommands: `login` and `models`, in addition to chat, one-shot and `compare`.
- `agent.ts`: `ToolLoopAgent` with `prepareStep` pruning (`before-last-3-messages`), `isStepCount(maxSteps ?? 25)`, a usage meter, abort support. `runTurn` streams and returns response messages plus `TurnUsage`.
- `render.ts`: text to stdout. Dim tool lines to stderr with the per-tool summaries from §4.6, a spinner, and the footer.
- `cli.ts`: `parseArgs` with `--model`, `--yolo`, `--readonly`, `--cwd`, `--max-steps`, `--version`, `--help`, and positional prompt for one-shot mode. Subcommand dispatch: `compare` goes to `compare.ts` (a stub for now). No prompt goes to `repl.ts` (a stub until Phase 2).
- Until Phase 1B lands, test with a throwaway inline `read` tool in a scratch file, not in the tools folder.

**Acceptance:** `bun src/cli.ts --model <spec> "list the files here and summarize"` streams for **all three routes**: `gateway:anthropic/claude-sonnet-5-5`, `anthropic:claude-sonnet-5-5`, `openai:gpt-6.2-sol` (whichever keys you have; gateway at minimum). `lexcode login` saves a key that the next run picks up. With no key, the friendly message prints. A bad spec prints close matches. Ctrl-C aborts cleanly.

### Phase 1B: File tools *(Wave 1 · about 45 min)*
**Owns:** `src/tools/read.ts`, `ls.ts`, `grep.ts`, `write.ts`, `edit.ts`, plus `test/tools.files.test.ts`
**Spec:** the §4.3 table and description contract, and the path guard.
**Tasks**
- All five factories take a `ToolContext` and call `safeResolve` on every path. A path that escapes the root returns an error string.
- `read`: line numbers, offset and limit, a 500-line cap with a hint. `ls`: `fs.promises.glob`, ignore list, 200-entry cap. `grep`: use `rg` if it's on PATH, otherwise a pure-JS walk, with a 50-match cap and the total count.
- `write` and `edit` call `ctx.approver.request(...)` **before** writing. On `"deny"` or `"readonly"`, return the matching message from §4.4. `edit` builds a small `+`/`−` diff for `detail`.
- Each tool gets a full 4-section description.
- Tests use a fake `Approver` and `IO` (always allow or always deny) in a temp dir.

**Acceptance:** tests cover the edit edge cases (0 matches, more than one, `replace_all`), path escape attempts, cap notices, and the deny path.

### Phase 1C: Safety and interactive tools *(Wave 1 · about 45 min)*
**Owns:** `src/approval.ts`, `src/io.ts`, `src/tools/bash.ts`, `todo.ts`, `ask.ts`, `remember.ts`, plus `test/approval.test.ts` and `test/tools.interactive.test.ts`
**Spec:** §4.3 (bash, todo, ask_user, remember) and §4.4.
**Tasks**
- `io.ts`: **one** shared `readline` interface, `confirm`/`choose`/`prompt`, a spinner that `withPaused` stops, and handling for when stdin isn't a TTY (deny by default and say so).
- `approval.ts`: the three modes, the session `always` set, and `isSafeCommand` (exact first token plus allowlist, **rejecting** `; && || | > < $( \``).
- `bash.ts`: `spawn(cmd, { shell: true, cwd: root })`, timeout and kill, merged stdout and stderr, `exit N` header, `capTail(5000)`. Safe commands skip approval.
- `todo.ts`: in-memory list, a single item in progress, returns a rendered checklist. `ask.ts`: blocks through `io.choose`. `remember.ts`: appends a dated bullet to `memoryPath`, creates `.lexcode/` if needed, and caps the file at 4k chars.

**Acceptance:** tests show that `git status && rm -rf x` needs approval, `catx` isn't treated as safe, readonly refuses, a bash timeout works, the single-active todo rule holds, and `remember` appends to the file.

### Phase 1D: System prompt, context, memory loading *(Wave 1 · about 30 min, the smallest phase, so it can also do `tools/index.ts`)*
**Owns:** `src/prompt.ts`, `src/context.ts`, `src/tools/index.ts`, plus `test/prompt.test.ts`
**Spec:** §4.5.
**Tasks**
- `buildSystemPrompt`: pure, builds `sections[]`, includes every section from §4.5, and leaves out optional sections when their data is missing.
- `loadContext`: git branch (`git rev-parse --abbrev-ref HEAD`, ignored if it fails), the first match among `AGENTS.md`, `CLAUDE.md`, `LEXCODE.md` from cwd up to the git root (capped at 8k chars), `.lexcode/memory.md` if it exists, OS, and date.
- `tools/index.ts`: `buildTools(ctx)` imports every factory and returns `{ read, ls, grep, write, edit, bash, todo, ask_user, remember }`. Factories are stubs until 1B and 1C merge, which is fine.

**Acceptance:** prompt tests (sections appear or are left out correctly), and `loadContext` finds a `CLAUDE.md` one directory up in a test fixture.

---

### Phase 2: Integration, REPL, MVP publish *(Wave 2 · 1 agent · about 40 min)*
**Owns:** `src/repl.ts`, and may make **small integration fixes in any file** (this is the only phase allowed to).
**Spec:** §4.2 (multi-turn, swap) and §4.6 (slash commands, banner).
**Tasks**
- Merge the Wave 1 work and fix integration type errors.
- `repl.ts`: banner, prompt loop, `messages` history, `runTurn` with an `AbortController` (Ctrl-C cancels the turn, Ctrl-C or Ctrl-D at an empty prompt exits), footer.
- Slash commands: `/model [spec]` (rebuild the agent and keep history), `/clear`, `/memory`, `/todo`, `/usage`, `/yolo`, `/readonly`, `/help`, `/exit`.
- Rebuild the system prompt after `remember` so new memory is used the next turn.
- Wire one-shot mode in `cli.ts` to the same `runTurn`.
- `bun run build`, then do the clean-room install under Node, then **publish `0.1.0`**.

**Acceptance (the MVP demo):** in a toy repo with a failing test, `npx lexcode@0.1.0` fixes it. It asks before `npm test` and before the edit, a "no" is handled gracefully, `/model` switches providers mid-conversation, and `remember` survives a restart.

---

### Phase 3A: Compare mode *(Wave 3 · about 30 min)*
**Owns:** `src/compare.ts`
**Spec:** §4.7. Reuses `resolveModel`, `createAgent`, `runTurn`, `buildTools` (with a yolo `Approver` and a silent `IO`), and `loadContext`.
**Acceptance:** `lexcode compare --models A,B "task"` runs both models in parallel in temp copies, then prints the summary table, each model's final message, `git diff --stat`, and the temp paths. `--diff` prints full diffs. One model failing doesn't sink the other.

### Phase 3B: Docs, tests, smoke script *(Wave 3 · about 30 min)*
**Owns:** `README.md`, `test/**` (filling gaps only), `scripts/smoke.sh`, `examples/toy-repo/` (a tiny project with a failing test and an `AGENTS.md`)
**Tasks:** README from §7, with an architecture diagram and a link to each source file. `smoke.sh` does `npm pack`, installs into a temp prefix under Node, and runs `lexcode --version`, `lexcode --help`, and a one-shot prompt against `examples/toy-repo`.
**Acceptance:** `bash scripts/smoke.sh` passes, and the README quickstart works when copied and pasted.

### Phase 3C: Stretch *(Wave 3 · only if Phase 2 finished by 1:45)*
**Owns:** `src/tools/task.ts`, `src/tools/skill.ts`, plus a one-line registration each in `tools/index.ts` and `prompt.ts` (coordinate those two edits with whoever runs Phase 4).
**Tasks:** an explorer subagent (`read`, `ls`, `grep` only, a cheap model, `isStepCount(8)`, returns a summary), and skills discovery and `load_skill` (project `skills/` and then `~/.lexcode/skills/`, progressive disclosure). If there's time: `--continue` session resume.

---

### Phase 4: Release and demo *(Wave 4 · 1 agent or you · about 30 min)*
**Tasks:** merge Wave 3, `bun check`, `bun test`, `scripts/smoke.sh`, bump to `0.2.0`, `npm publish`, push the public GitHub repo, run the demo script in §8 end to end on a clean machine or directory, and record it.
**Acceptance:** `npx lexcode` (the latest version) runs the full §8 demo.

---

### 5.7 File ownership matrix

| File | 0 | 1A | 1B | 1C | 1D | 2 | 3A | 3B | 3C |
|---|---|---|---|---|---|---|---|---|---|
| `package.json`, `types.ts`, `util/*` | **W** | | | | | fix | | | |
| `models.ts`, `auth.ts`, `agent.ts`, `render.ts`, `cli.ts` | stub | **W** | | | | fix | | | |
| `tools/read,ls,grep,write,edit.ts` | stub | | **W** | | | fix | | | |
| `approval.ts`, `io.ts`, `tools/bash,todo,ask,remember.ts` | stub | | | **W** | | fix | | | |
| `prompt.ts`, `context.ts`, `tools/index.ts` | stub | | | | **W** | fix | | | 1 line |
| `repl.ts` | stub | | | | | **W** | | | |
| `compare.ts` | stub | | | | | | **W** | | |
| `README.md`, `scripts/`, `examples/`, `test/**` gaps | | | | | | | | **W** | |
| `tools/task.ts`, `tools/skill.ts` | | | | | | | | | **W** |

**W** = owns and writes · **stub** = Phase 0 creates the signature only · **fix** = Phase 2 may make integration fixes

### 5.8 Brief template for each agent
```
You're building Phase <X> of Lexcode, a minimal open-source AI coding harness (TypeScript, AI SDK v7, ships as an npm CLI for Node 22).
Read plan.md: §5.0 (rules), §5 Phase <X> (your scope), §4.<n> (behavior spec), and docs/ai-sdk-notes.md (verified SDK API names).
Contracts are in src/types.ts. Don't modify it.
You own only: <files>. Don't edit anything else; report needed changes instead.
Done when: <acceptance checks>, `bun check` is clean, and `bun test` passes.
Finish with: files changed, checks run, open issues.
```

### 5.9 Cut order and stretch
**Cut order if behind** (cut from the top): Phase 3C entirely → `compare --diff` → spinner → `ls` (fold into `grep`/`bash`) → todo rendering polish. **Never cut:** the approval gate, the path guard, `/model` swap, or publishing.

**Stretch (only if ahead):** `--continue` session resume (`.lexcode/sessions/*.json`) · Anthropic cache control · first-run interactive setup that saves the key to `~/.lexcode/config.json` (chmod 600).

---

## 6. Publishing checklist

```jsonc
// package.json (shape)
{
  "name": "lexcode",
  "version": "0.1.0",
  "description": "A minimal, open-source, model-agnostic AI coding harness for your terminal",
  "type": "module",
  "bin": { "lexcode": "dist/cli.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "bun src/cli.ts",
    "build": "bun build src/cli.ts --target=node --outfile dist/cli.js",
    "test": "bun test",
    "typecheck": "bun check",
    "prepublishOnly": "bun run typecheck && bun test && bun run build"
  },
  "keywords": ["ai", "agent", "harness", "coding-agent", "cli", "ai-sdk", "llm"],
  "license": "MIT",
  "repository": "github:<you>/lexcode"
}
```
- Remove `"private": true` and the `peerDependencies` block from the current package.json.
- Put the shebang `#!/usr/bin/env node` on the first line of `src/cli.ts`. Bun keeps it in the build. Check that `dist/cli.js` is executable.
- Bundle the runtime dependencies into `dist/cli.js` so `npx` starts fast with nothing to install. If bundling breaks a provider, add `--packages=external` and move those packages to `dependencies`.
- Before every publish: `npm pack`, then install the tarball in a temp dir with `npm i -g ./lexcode-x.y.z.tgz` and run `lexcode --version` and a real prompt **under Node, not Bun**.
- `npm publish --access public`. Have 2FA/OTP ready (this is why we publish at 0:15).
- Push to a public GitHub repo. The brief is about being *open*, so link it from the README and the npm page.

---

## 7. README for judges (draft)

````md
# lexcode

A minimal, open-source AI coding harness. It's around 1k lines of TypeScript you can read in an afternoon.
Model, tools, memory, loop. Bring your own key. No OAuth, no account, your credits.

## Try it (60 seconds)
```bash
export AI_GATEWAY_API_KEY=...     # recommended: one key, hundreds of models
# or: export ANTHROPIC_API_KEY=...  /  export OPENAI_API_KEY=...
# or: npx lexcode login           (saves to ~/.lexcode/auth.json, chmod 600)
cd your-project
npx lexcode
```

## Swap the model
lexcode --model gateway:openai/gpt-6.2-sol
lexcode --model anthropic:claude-opus-5-5
/model gateway:zai/glm-5.3            # mid-conversation; history is kept
lexcode models                        # what your keys can reach

## Same task, two models
lexcode compare --models gateway:anthropic/claude-sonnet-5-5,gateway:openai/gpt-6.2-sol "add tests for utils.ts"

## How it works
<diagram + one paragraph per part: loop, tools, context, memory, safety; link to each src file>

## Safety
No sandbox. File tools are confined to the project dir. bash/write/edit ask before running.
--readonly to observe, --yolo to trust. compare runs in throwaway temp copies.
````

---

## 8. Demo script (about 3 minutes, for judges)

1. `npx lexcode` in a toy repo with a failing test. The banner shows the model and that `AGENTS.md` was found.
2. "Fix the failing test." The agent uses `grep`, `read`, `todo`, asks to run `bash npm test`, proposes an `edit` with a diff, re-runs the tests, and they pass. The footer shows tokens and steps.
3. "Remember that we use bun, not npm." The agent calls `remember`. `/memory` shows the entry. Restart, and the agent already knows.
4. `/model gateway:openai/gpt-6.2-sol`, then "Now add a test for the edge case." A model from a different lab continues the same conversation, on the same gateway key.
5. `lexcode compare --models gateway:anthropic/claude-sonnet-5-5,gateway:openai/gpt-6.2-sol "add input validation to createUser"`. Show the table and the two diffs.
6. Open `src/agent.ts` (about 40 lines) to show "this is the whole loop."

---

## 9. Tests (`bun test`, keep it to 20 minutes total, spread across blocks)
- `prompt.test.ts`: the branch line, project instructions and memory sections show up only when present.
- `edit.test.ts`: 0 matches fails, multiple matches fail unless `replace_all` is set, and a single match replaces correctly.
- `paths.test.ts`: `../`, absolute paths outside root, and symlinks escaping root are all rejected.
- `approval.test.ts`: safe commands pass, chained commands (`&&`, `;`, `|`, `$(`) are asked about, prefix tricks (`catx`) are asked about, and readonly refuses.
- `truncate.test.ts`: caps add the notice, and the tail cap keeps the tail.

---

## 10. Mapping to the Vercel course

| Course module | Lexcode | Notes |
|---|---|---|
| 1. Agent loop (ToolLoopAgent, read/grep/bash) | ✅ Keep | Adds multi-turn history and `ls` |
| 2. Tool design (descriptions, shell safety, approval gates) | ✅ Keep and harden | Approval is a real interactive y/n/always prompt. Shell operators are blocked from auto-allow |
| 3. System prompt (structure, dynamic build, verification, AGENTS.md) | ✅ Keep | Also reads CLAUDE.md and walks up to the git root |
| **4. Sandbox abstraction** | ❌ **Excluded** | Replaced by the path guard, approval modes, and temp copies for compare |
| 5. Context management (pruning, output caps, cache control) | ✅ Keep (cache control is P2) | |
| 6. Subagents (explorer, executor, task tool) | 🟡 Stretch | Explorer only, read-only tools, cheap model |
| **7. Sandbox lifecycle (state machine, snapshots, durable workflows)** | ❌ **Excluded** | |
| 8. Human-in-the-loop (structured questions, approval config) | ✅ Keep | `ask_user` actually blocks for input |
| 9. Planning and verification (todo, verification contract) | ✅ Keep | Verification is a prompt rule: run the project's test/typecheck after edits |
| 10. Surfaces (CLI, streaming, web) | ✅ CLI and streaming. ❌ No web | Published to npm |
| 11. Extensibility (skills, custom tools, events) | 🟡 Skills are a stretch goal | |
| *Added: not in course* | ✅ | Model registry and `/model` swap, `compare` command, `remember` memory file, npm distribution |

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| AI SDK v7 API names differ from the course | Check `node_modules/ai` at 0:00 and keep `agent.ts` small so fixes stay local |
| npm name taken or 2FA blocks the publish | Publish the stub at 0:15. Fall back to `lex-code` |
| Bundled build breaks under Node | Test `npm pack` plus a global install under Node at every publish. Fall back to `--packages=external` |
| Readline prompt clashes with the stream or spinner | One shared readline in `io.ts`. Stop the spinner before any prompt |
| Judges have no key, or only one provider's key | Put AI Gateway first in the README (one key, every model). Clear no-key message plus `lexcode login`. Record the demo as a fallback |
| Gateway model IDs or `getAvailableModels()` differ from what we expect | Check at 0:00. Static shortlist fallback. `provider:id` always lets users pass any id through |
| A key leaks into logs or session files | Keys only live in `auth.ts`. Never render provider errors raw; strip `Authorization`/key-like strings |
| Agent runs something destructive (no sandbox) | Approval by default, operator-aware allowlist, path guard, `--readonly`. Compare runs only in temp copies |
| Running out of time | Strict checkpoints, the cut order in §5, and the MVP published by 1:45 |

---

## 12. What we borrow from pi (and what we skip)

[pi](https://github.com/earendil-works/pi) (`packages/coding-agent`, `packages/ai`) is a minimal production harness with a similar philosophy. Agents can read these files for reference. **Don't copy code wholesale**: keep Lexcode readable in an afternoon.

| Pi idea | Where in pi | Lexcode version |
|---|---|---|
| Model references: `provider/id`, bare ids, fuzzy matching, `:thinking` suffix | `coding-agent/src/core/model-resolver.ts` | `provider:id` plus bare-id routing (§4.1). Fuzzy matching and thinking suffix are stretch |
| A default model per provider | `defaultModelPerProvider` in the same file | `DEFAULTS` for 3 providers |
| Key store in `auth.json`, mode `0600`, `{type:"api_key", key}`, env first | `coding-agent/src/core/auth-storage.ts`, `ai/src/env-api-keys.ts` | `~/.lexcode/auth.json`, API keys only, **no OAuth** (pi also does subscription OAuth; we skip it) |
| `/login` inside the app | pi README | `lexcode login` and `/login` |
| Generated model catalog with context window and cost | `ai/src/models.generated.ts`, `providers/*.models.ts` | Live `gateway.getAvailableModels()` plus a small static list. A cost estimate in the footer is stretch |
| Default tools `read, bash, edit, write` plus `grep, find, ls` | `coding-agent/src/core/tools/*`, `system-prompt.ts` | The same core set plus `todo`, `ask_user`, `remember` |
| Truncation helpers (`truncateHead`/`truncateTail`, 2000 lines / 50KB defaults, 500-char grep lines) | `core/tools/truncate.ts` | `util/truncate.ts` with tighter caps (500 lines, 5k-char bash tail). **Also cap each grep line at 500 chars** |
| Serialize writes to the same file | `core/tools/file-mutation-queue.ts` | Run `write`/`edit` one at a time (a simple promise chain in `tools/index.ts`) |
| Project context files merged into the system prompt | `system-prompt.ts` (`contextFiles`) | `AGENTS.md`/`CLAUDE.md`/`LEXCODE.md` discovery (§4.5) |
| Sessions as JSONL with `model_change` and `usage` entries | `core/session-manager.ts` | Stretch: `--continue` that writes `.lexcode/sessions/<id>.jsonl` |
| Print/JSON mode for automation | pi `docs/cli.md` | One-shot mode prints plain text. A `--json` event stream is stretch |
| **Skipped in pi on purpose:** sub-agents and plan mode | pi README | Our `task` subagent stays a stretch goal, which agrees with pi's choice |
| Skipped by us: extensions, packages, themes, TUI, RPC, MCP, compaction | n/a | Out of scope for 3 hours |
