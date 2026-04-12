#!/usr/bin/env bash
# Static bundle for GitHub Pages at repo root (camera-intent-app + Tesseract vendor).
set -euo pipefail

ROOT="${GITHUB_WORKSPACE:-$(pwd)}"
SRC="${ROOT}"
DEST="$ROOT/_site"

mkdir -p "$DEST"
cd "$SRC"

npm install
npm install tesseract.js@5.1.1 --no-save

cp -a camera-intent-app/. "$DEST/"

mkdir -p "$DEST/vendor/tesseract" "$DEST/vendor/tesseract-core" "$DEST/vendor/tesseract-lang"
cp -r node_modules/tesseract.js/dist/. "$DEST/vendor/tesseract/"
cp -r node_modules/tesseract.js-core/. "$DEST/vendor/tesseract-core/"
if [[ -d tesseract-lang ]]; then
  cp -r tesseract-lang/. "$DEST/vendor/tesseract-lang/"
fi

perl -i -pe \
  's{"/vendor/}{"./vendor/}g; s{\047/vendor/}{\047./vendor/}g; s{/test-ocr\.png}{./test-ocr.png}g; s{fetch\("/analyze"}{fetch("./analyze"}g' \
  "$DEST/index.html"

echo "Built static site at $DEST"
