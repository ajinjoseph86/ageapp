# Age Transform

Upload 1-3 photos, set your current age, drag a slider to any target age, and generate
a photorealistic age-transformed portrait. No gender swap — age only.

Runs locally as a small Node/Express app. Image generation is powered by
[fal.ai](https://fal.ai)'s Nano Banana edit model (`fal-ai/nano-banana/edit`).

## 1. Install

```bash
npm install
```

## 2. Add your fal.ai API key

Get a key from https://fal.ai/dashboard/keys, then:

```bash
cp .env.example .env
```

Open `.env` and paste your key into `FAL_KEY=`. Never commit `.env` — it's already
in `.gitignore`.

## 3. Run

```bash
npm start
```

Open http://localhost:3000 in your browser.

## How it works

1. Upload 1-3 clear photos of yourself (more angles = better identity preservation).
2. Enter your current age.
3. Drag the "Travel to age" slider (or click a preset) to the age you want to see.
4. Optionally describe a scene/setting.
5. Click **Generate**. The server resizes your photos, sends them + a prompt to
   fal.ai, polls until the result is ready, and shows it in the Preview panel.
6. Every result is saved to the gallery at the bottom of the page
   (stored in `data/history.json` and `public/generated/`).

## Cost control — daily budget cap

Each generation costs about **$0.039** (fal.ai's price for one Nano Banana edit
image). The server tracks cumulative spend per calendar day (Asia/Singapore time)
in `data/spend.json` and **hard-refuses** any request that would push the day's
total over the `DAILY_BUDGET_USD` limit set in `.env` (default **$10.00/day** —
roughly 250+ generations). When the cap is hit, the app shows an error and no
fal.ai call is made, so you can't accidentally overspend.

To change the limit, edit `DAILY_BUDGET_USD` in `.env` and restart the server.

## Project structure

```
server.js            Express server + fal.ai integration + budget/history logic
public/index.html     UI markup
public/style.css       Styling (dark theme)
public/app.js           Frontend logic (uploads, slider, calling the API)
public/generated/       Saved output images (gitignored)
data/history.json       Gallery history (gitignored, created at runtime)
data/spend.json         Daily spend tracker (gitignored, created at runtime)
```

## Notes / next steps

- This is the "run it locally" version. If you later want it deployed with a
  public URL, the same code can be pushed to a host like Render, Railway, or
  Vercel (with a couple of small tweaks for serverless file storage) — just ask.
- Currently generates 1 output image per click. Batch/compare-multiple-ages mode
  could be added later.
