#!/usr/bin/env bash
# install.sh - install / uninstall the job-farm-monitor local reporters on this machine.
#
#   local/install.sh [--endpoint URL] [--token T] [--no-claude] [--no-codex] [--no-omp]
#   local/install.sh --uninstall [--purge] [--no-claude] [--no-codex] [--no-omp]
#
# Install:
#   - checks jq + curl
#   - writes ~/.config/job-farm-monitor/config (0600); an existing file is kept, only the
#     keys passed on the command line are updated; on a tty missing values are asked for
#   - installs bin/jfm-emit to ~/.local/bin/jfm-emit
#   - merges claude.hooks.json into ~/.claude/settings.json and codex.hooks.json into
#     ~/.codex/hooks.json with merge-hooks.jq (backup <file>.bak-jfm, atomic replace,
#     idempotent; other hooks such as heavy-gate / herdr are preserved)
#   - copies omp/job-farm-monitor.ts to ~/.omp/agent/extensions/
#   - migrates an install from the old name "job-farm-mon" (after all input is
#     validated): the config and state directories are moved to the new name and a
#     compatibility symlink job-farm-mon -> job-farm-monitor is left so reporters that
#     are still running keep working; when both names exist, queued events are moved and
#     the old directory is renamed to job-farm-mon.migrated-<time>; the old omp
#     extension job-farm-mon.ts is replaced
# Uninstall removes our hook entries, jfm-emit and the omp extension (old name too);
# --purge also deletes the config and the state directory (outbox, markers, log,
# records), including leftover job-farm-mon* directories.
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
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/job-farm-monitor"
CONFIG_FILE="$CONFIG_DIR/config"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/job-farm-monitor"
BIN_DIR="$HOME/.local/bin"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CODEX_HOOKS="$HOME/.codex/hooks.json"
CODEX_CONFIG="$HOME/.codex/config.toml"
OMP_EXT_DIR="$HOME/.omp/agent/extensions"
OMP_EXT_SRC="$SRC_DIR/omp/job-farm-monitor.ts"
# Pre-rename locations ("job-farm-mon"), migrated on install and removed on uninstall.
LEGACY_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/job-farm-mon"
LEGACY_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/job-farm-mon"
LEGACY_OMP_EXT="$OMP_EXT_DIR/job-farm-mon.ts"

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

# The config the install starts from: the current one, or the legacy one that
# migrate_legacy is about to move into place. Set by resolve_config.
CONFIG_SRC=""

config_get() {
  [[ -n $CONFIG_SRC && -r $CONFIG_SRC ]] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1=//p" "$CONFIG_SRC" | tail -n 1 |
    sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/'
}

validate_value() {
  case $2 in
    *"'"* | *'"'* | *'\'* | *$'\n'* | *' '*) die "$1 must not contain quotes, backslashes, spaces or newlines" ;;
  esac
}

# resolve_config: works out endpoint/token and validates them without changing anything
# on disk, so a bad value aborts the install before the migration moves files.
keep_config=0
resolve_config() {
  local cur_endpoint cur_token
  if [[ -e $CONFIG_FILE ]]; then
    CONFIG_SRC=$CONFIG_FILE
  elif [[ ! -e $CONFIG_DIR && ! -L $CONFIG_DIR && ! -L $LEGACY_CONFIG_DIR && -e $LEGACY_CONFIG_DIR/config ]]; then
    CONFIG_SRC=$LEGACY_CONFIG_DIR/config
  fi
  if [[ -n $CONFIG_SRC && $have_endpoint == 0 && $have_token == 0 ]]; then
    keep_config=1
    return 0
  fi
  cur_endpoint=$(config_get JFM_ENDPOINT)
  cur_token=$(config_get JFM_WRITE_TOKEN)
  [[ $have_endpoint == 1 ]] || endpoint=$cur_endpoint
  [[ $have_token == 1 ]] || token=$cur_token
  if [[ -t 0 ]]; then
    [[ -n $endpoint ]] || read -r -p "job-farm-monitor endpoint (e.g. https://jfm.example.workers.dev): " endpoint
    [[ -n $token ]] || { read -r -s -p "write token for this host: " token; echo; }
  fi
  endpoint=${endpoint%/}
  validate_value endpoint "$endpoint"
  validate_value token "$token"
}

