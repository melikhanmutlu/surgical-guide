#!/usr/bin/env bash
# gstack (github.com/garrytan/gstack) is not a plugin: it lives in
# ~/.claude/skills/gstack. Install it once per machine if it is missing.
# Never blocks the session: any failure is logged and the hook exits 0.
GS="$HOME/.claude/skills/gstack"
LOG="${TMPDIR:-/tmp}/gstack-install.log"
[ -d "$GS/bin" ] && exit 0
command -v git >/dev/null 2>&1 || exit 0
command -v bun >/dev/null 2>&1 || { echo "gstack: bun not found, skipped" >"$LOG"; exit 0; }
{
  git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git "$GS" &&
  cd "$GS" &&
  ./setup --no-browser --no-plan-tune-hooks --no-timeline-stop-hook --no-team -q </dev/null
} >"$LOG" 2>&1 || { echo "gstack install failed, see $LOG" >&2; rm -rf "$GS"; }
exit 0
