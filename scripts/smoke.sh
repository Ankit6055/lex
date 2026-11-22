#!/usr/bin/env bash
# Clean-room smoke test: pack the package, install it into a throwaway prefix, and run it under Node.
# Usage: bash scripts/smoke.sh [--live]
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/lex-smoke.XXXXXX")"
trap 'rm -rf "$work"' EXIT
pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--live" ]; }; then
  fail "Usage: bash scripts/smoke.sh [--live]"
fi

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

# The live check uses a new project and an unpredictable value to verify a real read round trip.
if [ "${1:-}" = "--live" ]; then
  mkdir "$work/project" "$work/config"
  probe="lex-smoke-$(basename "$work")"
  printf '%s\n' "$probe" > "$work/project/probe.txt"
  if ! bun -e '
    const [lex, project, config] = process.argv.slice(1);
    const child = Bun.spawn([
      lex, "--readonly", "--max-steps", "4", "--cwd", project,
      "Use the read tool on probe.txt. Reply with exactly its contents, with no formatting.",
    ], {
      cwd: project, env: { ...process.env, LEX_HOME: config, NO_COLOR: "1" },
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
      timeout: 45_000,
    });
    process.exit(await child.exited);
  ' "$lex" "$work/project" "$work/config" > "$work/live.out" 2> "$work/live.err"; then
    cat "$work/live.err" >&2
    fail "live provider request failed"
  fi
  [ "$(cat "$work/live.out")" = "$probe" ] || fail "live provider returned an incorrect probe value"
  grep -Fq '● read probe.txt' "$work/live.err" || fail "live provider did not use the read tool"
  pass "live provider streamed the expected value after reading probe.txt"
fi

pass "smoke test passed"
