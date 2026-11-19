# AI Study Copilot

Static app + small Node server (no dependencies).

- `server.js`: serves `public/`, stores notes/progress in a JSON file (`/api/db`), proxies Claude (`/api/ai`).
- `public/shim.js`: lets the page's existing `window.claude` calls talk to this server.
- Each browser gets an anonymous private account via a cookie. There is no password login.

## Run locally
    ANTHROPIC_API_KEY=sk-ant-... node server.js     # http://localhost:3000

## Env vars
- `ANTHROPIC_API_KEY` (required for AI features; keep it server-side)
- `PORT` (default 3000), `DATA_FILE` (default ./data/db.json), `CLAUDE_MODEL`, `AI_LIMIT_PER_HOUR` (default 60 per visitor)

## Deploy
Any host that runs Node or Docker: Render (`render.yaml`), Railway, Fly.io. Mount a persistent disk at the DATA_FILE folder, otherwise saved notes reset on redeploy.
