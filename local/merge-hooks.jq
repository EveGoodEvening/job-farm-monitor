# merge-hooks.jq - idempotently merge (or remove) job-farm-monitor hook groups into a
# Claude Code settings.json or a Codex hooks.json. Both share the shape
#   { "hooks": { "<Event>": [ { "matcher"?: "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
#
# Usage:
#   jq --slurpfile frag local/claude.hooks.json --arg mode install   -f local/merge-hooks.jq settings.json
#   jq --slurpfile frag local/claude.hooks.json --arg mode uninstall -f local/merge-hooks.jq settings.json
#
# Every hook whose command contains "jfm-emit" is ours. Install removes our old hooks
# (dropping groups that become empty) and appends the fragment's groups at the end of
# each event, so re-running it is a no-op. Uninstall removes our hooks, and also event
# keys / the "hooks" object when only our entries had been in them, so install followed
# by uninstall restores the original document. Everything else is left untouched.

def is_jfm: type == "object" and ((.command // "") | tostring | contains("jfm-emit"));
def group_has_jfm: type == "object" and ((.hooks | type) == "array") and any(.hooks[]; is_jfm);

# Remove our hooks from one event's group list; groups that only held ours disappear.
def strip_groups:
  if type == "array" then
    map(if group_has_jfm then (.hooks |= map(select(is_jfm | not))) | select(.hooks | length > 0) else . end)
  else . end;

def strip_all($drop_empty):
  if (.hooks | type) == "object" then
    (.hooks | length) as $before
    | .hooks |= (
        to_entries
        | map(
            (.value | type == "array" and any(.[]; group_has_jfm)) as $had
            | .value |= strip_groups
            | select(($drop_empty and $had and (.value | length) == 0) | not)
          )
        | from_entries
      )
    | if $drop_empty and $before > 0 and (.hooks | length) == 0 then del(.hooks) else . end
  else . end;

if type != "object" then error("settings root is not a JSON object") else . end
| if $mode == "uninstall" then
    strip_all(true)
  elif $mode == "install" then
    ($frag[0].hooks) as $new
    | strip_all(false)
    | .hooks = (if (.hooks | type) == "object" then .hooks else {} end)
    | reduce ($new | keys_unsorted[]) as $ev (.;
        .hooks[$ev] = ((if (.hooks[$ev] | type) == "array" then .hooks[$ev] else [] end) + $new[$ev]))
  else
    error("mode must be install or uninstall")
  end
