#!/usr/bin/env bash
# Smoke-tests the built extension (build/extension) in a throwaway headless
# GNOME Shell. The nested shell gets its own session bus, dconf database and
# data dirs, so your real desktop settings are not touched.
#
# The extension runs in dry-run mode, so logind never powers anything off.
# The scheduled shutdowns are real logind dry runs on the system bus, so the
# test refuses to start if a shutdown is already scheduled.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_BUILD="$ROOT/build/extension"
OUT="$ROOT/build/test-output"

if [ ! -f "$EXT_BUILD/metadata.json" ]; then
    echo "Run ./scripts/build-deb.sh first." >&2
    exit 1
fi

scheduled="$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
    org.freedesktop.login1.Manager ScheduledShutdown)"
if [ "$scheduled" != '(st) "" 18446744073709551615' ]; then
    echo "A shutdown is already scheduled ($scheduled); not running the test." >&2
    exit 1
fi

UUID="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["uuid"])' "$EXT_BUILD/metadata.json")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/auto-shutdown-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$OUT"
mkdir -p "$OUT" "$WORK"/{config,cache,state} "$WORK/data/gnome-shell/extensions"
cp -r "$EXT_BUILD" "$WORK/data/gnome-shell/extensions/$UUID"

# Helper extension: turns on unsafe mode so the test can use Eval/Screenshot.
HELPER="$WORK/data/gnome-shell/extensions/test-helper@auto-shutdown"
mkdir -p "$HELPER"
cat > "$HELPER/metadata.json" <<'EOF'
{"uuid": "test-helper@auto-shutdown", "name": "Test helper", "description": "Enables unsafe mode", "shell-version": ["48", "49", "50", "51"]}
EOF
cat > "$HELPER/extension.js" <<'EOF'
export default class {
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
EOF

export XDG_CONFIG_HOME="$WORK/config"
export XDG_DATA_HOME="$WORK/data"
export XDG_CACHE_HOME="$WORK/cache"
export XDG_STATE_HOME="$WORK/state"
export AUTO_SHUTDOWN_UUID="$UUID"
export AUTO_SHUTDOWN_EXT_DIR="$WORK/data/gnome-shell/extensions/$UUID"
export AUTO_SHUTDOWN_OUT="$OUT"
# Set by `make screenshots` to refresh the README images.
export AUTO_SHUTDOWN_DOCS_DIR="${AUTO_SHUTDOWN_DOCS_DIR:-}"

dbus-run-session -- python3 -I "$ROOT/scripts/test_headless.py"
