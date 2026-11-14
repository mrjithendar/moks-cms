#!/usr/bin/env bash
# Re-export the user guide's diagrams after editing them in draw.io (desktop app or app.diagrams.net).
# Sources: docs/guide/diagrams/<name>.drawio → public/guide/<name>.drawio.svg (the SVG embeds its diagram, so it can
# also be opened and edited in draw.io directly). Needs the draw.io desktop CLI (`brew install --cask drawio`).
set -euo pipefail
cd "$(dirname "$0")/.."
drawio="${DRAWIO:-$(command -v drawio || echo /Applications/draw.io.app/Contents/MacOS/draw.io)}"
for src in docs/guide/diagrams/*.drawio; do
  name="$(basename "$src" .drawio)"
  "$drawio" --export --format svg --embed-diagram --border 16 --output "public/guide/$name.drawio.svg" "$src"
done
