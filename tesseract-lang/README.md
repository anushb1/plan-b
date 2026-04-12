# Local Tesseract language data

Place `eng.traineddata` here so preview OCR can load language files from the same origin (no CDN).

Download (from project root):

```bash
mkdir -p tesseract-lang
curl -fsSL -o tesseract-lang/eng.traineddata \
  "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata"
```

If this file is missing, the app falls back to `https://tessdata.projectnaptha.com/4.0.0` (requires network).