write_config() {
  if [[ $keep_config == 1 && -e $CONFIG_FILE ]]; then
    chmod 600 "$CONFIG_FILE"
    echo "  kept existing config: $CONFIG_FILE"
    return 0
  fi
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
      echo "# job-farm-monitor reporter config (sh KEY=value; environment variables win)."
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

# --- migration from the old name (job-farm-mon) ------------------------------------------

# compat_link <legacy> <new>: the legacy dirs live next to the new ones, so the
# compatibility symlink is relative.
compat_link() {
  if ln -s "${2##*/}" "$1" 2>/dev/null; then
    echo "  linked: $1 -> ${2##*/} (for reporters still running)"
  fi
}

# set_aside <legacy-dir>: renames a legacy dir that lost to an existing new one, so later
# installs do not report it again (sets aside=<new path>).
set_aside() {
  aside="$1.migrated-$(date +%Y%m%d%H%M%S)"
  mv "$1" "$aside"
}

# migrate_dir <legacy> <new>: sets migrated=moved|both|none. A legacy path that is
# already our compatibility symlink counts as migrated.
migrate_dir() {
  migrated=none
  if [[ -L $1 ]]; then
    case $(readlink "$1") in "${2##*/}" | "$2") return 0 ;; esac
  fi
  [[ -d $1 ]] || return 0
  if [[ -e $2 || -L $2 ]]; then
    migrated=both
    return 0
  fi
  mkdir -p "$(dirname "$2")"
  mv "$1" "$2"
  migrated=moved
  echo "  migrated: $1 -> $2"
  compat_link "$1" "$2"
}

# lock_alive <state-dir>: the dir holds a flush lock whose owner is still running.
lock_alive() {
  local pid=
  [[ -f $1/lock.d/pid ]] || return 1
  read -r pid <"$1/lock.d/pid" || :
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null
}

will_install_omp() {
  [[ $do_omp == 1 && -d $HOME/.omp && -f $OMP_EXT_SRC ]]
}

