# AI SDK v7 notes (verified against node_modules, ai@7.0.179)

- `import { ToolLoopAgent, tool, isStepCount, pruneMessages, createGateway, type ModelMessage, type Tool, type TextStreamPart, type ToolSet, type LanguageModel, type LanguageModelUsage } from "ai"`.
  `stepCountIs` is an alias of `isStepCount`. `createGateway` / `gateway` are re-exported by `ai`, so there's no need for `@ai-sdk/gateway`.
- `new ToolLoopAgent({ model, instructions, tools, stopWhen, prepareStep, toolCallConcurrency? })`.
  `onStepEnd` (non-deprecated; `onStepFinish` is deprecated) is a **call** parameter: `agent.stream({ messages, abortSignal, onStepEnd })`.
- `agent.stream(...)` returns a **Promise** of `StreamTextResult`, so `await` it. Then iterate `result.fullStream` (or `result.stream`).
  Promises on the result: `text`, `steps`, `totalUsage`, `responseMessages` (`ModelMessage[]`, to append to history), `finishReason`.
- Stream part `type`s: `start`, `start-step`, `text-start`, `text-delta` (`.text`), `text-end`, `reasoning-delta` (`.text`),
  `tool-input-start`, `tool-call` (`.toolName`, `.input`, `.toolCallId`), `tool-result` (`.output`), `tool-error` (`.error`),
  `finish-step` (`.usage`), `finish` (`.totalUsage`), `abort`, `error` (`.error`).
- `LanguageModelUsage`: `{ inputTokens?: number; outputTokens?: number; ... }` (both may be `undefined`).
- `tool({ description, inputSchema: z.object(...), execute: async (input, { abortSignal, toolCallId }) => string })`.
- `prepareStep: ({ messages, stepNumber, steps }) => ({ messages })`. A returned `messages` override carries forward.
- `pruneMessages({ messages, toolCalls: "before-last-3-messages", reasoning?: "before-last-message", emptyMessages?: "remove" })`.
- Providers: `createAnthropic({ apiKey })("claude-sonnet-5-5")`, `createOpenAI({ apiKey })("gpt-6.2-sol")`,
  `createGateway({ apiKey })("anthropic/claude-sonnet-5.5")`, `gw.getAvailableModels()` → `{ models: [{ id, name, modelType?, ... }] }`.

## Model IDs (verified 2026-11-22)
- **Gateway IDs use dots**: `anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5`, `anthropic/claude-haiku-5.5`,
  `openai/gpt-6.2-sol`, `zai/glm-5.3`. (The public list is at https://ai-gateway.vercel.sh/v1/models.)
- Direct Anthropic uses dashes: `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`. Direct OpenAI: `gpt-6.2-sol`.
- When routing a bare `claude-x-5-5` to the gateway, convert the trailing `-N-M` to `.N.M`-style: `anthropic/claude-x-5.5`.

## More providers (added 2026-11-22)
- `createGoogleGenerativeAI({ apiKey })("gemini-4-neon")` from `@ai-sdk/google` (env `GEMINI_API_KEY`).
- Everything else is `createOpenAICompatible({ name, baseURL, apiKey, includeUsage: true })(id)` from `@ai-sdk/openai-compatible`.
  Verified live with tool calls against the gateway's own OpenAI-compatible endpoint (`https://ai-gateway.vercel.sh/v1`).
- xAI's models are listed under the `spacexai/` creator on the gateway (`spacexai/grok-4.7`).
- Live catalogs: gateway `getAvailableModels()`; Anthropic `GET /v1/models` (`x-api-key`, `anthropic-version`);
  Google `GET /v1beta/models` (`x-goog-api-key`); OpenAI and compatible `GET {baseURL}/models` (Bearer).
