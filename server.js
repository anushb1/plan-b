require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Consumer API keys often 404 on some model names. Try multimodal models in order.
 *
 * Preview OCR: Tesseract.js from /vendor/*. “Examine text” uses POST /analyze-image → Gemini (key in .env only).
 */
const GEMINI_GENERATE_URLS = [
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
];

/** Prefer Pro for structured boxes when available; fall back to Flash. */
const GEMINI_ANALYZE_IMAGE_URLS = [
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
];

app.use(cors());
app.use(express.json({ limit: "20mb" }));

app.use((req, res, next) => {
  if (req.method === "GET") {
    const p = req.path || "";
    if (p === "/" || /\.html$/i.test(p)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    }
  }
  next();
});

app.use("/vendor/tesseract", express.static(path.join(__dirname, "node_modules/tesseract.js/dist")));
/** WASM core loader + .wasm assets (e.g. GET /vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js → 200) */
app.use("/vendor/tesseract-core", express.static(path.join(__dirname, "node_modules/tesseract.js-core")));
app.use("/vendor/tesseract-lang", express.static(path.join(__dirname, "tesseract-lang")));
app.use(express.static(path.join(__dirname, "camera-intent-app")));

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function parseJsonFromModelText(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeAnalyzeImagePayload(parsed) {
  const texts = [];
  if (parsed && Array.isArray(parsed.texts)) {
    for (const t of parsed.texts.slice(0, 24)) {
      if (!t || typeof t !== "object") continue;
      const text = String(t.text != null ? t.text : "").trim();
      const box = t.box;
      if (!Array.isArray(box) || box.length < 4) continue;
      let x = clamp01(box[0]);
      let y = clamp01(box[1]);
      let w = clamp01(box[2]);
      let h = clamp01(box[3]);
      if (w <= 0.002 || h <= 0.002) continue;
      x = Math.max(0, Math.min(1 - w, x));
      y = Math.max(0, Math.min(1 - h, y));
      texts.push({ text, box: [x, y, w, h] });
    }
  }
  let intents = [];
  if (parsed && Array.isArray(parsed.intents)) {
    intents = parsed.intents
      .map((s) => String(s != null ? s : "").trim())
      .filter(Boolean)
      .slice(0, 3);
  }
  return { texts, intents };
}

const ANALYZE_IMAGE_PROMPT = `Analyze this image and return JSON only.

Detect text regions and suggest useful actions.

Format:
{
  "texts": [{ "text": "...", "box": [x, y, w, h] }],
  "intents": ["Copy text", "Add to calendar", "Create list"]
}

Rules:
- box is normalized (0–1): x,y top-left of region; w,h width and height relative to image.
- intents: at most 3 items (UI prefers showing 2 when fewer are needed). Use short labels (2–3 words each), same spirit as the example.
- No explanation text outside the JSON object.`;

app.post("/analyze-image", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return res.status(500).json({
      error: { message: "Server misconfiguration: GEMINI_API_KEY is not set." },
    });
  }

  const body = req.body;
  let b64 =
    body && typeof body.imageBase64 === "string"
      ? body.imageBase64.trim()
      : body && typeof body.image_base64 === "string"
        ? body.image_base64.trim()
        : "";
  if (b64.includes(",")) b64 = b64.split(",").pop() || "";
  if (!b64) {
    return res.status(400).json({ error: { message: "Expected JSON body with imageBase64 (JPEG/PNG base64)." } });
  }

  const key = encodeURIComponent(apiKey.trim());
  const geminiBody = {
    contents: [
      {
        parts: [
          { text: ANALYZE_IMAGE_PROMPT },
          { inline_data: { mime_type: "image/jpeg", data: b64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  };
  const payload = JSON.stringify(geminiBody);

  try {
    let lastStatus = 502;
    let lastErr = { error: { message: "No Gemini model responded successfully." } };

    for (const baseUrl of GEMINI_ANALYZE_IMAGE_URLS) {
      const url = `${baseUrl}?key=${key}`;
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const data = await upstream.json().catch(() => ({}));
      lastStatus = upstream.status;

      if (!upstream.ok) {
        const msg = (data && data.error && data.error.message) || "";
        const isNotFound =
          upstream.status === 404 || /not found/i.test(msg) || /\b404\b/.test(msg);
        lastErr = data && data.error ? data : { error: { message: msg || upstream.statusText } };
        if (!isNotFound) {
          return res.status(upstream.status).json(lastErr);
        }
        continue;
      }

      const part =
        data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0];
      const txt = part && part.text ? part.text : "";
      const parsed = typeof txt === "string" && txt.trim() ? parseJsonFromModelText(txt) : null;
      if (!parsed || typeof parsed !== "object") {
        lastErr = { error: { message: "Invalid or empty JSON from Gemini." } };
        continue;
      }

      const out = normalizeAnalyzeImagePayload(parsed);
      return res.status(200).json(out);
    }

    res.status(lastStatus).json(lastErr);
  } catch (err) {
    res.status(502).json({
      error: { message: err && err.message ? err.message : "Failed to reach Gemini." },
    });
  }
});

app.post("/analyze", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return res.status(500).json({
      error: { message: "Server misconfiguration: GEMINI_API_KEY is not set." },
    });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || !Array.isArray(body.contents)) {
    return res.status(400).json({
      error: { message: "Expected JSON body with a contents array (Gemini generateContent shape)." },
    });
  }

  const key = encodeURIComponent(apiKey.trim());
  const payload = JSON.stringify(body);

  try {
    let lastStatus = 404;
    let lastData = { error: { message: "No Gemini model endpoint responded successfully." } };

    for (const baseUrl of GEMINI_GENERATE_URLS) {
      const url = `${baseUrl}?key=${key}`;
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const data = await upstream.json().catch(() => ({}));
      lastStatus = upstream.status;
      lastData = data;

      if (upstream.ok) {
        return res.status(upstream.status).json(data);
      }

      const msg = (data && data.error && data.error.message) || "";
      const isNotFound =
        upstream.status === 404 || /not found/i.test(msg) || /\b404\b/.test(msg);
      if (!isNotFound) {
        return res.status(upstream.status).json(data);
      }
    }

    res.status(lastStatus).json(lastData);
  } catch (err) {
    res.status(502).json({
      error: { message: err && err.message ? err.message : "Failed to reach Gemini." },
    });
  }
});

app.listen(PORT, () => {
  console.log(`Camera intent app: http://localhost:${PORT}/`);
});
