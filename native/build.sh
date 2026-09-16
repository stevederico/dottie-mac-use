#!/usr/bin/env bash
# Build standalone dottie-mac-use-ax → ../bin/dottie-mac-use-ax
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/../bin/dottie-mac-use-ax"
mkdir -p "$(dirname "$OUT")"
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
  -o "$OUT"
chmod +x "$OUT"
echo "OK: $OUT"
file "$OUT"
