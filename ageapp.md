# Age Transform — project context for Claude Code

This is a working local Node.js/Express app: upload 1-3 photos, set current age,
drag a slider to a target age, click Generate, and get a photorealistic
age-transformed portrait. No gender swap — age only. Built originally in a
Cowork session and handed off here to continue development with direct
terminal access.

## Status: working

The app runs and has successfully generated at least one real image via fal.ai.
A Download button was just added (preview panel + gallery thumbnails).

## Stack

- Backend: `server.js` — Express, serves `public/` statically, one main route
  `POST /api/generate`.
- Frontend: plain HTML/CSS/JS in `public/` (`index.html`, `style.css`, `app.js`)
  — no framework/build step.
- Image generation: [fal.ai](https://fal.ai), model `fal-ai/nano-banana/edit`
  (Google's Gemini image-edit model), called via fal's REST queue API
  (`https://queue.fal.run/fal-ai/nano-banana/edit`, `Authorization: Key $FAL_KEY`).
  Cost: **$0.039 per generated image**.
- Uploaded photos are resized with `sharp` and sent as base64 data URIs
  directly in the request body (no fal storage upload step needed).

## Budget guardrail — important, do not remove

The user (Ajin) explicitly asked to be told before any fal.ai credits are
spent, and set a **hard cap of $10.00/day**. This is enforced server-side in
`server.js`:
- `data/spend.json` tracks cumulative spend per calendar day (Asia/Singapore
  timezone, via `todayKeySGT()`).
- `POST /api/generate` checks projected spend against `DAILY_BUDGET_USD`
  (from `.env`, default $10) *before* calling fal.ai, and returns HTTP 429
  without spending anything if the cap would be exceeded.
- Keep this check intact in any future changes to the generate route. If the
  user asks to raise/lower the cap, that's just `DAILY_BUDGET_USD` in `.env`.
- **Never make a real fal.ai call (which spends money) without the user
  explicitly initiating or approving it first** — this was an explicit
  instruction from Ajin during the build.

## Environment / secrets

- `.env` (gitignored) holds `FAL_KEY`, `PORT`, `DAILY_BUDGET_USD`. It already
  exists locally with a real key — don't overwrite it or print its contents
  unnecessarily.
- `.env.example` is the template for reference.

## Local machine constraints

- The user does **not** have admin rights on this PC, so Node.js is NOT
  installed system-wide / on PATH. They extracted the portable Node.js zip
  (`node-v24.19.0-win-x64`) directly into this project folder.
- `start.bat` is a Windows batch launcher that: looks for a `node-v*-win-x64`
  folder next to it first (portable Node), falls back to system PATH `node`
  if not found, creates `.env` if missing, runs `npm install` if
  `node_modules` is missing, then starts the server and auto-opens
  `http://localhost:3000` in the browser. Keep this working if you touch
  install/startup flow — it's the user's primary way of running the app.
- Don't assume `node`/`npm` are on PATH when suggesting commands — check
  first, or reference the portable install if system Node isn't found.

## Gallery / history

- Every successful generation is appended to `data/history.json` (gitignored,
  created at runtime) and the output image saved to `public/generated/`.
- `GET /api/history` powers the gallery at the bottom of the page.

## Known next steps (not yet done, only discussed)

- Deploying it live somewhere public (e.g. Vercel/Render) was intentionally
  deferred until local testing was confirmed working. The user may ask for
  this next.
- Batch/compare-multiple-target-ages in one generation was mentioned as a
  possible future feature, not built.

## Full docs

See `README.md` for setup/run instructions.
