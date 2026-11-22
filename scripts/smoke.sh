#!/usr/bin/env bash
# Clean-room smoke test: pack the package, install it into a throwaway prefix, and run it under Node.
# Usage: bash scripts/smoke.sh          (the live prompt runs only if a provider key is available)
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/lex-smoke.XXXXXX")"
trap 'rm -rf "$work"' EXIT
pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

command -v node >/dev/null || fail "node is not installed"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || fail "Node >= 22 required (found $(node --version))"
pass "node $(node --version)"

cd "$repo"
bun run build >/dev/null
tarball="$(npm pack --silent --pack-destination "$work" | tail -1)"
pass "packed $tarball ($(du -h "$work/$tarball" | cut -f1 | tr -d ' '))"

npm install --silent --global --prefix "$work/prefix" "$work/$tarball" >/dev/null
lex="$work/prefix/bin/lex"
[ -x "$lex" ] || fail "lex binary not installed"
pass "installed into a clean prefix"

version="$("$lex" --version)"
[ "$version" = "$(node -p 'require("./package.json").version')" ] || fail "--version printed '$version'"
pass "lex --version → $version"

"$lex" --help | grep -q "Providers" || fail "--help is missing the providers section"
pass "lex --help"

# Live prompt (read-only, in a throwaway copy of the toy repo). Needs a key from the env or .env.local.
if [ -z "${AI_GATEWAY_API_KEY:-}${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}" ] && [ -f "$repo/.env.local" ]; then
  set -a; . "$repo/.env.local"; set +a
fi
if [ -n "${AI_GATEWAY_API_KEY:-}${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}" ]; then
  cp -R "$repo/examples/toy-repo" "$work/toy"
  out="$(cd "$work/toy" && "$lex" --readonly --max-steps 6 "How many test files are in the test/ directory? Answer with just the number." 2>&1)" \
    || fail "one-shot prompt failed: $out"
  echo "$out" | grep -q "2" || fail "unexpected answer: $out"
  pass "one-shot prompt against examples/toy-repo ($(echo "$out" | tail -1))"
else
  printf '\033[33m- skipped live prompt (no API key set)\033[0m\n'
fi

pass "smoke test passed"
