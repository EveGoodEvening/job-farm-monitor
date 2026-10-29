#!/usr/bin/env bash
# install.sh - install / uninstall the job-farm-mon local reporters on this machine.
#
#   local/install.sh [--endpoint URL] [--token T] [--no-claude] [--no-codex] [--no-omp]
#   local/install.sh --uninstall [--purge] [--no-claude] [--no-codex] [--no-omp]
#
# Install:
#   - checks jq + curl
#   - writes ~/.config/job-farm-mon/config (0600); an existing file is kept, only the
#     keys passed on the command line are updated; on a tty missing values are asked for
#   - installs bin/jfm-emit to ~/.local/bin/jfm-emit
#   - merges claude.hooks.json into ~/.claude/settings.json and codex.hooks.json into
#     ~/.codex/hooks.json with merge-hooks.jq (backup <file>.bak-jfm, atomic replace,
#     idempotent; other hooks such as heavy-gate / herdr are preserved)
#   - copies omp/job-farm-mon.ts to ~/.omp/agent/extensions/
# Uninstall removes our hook entries, jfm-emit and the omp extension; --purge also
# deletes the config and the state directory (outbox, markers, log, records).
# Agents whose home directory (~/.claude, ~/.codex, ~/.omp) does not exist are skipped.
set -euo pipefail

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

endpoint=""
token=""
have_endpoint=0
have_token=0
uninstall=0
purge=0
do_claude=1
do_codex=1
do_omp=1

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "install.sh: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --endpoint) [[ $# -ge 2 ]] || die "--endpoint needs a value"; endpoint=$2; have_endpoint=1; shift 2 ;;
    --endpoint=*) endpoint=${1#*=}; have_endpoint=1; shift ;;
    --token) [[ $# -ge 2 ]] || die "--token needs a value"; token=$2; have_token=1; shift 2 ;;
    --token=*) token=${1#*=}; have_token=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --purge) purge=1; uninstall=1; shift ;;
    --no-claude) do_claude=0; shift ;;
    --no-codex) do_codex=0; shift ;;
    --no-omp) do_omp=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[[ -n ${HOME:-} ]] || die "HOME is not set"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/job-farm-mon"
CONFIG_FILE="$CONFIG_DIR/config"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/job-farm-mon"
BIN_DIR="$HOME/.local/bin"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CODEX_HOOKS="$HOME/.codex/hooks.json"
CODEX_CONFIG="$HOME/.codex/config.toml"
OMP_EXT_DIR="$HOME/.omp/agent/extensions"
OMP_EXT_SRC="$SRC_DIR/omp/job-farm-mon.ts"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "install.sh: '$1' is required but not installed." >&2
    echo "  Debian/Ubuntu: sudo apt install $1    macOS: brew install $1" >&2
    exit 1
  fi
}

