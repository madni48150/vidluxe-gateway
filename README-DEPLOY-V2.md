# Downloader Master Gateway v2

## Railway deployment
1. Connect this repository and the `downloader-backend-v2` branch to a Railway service.
2. Start command: `npm start` (also defined in package.json).
3. Configure environment variables:
   - `YOINKU_API_KEY` (optional if using Cobalt only)
   - `COBALT_URL` (your Cobalt service URL)
   - `COBALT_API_KEY` (only if required by your Cobalt service)
4. Deploy, then open `/health`. Expected JSON: `{"ok":true,"status":"healthy","version":"2.0.0"}`.

Routes: GET /, GET /health, POST /api/info, POST /api/download.
Only use providers and media URLs you are authorized to access. Platform support depends on the configured provider.
