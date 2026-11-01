#!/bin/zsh
# Installs the Feed Fixer bridge as a macOS LaunchAgent: starts at login, restarts if it dies.
# Usage: scripts/install-bridge.sh [uninstall]
set -euo pipefail

LABEL=com.feedfixer.bridge
PLIST=~/Library/LaunchAgents/$LABEL.plist
ROOT=${0:A:h:h}
LOG=~/Library/Logs/feed-bridge.log

launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
if [[ ${1:-} == uninstall ]]; then
  rm -f $PLIST
  echo "uninstalled $LABEL"
  exit 0
fi

NODE=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }
CLAUDE=$(command -v claude) || { echo "claude not found on PATH" >&2; exit 1; }

cat > $PLIST <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$ROOT/bridge/server.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${CLAUDE:h}:${NODE:h}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootstrap gui/$(id -u) $PLIST
echo "installed $LABEL (logs: $LOG)"