# Resolve a symlinked config file so we replace the target, not the link (dotfiles repos).
# Plain `readlink` (no -f: BSD readlink before macOS 12.3 lacks it), one hop at a time,
# relative targets joined to the link's directory.
real_path() {
  local p=$1 t hops=0
  while [[ -L $p ]]; do
    t=$(readlink "$p") || die "cannot read symlink $p"
    case $t in
      /*) p=$t ;;
      *) p=$(dirname "$p")/$t ;;
    esac
    hops=$((hops + 1))
    [[ $hops -le 40 ]] || die "too many levels of symlinks: $1"
  done
  printf '%s\n' "$p"
}

# merge_json <file> <fragment> <install|uninstall> <default-json>
merge_json() {
  local file mode=$3 frag=$2 default=$4 tmp
  file=$(real_path "$1")
  if [[ ! -e $file ]]; then
    [[ $mode == install ]] || return 0
    mkdir -p "$(dirname "$file")"
    printf '%s\n' "$default" >"$file"
  fi
  [[ -s $file ]] || printf '%s\n' "$default" >"$file"
  jq -e 'type == "object"' "$file" >/dev/null 2>&1 || die "$file is not a JSON object; fix it first"
  tmp=$(mktemp "$file.jfm.XXXXXX")
  # cp -p keeps the original mode/ownership on the replacement.
  cp -p "$file" "$tmp"
  if ! jq --slurpfile frag "$frag" --arg mode "$mode" -f "$SRC_DIR/merge-hooks.jq" "$file" >"$tmp"; then
    rm -f "$tmp"
    die "could not merge $frag into $file"
  fi
  if jq -e --slurpfile a "$file" --slurpfile b "$tmp" -n '$a == $b' >/dev/null; then
    rm -f "$tmp"
    echo "  unchanged: $1"
    return 0
  fi
  cp -p "$file" "$file.bak-jfm"
  mv -f "$tmp" "$file"
  echo "  ${mode}ed hooks: $1 (backup: $file.bak-jfm)"
}

# --- config file ---------------------------------------------------------------------

config_get() {
  [[ -r $CONFIG_FILE ]] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1=//p" "$CONFIG_FILE" | tail -n 1 |
    sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/'
}

validate_value() {
  case $2 in
    *"'"* | *'"'* | *'\'* | *$'\n'* | *' '*) die "$1 must not contain quotes, backslashes, spaces or newlines" ;;
  esac
}

write_config() {
  local cur_endpoint cur_token
  cur_endpoint=$(config_get JFM_ENDPOINT)
  cur_token=$(config_get JFM_WRITE_TOKEN)
  if [[ -e $CONFIG_FILE && $have_endpoint == 0 && $have_token == 0 ]]; then
    chmod 600 "$CONFIG_FILE"
    echo "  kept existing config: $CONFIG_FILE"
    return 0
  fi
  [[ $have_endpoint == 1 ]] || endpoint=$cur_endpoint
  [[ $have_token == 1 ]] || token=$cur_token
  if [[ -t 0 ]]; then
    [[ -n $endpoint ]] || read -r -p "job-farm-mon endpoint (e.g. https://jfm.example.workers.dev): " endpoint
    [[ -n $token ]] || { read -r -s -p "write token for this host: " token; echo; }
  fi
  endpoint=${endpoint%/}
  validate_value endpoint "$endpoint"
  validate_value token "$token"

  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  local tmp
  tmp=$(mktemp "$CONFIG_DIR/.config.XXXXXX")
  chmod 600 "$tmp"
  if [[ -e $CONFIG_FILE ]]; then
    # Keep unrelated lines (JFM_REDACT, comments, ...), replace ours.
    grep -v -E '^[[:space:]]*(export[[:space:]]+)?(JFM_ENDPOINT|JFM_WRITE_TOKEN)=' "$CONFIG_FILE" >"$tmp" || true
  else
    {
      echo "# job-farm-mon reporter config (sh KEY=value; environment variables win)."
      echo "# Optional: JFM_REDACT=1 (send tool names only), JFM_DISABLE=1, JFM_RECORD_DIR=<dir>"
    } >"$tmp"
  fi
  {
    echo "JFM_ENDPOINT='$endpoint'"
    echo "JFM_WRITE_TOKEN='$token'"
  } >>"$tmp"
  mv -f "$tmp" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "  wrote config: $CONFIG_FILE (0600)"
  if [[ -z $endpoint || -z $token ]]; then
    echo "  WARNING: endpoint or token is empty; reporting stays off until you set both in $CONFIG_FILE" >&2
  fi
}

# --- install / uninstall ---------------------------------------------------------------

do_install() {
  need jq
  need curl
  echo "job-farm-mon: installing"
  write_config

  mkdir -p "$BIN_DIR"
  install -m 755 "$SRC_DIR/bin/jfm-emit" "$BIN_DIR/jfm-emit"
  echo "  installed: $BIN_DIR/jfm-emit"

  if [[ $do_claude == 1 ]]; then
    if [[ -d $HOME/.claude ]]; then
      merge_json "$CLAUDE_SETTINGS" "$SRC_DIR/claude.hooks.json" install '{}'
    else
      echo "  skipped Claude Code: ~/.claude not found"
    fi
  fi

  local codex_note=0
  if [[ $do_codex == 1 ]]; then
    if [[ -d $HOME/.codex ]]; then
      merge_json "$CODEX_HOOKS" "$SRC_DIR/codex.hooks.json" install '{"hooks":{}}'
      codex_note=1
      if ! grep -Eq '^[[:space:]]*(codex_)?hooks[[:space:]]*=[[:space:]]*true' "$CODEX_CONFIG" 2>/dev/null; then
        echo "  NOTE: enable Codex hooks in $CODEX_CONFIG:"
        echo "          [features]"
        echo "          hooks = true"
      fi
    else
      echo "  skipped Codex: ~/.codex not found"
    fi
  fi

  if [[ $do_omp == 1 ]]; then
    if [[ ! -d $HOME/.omp ]]; then
      echo "  skipped oh-my-pi: ~/.omp not found"
    elif [[ ! -f $OMP_EXT_SRC ]]; then
      echo "  skipped oh-my-pi: $OMP_EXT_SRC is missing" >&2
    else
      mkdir -p "$OMP_EXT_DIR"
      install -m 644 "$OMP_EXT_SRC" "$OMP_EXT_DIR/job-farm-mon.ts"
      echo "  installed: $OMP_EXT_DIR/job-farm-mon.ts"
    fi
  fi

  echo
  echo "Next steps:"
  [[ $codex_note == 1 ]] && echo "  - In Codex, run /hooks and trust the new job-farm-mon hooks (needed after every hooks.json change)."
  echo "  - Restart running Claude Code / Codex / oh-my-pi sessions so they load the hooks."
  echo "  - Verify the endpoint and token: $BIN_DIR/jfm-emit --check"
  case ":${PATH:-}:" in *":$BIN_DIR:"*) ;; *) echo "  - (optional) add $BIN_DIR to PATH; hooks use the full path." ;; esac
}

do_uninstall() {
  echo "job-farm-mon: uninstalling"
  if [[ $do_claude == 1 && -e $CLAUDE_SETTINGS ]]; then
    command -v jq >/dev/null 2>&1 || die "jq is required to edit $CLAUDE_SETTINGS"
    merge_json "$CLAUDE_SETTINGS" "$SRC_DIR/claude.hooks.json" uninstall '{}'
  fi
  if [[ $do_codex == 1 && -e $CODEX_HOOKS ]]; then
    command -v jq >/dev/null 2>&1 || die "jq is required to edit $CODEX_HOOKS"
    merge_json "$CODEX_HOOKS" "$SRC_DIR/codex.hooks.json" uninstall '{"hooks":{}}'
  fi
  if [[ $do_omp == 1 && -e $OMP_EXT_DIR/job-farm-mon.ts ]]; then
    rm -f "$OMP_EXT_DIR/job-farm-mon.ts"
    echo "  removed: $OMP_EXT_DIR/job-farm-mon.ts"
  fi
  if [[ -e $BIN_DIR/jfm-emit ]]; then
    rm -f "$BIN_DIR/jfm-emit"
    echo "  removed: $BIN_DIR/jfm-emit"
  fi
  if [[ $purge == 1 ]]; then
    rm -rf "$CONFIG_DIR" "$STATE_DIR"
    echo "  purged: $CONFIG_DIR $STATE_DIR"
  else
    echo "  kept config and state (use --purge to delete): $CONFIG_DIR $STATE_DIR"
  fi
}

if [[ $uninstall == 1 ]]; then
  do_uninstall
else
  do_install
fi