migrate_legacy() {
  local migrated aside f n=0
  migrate_dir "$LEGACY_CONFIG_DIR" "$CONFIG_DIR"
  if [[ $migrated == moved ]]; then
    chmod 700 "$CONFIG_DIR"
    [[ ! -e $CONFIG_FILE ]] || chmod 600 "$CONFIG_FILE"
  elif [[ $migrated == both ]]; then
    set_aside "$LEGACY_CONFIG_DIR"
    compat_link "$LEGACY_CONFIG_DIR" "$CONFIG_DIR"
    echo "  NOTE: both $LEGACY_CONFIG_DIR and $CONFIG_DIR existed; using $CONFIG_DIR."
    echo "        The old config is now $aside; it may hold a write token, delete it when done."
  fi

  migrate_dir "$LEGACY_STATE_DIR" "$STATE_DIR"
  if [[ $migrated == moved ]]; then
    # A flusher that was running in the old directory keeps working on the moved outbox
    # (it has cd'ed into it; its absolute paths go through the symlink) and its lock
    # ages out on its own. A lock whose owner is gone is dropped now so the next flush
    # does not wait for the stale-lock timeout.
    lock_alive "$STATE_DIR" || rm -rf "$STATE_DIR/lock.d" "$STATE_DIR/lock.steal.d"
  elif [[ $migrated == both ]]; then
    # Keep pending events: move queued envelopes the new outbox does not have yet.
    if [[ -d $LEGACY_STATE_DIR/outbox ]]; then
      mkdir -p "$STATE_DIR/outbox"
      for f in "$LEGACY_STATE_DIR"/outbox/[0-9]*.json; do
        [[ -f $f && ! -e $STATE_DIR/outbox/${f##*/} ]] || continue
        mv "$f" "$STATE_DIR/outbox/" && n=$((n + 1))
      done
      [[ $n == 0 ]] || echo "  migrated: $n queued event file(s) from $LEGACY_STATE_DIR/outbox"
    fi
    if lock_alive "$LEGACY_STATE_DIR"; then
      echo "  NOTE: a flush is still running in $LEGACY_STATE_DIR; run the install again later to finish the migration"
    else
      set_aside "$LEGACY_STATE_DIR"
      compat_link "$LEGACY_STATE_DIR" "$STATE_DIR"
      echo "  NOTE: both $LEGACY_STATE_DIR and $STATE_DIR existed; the rest of the old state is now $aside"
    fi
  fi

  if [[ -e $LEGACY_OMP_EXT ]] && ! will_install_omp; then
    echo "  NOTE: the old oh-my-pi extension $LEGACY_OMP_EXT is still installed; it keeps"
    echo "        reporting through the job-farm-mon symlinks. Install without --no-omp to replace it."
  fi
}

# check_json_object <file>: the merge_json precondition, checked before anything changes.
check_json_object() {
  local file
  file=$(real_path "$1")
  [[ -s $file ]] || return 0
  jq -e 'type == "object"' "$file" >/dev/null 2>&1 || die "$file is not a JSON object; fix it first"
}

# --- install / uninstall ---------------------------------------------------------------

do_install() {
  need jq
  need curl
  echo "job-farm-monitor: installing"
  # Validate everything that can abort the install before the migration moves files.
  resolve_config
  [[ $do_claude == 0 || ! -d $HOME/.claude ]] || check_json_object "$CLAUDE_SETTINGS"
  [[ $do_codex == 0 || ! -d $HOME/.codex ]] || check_json_object "$CODEX_HOOKS"
  [[ -f $SRC_DIR/bin/jfm-emit ]] || die "$SRC_DIR/bin/jfm-emit is missing"
  migrate_legacy
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
      install -m 644 "$OMP_EXT_SRC" "$OMP_EXT_DIR/job-farm-monitor.ts"
      echo "  installed: $OMP_EXT_DIR/job-farm-monitor.ts"
      # oh-my-pi loads every extension in the directory: the old copy would double-report.
      if [[ -e $LEGACY_OMP_EXT ]]; then
        rm -f "$LEGACY_OMP_EXT"
        echo "  removed old extension: $LEGACY_OMP_EXT"
      fi
    fi
  fi

  echo
  echo "Next steps:"
  [[ $codex_note == 1 ]] && echo "  - In Codex, run /hooks and trust the new job-farm-monitor hooks (needed after every hooks.json change)."
  echo "  - Restart running Claude Code / Codex / oh-my-pi sessions so they load the hooks."
  echo "  - Verify the endpoint and token: $BIN_DIR/jfm-emit --check"
  case ":${PATH:-}:" in *":$BIN_DIR:"*) ;; *) echo "  - (optional) add $BIN_DIR to PATH; hooks use the full path." ;; esac
}

do_uninstall() {
  echo "job-farm-monitor: uninstalling"
  if [[ $do_claude == 1 && -e $CLAUDE_SETTINGS ]]; then
    command -v jq >/dev/null 2>&1 || die "jq is required to edit $CLAUDE_SETTINGS"
    merge_json "$CLAUDE_SETTINGS" "$SRC_DIR/claude.hooks.json" uninstall '{}'
  fi
  if [[ $do_codex == 1 && -e $CODEX_HOOKS ]]; then
    command -v jq >/dev/null 2>&1 || die "jq is required to edit $CODEX_HOOKS"
    merge_json "$CODEX_HOOKS" "$SRC_DIR/codex.hooks.json" uninstall '{"hooks":{}}'
  fi
  if [[ $do_omp == 1 && -e $OMP_EXT_DIR/job-farm-monitor.ts ]]; then
    rm -f "$OMP_EXT_DIR/job-farm-monitor.ts"
    echo "  removed: $OMP_EXT_DIR/job-farm-monitor.ts"
  fi
  if [[ $do_omp == 1 && -e $LEGACY_OMP_EXT ]]; then
    rm -f "$LEGACY_OMP_EXT"
    echo "  removed: $LEGACY_OMP_EXT"
  fi
  if [[ -e $BIN_DIR/jfm-emit ]]; then
    rm -f "$BIN_DIR/jfm-emit"
    echo "  removed: $BIN_DIR/jfm-emit"
  fi
  local d legacy=()
  for d in "$LEGACY_CONFIG_DIR" "$LEGACY_CONFIG_DIR".migrated-* "$LEGACY_STATE_DIR" "$LEGACY_STATE_DIR".migrated-*; do
    [[ -e $d || -L $d ]] || continue
    if [[ -L $d ]]; then
      # Compatibility symlink: nothing needs it once jfm-emit and the old extension are gone.
      rm -f "$d"
      echo "  removed: $d"
    else
      legacy+=("$d")
    fi
  done
  if [[ $purge == 1 ]]; then
    rm -rf "$CONFIG_DIR" "$STATE_DIR"
    echo "  purged: $CONFIG_DIR $STATE_DIR"
    for d in ${legacy[@]+"${legacy[@]}"}; do
      rm -rf "$d"
      echo "  purged: $d"
    done
  else
    echo "  kept config and state (use --purge to delete): $CONFIG_DIR $STATE_DIR${legacy[*]+ ${legacy[*]}}"
  fi
}

if [[ $uninstall == 1 ]]; then
  do_uninstall
else
  do_install
fi
