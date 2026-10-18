# Shared helpers for the global git hooks. Sourced, not executed.
# Hook output deliberately never prints the blocked term itself, so it doesn't
# leak into terminal logs or an AI assistant's context.

TERMS_FILE="${GIT_BLOCKED_TERMS_FILE:-$HOME/.config/git/blocked-terms.txt}"

fail() { printf '\n[blocked-terms] %s\n\n' "$*" >&2; exit 1; }

# Clean the term list (strip comments, blanks, CRLF) into $PATTERNS. Fails closed.
load_terms() {
  [ -f "$TERMS_FILE" ] || fail "Term list not found: $TERMS_FILE - refusing until it exists."
  PATTERNS=$(mktemp) || fail "mktemp failed"
  trap 'rm -f "$PATTERNS"' EXIT
  sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^#/d' -e '/^$/d' \
    "$TERMS_FILE" > "$PATTERNS"
  [ -s "$PATTERNS" ] || fail "Term list is empty: $TERMS_FILE - add at least one term."
}

# Case-insensitive fixed-string match of stdin against the term list.
matches() { grep -q -i -F -f "$PATTERNS"; }

# A global core.hooksPath stops git running the repo's own .git/hooks, so chain to it.
local_hook() {
  h="$(git rev-parse --git-common-dir)/hooks/$1"
  [ -f "$h" ] && [ -x "$h" ] && printf '%s' "$h"
}
