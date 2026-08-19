# Shared by every hook in .githooks/ — sourced, not executed.
#
# `core.hooksPath` REPLACES `.git/hooks`; it does not add to it. Pointing git at this directory would
# therefore silently switch OFF whatever each machine has installed there — this repo alone has a
# `pre-push` anti-drift gate for theme-tokens.json / assetVersion.generated.ts and graphify's
# `post-commit` / `post-checkout` graph refresh. Turning on a new gate must not turn off the old ones,
# so every hook here delegates to its local namesake first and only then adds its own check.
run_local_hook() {
  name="$1"
  shift
  git_dir=$(git rev-parse --git-dir 2>/dev/null) || return 0
  local_hook="$git_dir/hooks/$name"
  [ -f "$local_hook" ] || return 0
  case "$local_hook" in
    *.sample) return 0 ;;
  esac
  if [ -x "$local_hook" ]; then
    "$local_hook" "$@"
  else
    sh "$local_hook" "$@"
  fi
}
