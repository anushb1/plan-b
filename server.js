require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Consumer API keys often 404 on v1 / gemini-1.5-flash. Try v1beta Flash models in order.
 */
const GEMINI_GENERATE_URLS = [
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
];

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "camera-intent-app")));

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
