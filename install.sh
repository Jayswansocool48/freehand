#!/usr/bin/env bash
# Freehand installer for Linux (Bazzite, Fedora, Ubuntu, Pop!_OS, ...). Installs the AppImage per-user; no root needed.
#   ./install.sh install [path/to/freehand-x.y.z.AppImage]
#   ./install.sh update  [path/to/new.AppImage]
#   ./install.sh --uninstall
#   ./install.sh --check
set -euo pipefail

APP_DIR="${FREEHAND_APP_DIR:-$HOME/.local/share/freehand}"
BIN_DIR="${FREEHAND_BIN_DIR:-$HOME/.local/bin}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
TARGET="$APP_DIR/Freehand.AppImage"
DESKTOP_FILE="$DESKTOP_DIR/freehand.desktop"
ICON_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps/freehand.png"

find_appimage() {
  local given="${1:-}"
  if [[ -n "$given" ]]; then echo "$given"; return; fi
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ls -t "$here"/dist/[Ff]reehand-*.AppImage "$here"/[Ff]reehand-*.AppImage 2>/dev/null | head -n1 || true
}

install_app() {
  local src; src="$(find_appimage "${1:-}")"
  [[ -n "$src" && -f "$src" ]] || { echo "No AppImage found. Build one with 'npm run dist:linux' or pass its path." >&2; exit 1; }
  mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR"
  install -m 0755 "$src" "$TARGET"
  ln -sf "$TARGET" "$BIN_DIR/freehand"
  install_icon "$src"
  cat > "$DESKTOP_FILE" <<DESK
[Desktop Entry]
Type=Application
Name=Freehand
Comment=Autonomous AI agent on free models
Exec=$TARGET %U
Icon=freehand
StartupWMClass=Freehand
Terminal=false
Categories=Utility;Development;
DESK
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  echo "Installed to $TARGET (run 'freehand' or find it in your app menu)."
}

# The icon comes from the repo when there is one, otherwise from inside the AppImage.
install_icon() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  mkdir -p "$(dirname "$ICON_FILE")"
  if [[ -f "$here/build/icon.png" ]]; then cp "$here/build/icon.png" "$ICON_FILE"; return; fi
  local tmp; tmp="$(mktemp -d)"
  (cd "$tmp" && "$TARGET" --appimage-extract '*.png' >/dev/null 2>&1) || true
  local png; png="$(ls -S "$tmp"/squashfs-root/*.png 2>/dev/null | head -n1 || true)"
  [[ -n "$png" ]] && cp "$png" "$ICON_FILE"
  rm -rf "$tmp"
}

uninstall_app() {
  rm -f "$TARGET" "$BIN_DIR/freehand" "$DESKTOP_FILE" "$ICON_FILE"
  rmdir "$APP_DIR" 2>/dev/null || true
  echo "Removed Freehand. Your tasks and settings are kept in ~/.config/freehand-agent (delete it to remove them)."
}

check_app() {
  local ok=0
  [[ -x "$TARGET" ]] && echo "[ok] app installed: $TARGET" || { echo "[--] app not installed"; ok=1; }
  if command -v ollama >/dev/null 2>&1; then
    echo "[ok] ollama found: $(ollama --version 2>/dev/null | head -n1)"
    curl -fsS --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1 && echo "[ok] ollama is running" || echo "[--] ollama is not running (start with: ollama serve)"
  else
    echo "[--] ollama not found (optional; free cloud providers work without it)"
  fi
  for b in google-chrome chromium chromium-browser microsoft-edge; do command -v "$b" >/dev/null 2>&1 && { echo "[ok] browser for the agent: $b"; break; }; done
  command -v python3 >/dev/null 2>&1 && echo "[ok] python3 found" || echo "[--] python3 not found (the agent's python tool needs it)"
  [[ -e /usr/lib64/libfuse.so.2 || -e /usr/lib/libfuse.so.2 || -e /lib/x86_64-linux-gnu/libfuse.so.2 ]] && echo "[ok] libfuse2 present (AppImages can run)" || echo "[--] libfuse2 not found; AppImages may need: --appimage-extract-and-run"
  return $ok
}

case "${1:-}" in
  install) shift; install_app "${1:-}";;
  update)  shift; install_app "${1:-}";;
  --uninstall) uninstall_app;;
  --check) check_app;;
  *) echo "Usage: $0 {install [AppImage]|update [AppImage]|--uninstall|--check}" >&2; exit 2;;
esac
