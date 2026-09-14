import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const YOINKU_API_KEY = process.env.YOINKU_API_KEY || "";
const YOINKU_BASE = "https://yoinku.com/api/v1";
const COBALT_URL = process.env.COBALT_URL || "https://cobalt-production-22d5.up.railway.app";
const COBALT_API_KEY = process.env.COBALT_API_KEY || "";

app.use(express.json({ limit: "100kb" }));
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"] }));
app.use("/api/", rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }));

function validUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

async function yoinkuInfo(url) {
  if (!YOINKU_API_KEY) throw new Error("Yoinku API key is not configured.");
  const r = await fetch(`${YOINKU_BASE}/info?url=${encodeURIComponent(url)}`, {
    headers: { "x-api-key": YOINKU_API_KEY }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d?.error?.message || `Yoinku HTTP ${r.status}`);
  const x = d.data || {};
  return {
    ok: true, engine: "yoinku", title: x.title || "Media",
    thumbnailUrl: x.thumbnailUrl || "", durationSeconds: x.durationSeconds || null,
    platform: x.platform || "",
    formats: Array.isArray(x.formats) ? x.formats.map(f => ({
      id: f.id, kind: f.kind || "video", container: f.container || "",
      quality: f.quality || "", bitrate: f.bitrate || ""
    })) : []
  };
}

async function yoinkuDownload(url, format) {
  if (!YOINKU_API_KEY) throw new Error("Yoinku API key is not configured.");
  const r = await fetch(`${YOINKU_BASE}/download?url=${encodeURIComponent(url)}&format=${encodeURIComponent(format)}`, {
    headers: { "x-api-key": YOINKU_API_KEY }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok || !d.url) throw new Error(d?.error?.message || `Yoinku download HTTP ${r.status}`);
  return { ok: true, engine: "yoinku", url: d.url, filename: d.filename || "media", expiresInSeconds: d.expiresInSeconds || null };
}

function cobaltHeaders() {
  const h = { Accept: "application/json", "Content-Type": "application/json" };
  if (COBALT_API_KEY) h.Authorization = `Api-Key ${COBALT_API_KEY}`;
  return h;
}

async function cobaltRequest(body) {
  const r = await fetch(`${COBALT_URL}/`, {
    method: "POST", headers: cobaltHeaders(), body: JSON.stringify(body)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.code || `Cobalt HTTP ${r.status}`);
  return d;
}

function cobaltFormats(d) {
  if (d.status === "tunnel" || d.status === "redirect") {
    return [{ id: "cobalt-default", kind: "video", container: "direct", quality: "available", url: d.url, filename: d.filename || "media" }];
  }
  if (d.status === "picker") {
    return (d.picker || []).map((x, i) => ({
      id: `cobalt-${i}`, kind: x.type || "video", container: "", quality: "",
      url: x.url, thumb: x.thumb || ""
    }));
  }
  throw new Error(d?.error?.code || "Cobalt did not return media.");
}

app.get("/", (req, res) => res.json({
  ok: true, service: "VIDLUXE PRO Gateway", status: "online",
  engines: { yoinku: Boolean(YOINKU_API_KEY), cobalt: Boolean(COBALT_URL) }
}));

app.post("/api/info", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: { code: "invalid_url", message: "Enter a valid HTTP/HTTPS URL." } });

  let primaryError = null;
  try {
    const result = await yoinkuInfo(url);
    if (result.formats.length) return res.json(result);
    primaryError = "Yoinku returned no formats.";
  } catch (e) { primaryError = e.message; }

  try {
    const d = await cobaltRequest({
      url, videoQuality: "720", audioFormat: "best", audioBitrate: "128",
      filenameStyle: "pretty", downloadMode: "auto"
    });
    return res.json({ ok: true, engine: "cobalt", fallback: true, title: d.filename || "Media", formats: cobaltFormats(d), primaryError });
  } catch (e) {
    return res.status(502).json({
      ok: false, error: { code: "all_engines_failed", message: "Yoinku and Cobalt both failed." },
      details: { yoinku: primaryError, cobalt: e.message }
    });
  }
});

app.post("/api/download", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const format = String(req.body?.format || "").trim();
  if (!validUrl(url) || !format) return res.status(400).json({ ok: false, error: { code: "invalid_request", message: "URL and format are required." } });

  try {
    return res.json(await yoinkuDownload(url, format));
  } catch (yoinkuError) {
    try {
      const audio = /^a-/.test(format);
      const d = await cobaltRequest({
        url, videoQuality: "720",
        audioFormat: format.includes("m4a") ? "m4a" : "mp3",
        audioBitrate: "128", filenameStyle: "pretty",
        downloadMode: audio ? "audio" : "auto"
      });
      const item = cobaltFormats(d)[0];
      if (!item?.url) throw new Error("No media URL returned.");
      return res.json({ ok: true, engine: "cobalt", fallback: true, url: item.url, filename: item.filename || "media" });
    } catch (cobaltError) {
      return res.status(502).json({
        ok: false, error: { code: "download_failed", message: "Both engines failed." },
        details: { yoinku: yoinkuError.message, cobalt: cobaltError.message }
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`VIDLUXE PRO Gateway running on port ${PORT}`));
