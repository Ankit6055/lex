# toy-repo

A tiny project for trying lex: one bug in `add` (it breaks two tests), and a `createUser` with no input validation.

```bash
cd examples/toy-repo
lex "fix the failing test"
lex compare --models gateway:anthropic/claude-sonnet-5.5,gateway:openai/gpt-6.2-sol "add input validation to createUser"
```
