#!/usr/bin/env bash
# Build and package the VS Code extension into a .vsix.
#
# Usage: scripts/build-vsix.sh [--install] [--with-installs] [--skip-gui]
#   --install        Install the result with `code --install-extension <vsix> --force`
#   --with-installs  Let prepackage run `npm install` in gui/ and extensions/vscode
#                    (skipped by default; run scripts/install-dependencies.sh once first)
#   --skip-gui       Reuse the existing gui/dist instead of rebuilding the GUI
#
# Requires dependencies to be installed already (scripts/install-dependencies.sh).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$REPO_ROOT/extensions/vscode"

INSTALL=false
WITH_INSTALLS=false
SKIP_GUI=false
for arg in "$@"; do
    case "$arg" in
        --install) INSTALL=true ;;
        --with-installs) WITH_INSTALLS=true ;;
        --skip-gui) SKIP_GUI=true ;;
        -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

if [ ! -d "$EXT_DIR/node_modules" ] || [ ! -d "$REPO_ROOT/gui/node_modules" ]; then
    echo "Dependencies missing. Run scripts/install-dependencies.sh first." >&2
    exit 1
fi

# prepackage copies gui/dist into the extension but does not build it.
if [ "$SKIP_GUI" = false ]; then
    echo "==> Building GUI"
    (cd "$REPO_ROOT/gui" && NODE_OPTIONS="--max-old-space-size=4096" npm run build)
fi

echo "==> Packaging extension (npm run package: prepackage + esbuild + vsce)"
if [ "$WITH_INSTALLS" = true ]; then
    (cd "$EXT_DIR" && npm run package)
else
    (cd "$EXT_DIR" && SKIP_INSTALLS=true npm run package)
fi

NAME="$(node -p "require('$EXT_DIR/package.json').name")"
VSIX="$(ls -t "$EXT_DIR"/build/"$NAME"-*.vsix 2>/dev/null | head -n1 || true)"
if [ -z "$VSIX" ]; then
    echo "No .vsix found in $EXT_DIR/build" >&2
    exit 1
fi

echo
echo "VSIX: $VSIX"

if [ "$INSTALL" = true ]; then
    if ! command -v code >/dev/null 2>&1; then
        echo "'code' CLI not found on PATH; install manually: code --install-extension \"$VSIX\" --force" >&2
        exit 1
    fi
    echo "==> Installing into VS Code"
    code --install-extension "$VSIX" --force
    echo "Installed. Reload VS Code windows to pick up the new build."
fi
