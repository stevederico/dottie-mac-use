#!/usr/bin/env bash
# Build standalone dottie-mac-use-ax → bin/ (and native/.build/ cache).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$ROOT/.." && pwd)"
OUT_BUILD="$ROOT/.build/dottie-mac-use-ax"
OUT_BIN="${1:-$PKG/bin/dottie-mac-use-ax}"
mkdir -p "$(dirname "$OUT_BUILD")" "$(dirname "$OUT_BIN")"
SOURCES=(
  "$ROOT/Sources/Stubs.swift"
  "$ROOT/Sources/AXTreeReader.swift"
  "$ROOT/Sources/AXActionExecutor.swift"
  "$ROOT/Sources/CalendarReader.swift"
  "$ROOT/Sources/MacUseService.swift"
  "$ROOT/Sources/main.swift"
)
echo "Building dottie-mac-use-ax..."
swiftc -O -parse-as-library \
  -framework Foundation -framework Network -framework AppKit \
  -framework ApplicationServices -framework EventKit -framework CoreGraphics \
  -framework Security \
  "${SOURCES[@]}" \
  -o "$OUT_BUILD"
chmod +x "$OUT_BUILD"
cp -a "$OUT_BUILD" "$OUT_BIN"
chmod +x "$OUT_BIN"
echo "OK: $OUT_BIN"
file "$OUT_BIN"
