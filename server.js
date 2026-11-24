import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const YOINKU_API_KEY = process.env.YOINKU_API_KEY || "";
const YOINKU_BASE = "https://yoinku.com/api/v1";
const COBALT_URL = (process.env.COBALT_URL || "https://cobalt-production-22d5.up.railway.app").replace(/\/+$/, "");
const COBALT_API_KEY = process.env.COBALT_API_KEY || "";

app.set("trust proxy", 1);
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "100kb" }));
app.use("/api/", rateLimit({ windowMs: 60000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }));

function validUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}
function fail(res, status, code, message, details) {
  const body = { ok: false, error: { code, message } };
  if (details) body.details = details;
  return res.status(status).json(body);
}
async function json(response) { return response.json().catch(() => ({})); }

async function yoinkuInfo(url) {
  if (!YOINKU_API_KEY) throw new Error("YOINKU_API_KEY is not configured.");
  const r = await fetch(`${YOINKU_BASE}/info?url=${encodeURIComponent(url)}`, {
    headers: { "x-api-key": YOINKU_API_KEY }, signal: AbortSignal.timeout(25000)
  });
  const d = await json(r);
  if (!r.ok || !d.ok) throw new Error(d?.error?.message || `Yoinku HTTP ${r.status}`);
  const x = d.data || {};
  return {
    ok: true, engine: "yoinku", title: x.title || "Media",
    thumbnailUrl: x.thumbnailUrl || "", durationSeconds: x.durationSeconds || null,
    platform: x.platform || "",
    formats: Array.isArray(x.formats) ? x.formats.map(f => ({
      id: String(f.id ?? ""), kind: f.kind || "video",
      container: f.container || "", quality: f.quality || "", bitrate: f.bitrate || ""
    })) : []
  };
}
async function yoinkuDownload(url, format) {
  if (!YOINKU_API_KEY) throw new Error("YOINKU_API_KEY is not configured.");
  const r = await fetch(`${YOINKU_BASE}/download?url=${encodeURIComponent(url)}&format=${encodeURIComponent(format)}`, {
    headers: { "x-api-key": YOINKU_API_KEY }, signal: AbortSignal.timeout(45000)
  });
  const d = await json(r);
  if (!r.ok || !d.ok || !d.url) throw new Error(d?.error?.message || `Yoinku HTTP ${r.status}`);
  return { ok: true, engine: "yoinku", url: d.url, filename: d.filename || "media", expiresInSeconds: d.expiresInSeconds || null };
}
function cobaltHeaders() {
  const h = { Accept: "application/json", "Content-Type": "application/json" };
  if (COBALT_API_KEY) h.Authorization = `Api-Key ${COBALT_API_KEY}`;
  return h;
}
async function cobaltRequest(body) {
  const r = await fetch(`${COBALT_URL}/`, {
    method: "POST", headers: cobaltHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(60000)
  });
  const d = await json(r);
  if (!r.ok || d.status === "error") throw new Error(d?.error?.code || d?.error?.message || `Cobalt HTTP ${r.status}`);
  return d;
}
function cobaltFormats(d) {
  if (d.status === "tunnel" || d.status === "redirect") return [{
    id: "cobalt-default", kind: "video", container: "direct",
    quality: "available", url: d.url, filename: d.filename || "media"
  }];
  if (d.status === "picker" && Array.isArray(d.picker)) return d.picker.map((x, i) => ({
    id: `cobalt-${i}`, kind: x.type || "video", container: "",
    quality: "", url: x.url, thumb: x.thumb || "", filename: d.filename || "media"
  }));
  throw new Error("Cobalt did not return a downloadable media item.");
}

app.get("/", (_req, res) => res.json({
  ok: true, service: "Downloader Master Gateway", status: "online", version: "2.0.0",
  endpoints: ["GET /", "GET /health", "POST /api/info", "POST /api/download"],
  engines: { yoinkuConfigured: Boolean(YOINKU_API_KEY), cobaltConfigured: Boolean(COBALT_URL) }
}));
app.get("/health", (_req, res) => res.json({ ok: true, status: "healthy", version: "2.0.0" }));

app.post("/api/info", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!validUrl(url)) return fail(res, 400, "INVALID_URL", "Enter a valid public HTTP/HTTPS URL.");
  let primaryError = "Yoinku unavailable.";
  try {
    const info = await yoinkuInfo(url);
    if (info.formats.length) return res.json(info);
    primaryError = "Yoinku returned no formats.";
  } catch (e) { primaryError = e.message; }
  try {
    const d = await cobaltRequest({
      url, videoQuality: "720", audioFormat: "mp3", audioBitrate: "128",
      filenameStyle: "pretty", downloadMode: "auto"
    });
    return res.json({
      ok: true, engine: "cobalt", fallback: true,
      title: d.filename || "Media", formats: cobaltFormats(d), primaryError
    });
  } catch (e) {
    return fail(res, 502, "INFO_FAILED", "Both providers failed to read this URL.", {
      yoinku: primaryError, cobalt: e.message
    });
  }
});

app.post("/api/download", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const format = String(req.body?.format || "").trim();
  if (!validUrl(url) || !format) return fail(res, 400, "INVALID_REQUEST", "URL and format are required.");
  try { return res.json(await yoinkuDownload(url, format)); }
  catch (ye) {
    try {
      const audio = format.startsWith("a-");
      const d = await cobaltRequest({
        url, videoQuality: "720",
        audioFormat: format.includes("m4a") ? "m4a" : "mp3",
        audioBitrate: "128", filenameStyle: "pretty",
        downloadMode: audio ? "audio" : "auto"
      });
      const items = cobaltFormats(d);
      const index = format.startsWith("cobalt-") ? Number(format.slice(7)) : 0;
      const selected = items[index] || items[0];
      if (!selected?.url) throw new Error("No media URL returned.");
      return res.json({ ok: true, engine: "cobalt", fallback: true, url: selected.url, filename: selected.filename || "media" });
    } catch (ce) {
      return fail(res, 502, "DOWNLOAD_FAILED", "Both providers failed.", { yoinku: ye.message, cobalt: ce.message });
    }
  }
});

app.use((req, res) => fail(res, 404, "NOT_FOUND", `No route for ${req.method} ${req.path}.`));
app.use((err, _req, res, _next) => {
  console.error("Unhandled server error:", err);
  fail(res, 500, "INTERNAL_ERROR", "Unexpected server error.");
});
app.listen(PORT, "0.0.0.0", () => console.log(`Downloader Master Gateway v2.0.0 listening on ${PORT}`));
