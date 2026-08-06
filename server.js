require('dotenv').config();

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FAL_KEY = process.env.FAL_KEY;
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '10.00');

// GPT Image 2 edit, low quality ($/image, worst-case for non-square sizes).
// See https://fal.ai/models/fal-ai/gpt-image-2/edit
const COST_PER_IMAGE_USD = 0.013;
const FAL_MODEL = 'openai/gpt-image-2/edit';
const IMAGE_QUALITY = 'low';

const ASPECT_TO_IMAGE_SIZE = {
  auto: 'auto',
  '1:1': 'square_hd',
  '3:4': 'portrait_4_3',
  '4:5': 'portrait_4_3',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '16:9': 'landscape_16_9',
};

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SPEND_FILE = path.join(DATA_DIR, 'spend.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(__dirname, 'public', 'generated');

for (const dir of [DATA_DIR, GENERATED_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json());

// ---------- per-visitor client id (so each browser only sees its own gallery) ----------

const CLIENT_COOKIE = 'ageapp_client_id';

function getClientId(req, res) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`${CLIENT_COOKIE}=([^;]+)`));
  if (match) return match[1];

  const id = uuidv4();
  res.setHeader(
    'Set-Cookie',
    `${CLIENT_COOKIE}=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; SameSite=Lax`
  );
  return id;
}

app.use((req, res, next) => {
  req.clientId = getClientId(req, res);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/generated', express.static(GENERATED_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 3 },
});

// ---------- date / budget helpers (Asia/Singapore) ----------

function todayKeySGT() {
  // en-CA gives YYYY-MM-DD format
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function getTodaySpend() {
  const spend = await readJson(SPEND_FILE, {});
  return spend[todayKeySGT()] || 0;
}

async function addSpend(amount) {
  const spend = await readJson(SPEND_FILE, {});
  const key = todayKeySGT();
  spend[key] = (spend[key] || 0) + amount;
  await writeJson(SPEND_FILE, spend);
  return spend[key];
}

async function appendHistory(entry) {
  const history = await readJson(HISTORY_FILE, []);
  history.unshift(entry);
  await writeJson(HISTORY_FILE, history.slice(0, 200)); // keep last 200
  return history;
}

// ---------- fal.ai helpers ----------

async function falSubmit(input) {
  const res = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.detail ? JSON.stringify(body.detail) : `fal submit failed (${res.status})`);
  }
  return body; // { request_id, status_url, response_url, ... }
}

async function falPollResult(statusUrl, responseUrl, { timeoutMs = 90000, intervalMs = 1500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const statusRes = await fetch(statusUrl, {
      headers: { Authorization: `Key ${FAL_KEY}` },
    });
    const status = await statusRes.json();
    if (status.status === 'COMPLETED') {
      const resultRes = await fetch(responseUrl, {
        headers: { Authorization: `Key ${FAL_KEY}` },
      });
      if (!resultRes.ok) {
        throw new Error(`fal result fetch failed (${resultRes.status})`);
      }
      return resultRes.json();
    }
    if (status.status === 'ERROR' || status.status === 'FAILED') {
      throw new Error(`fal generation failed: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('fal generation timed out');
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download result image (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buf);
}

// ---------- prompt building ----------

function buildPrompt({ currentAge, targetAge, sceneDescription }) {
  const direction = targetAge > currentAge ? 'older' : targetAge < currentAge ? 'younger' : 'the same age';
  let prompt =
    `Transform the person in the reference photo(s) to look ${targetAge} years old ` +
    `(they are currently ${currentAge} years old, so make them look ${direction}). ` +
    `Preserve their exact identity, facial structure, ethnicity, and gender — do not change who they are, ` +
    `only adjust age-related features such as skin texture, wrinkles, hair color/thickness/hairline, ` +
    `and posture appropriate for age ${targetAge}. Keep it photorealistic with natural lighting.`;
  if (sceneDescription && sceneDescription.trim()) {
    prompt += ` Scene/setting: ${sceneDescription.trim()}.`;
  }
  return prompt;
}

// ---------- routes ----------

app.get('/api/budget', async (req, res) => {
  const spent = await getTodaySpend();
  res.json({
    date: todayKeySGT(),
    dailyBudgetUsd: DAILY_BUDGET_USD,
    spentUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, DAILY_BUDGET_USD - spent).toFixed(4)),
    costPerGenerationUsd: COST_PER_IMAGE_USD,
  });
});

app.get('/api/history', async (req, res) => {
  const history = await readJson(HISTORY_FILE, []);
  res.json(history.filter((entry) => entry.clientId === req.clientId));
});

app.post('/api/generate', upload.array('photos', 3), async (req, res) => {
  try {
    if (!FAL_KEY) {
      return res.status(500).json({ error: 'Server is missing FAL_KEY. Add it to your .env file and restart.' });
    }

    const files = req.files || [];
    if (files.length < 1) {
      return res.status(400).json({ error: 'Upload at least 1 photo (up to 3).' });
    }

    const currentAge = parseInt(req.body.currentAge, 10);
    const targetAge = parseInt(req.body.targetAge, 10);
    const sceneDescription = req.body.sceneDescription || '';
    const aspectRatio = req.body.aspectRatio || 'auto';

    if (!Number.isFinite(currentAge) || currentAge < 0 || currentAge > 120) {
      return res.status(400).json({ error: 'Current age must be between 0 and 120.' });
    }
    if (!Number.isFinite(targetAge) || targetAge < 0 || targetAge > 120) {
      return res.status(400).json({ error: 'Target age must be between 0 and 120.' });
    }

    // ---- budget check BEFORE spending anything ----
    const estimatedCost = COST_PER_IMAGE_USD; // 1 output image per generation
    const spentToday = await getTodaySpend();
    if (spentToday + estimatedCost > DAILY_BUDGET_USD) {
      return res.status(429).json({
        error: `Daily fal.ai budget of $${DAILY_BUDGET_USD.toFixed(2)} reached. ` +
          `Spent $${spentToday.toFixed(2)} today. Try again after midnight (Asia/Singapore).`,
      });
    }

    // ---- resize + base64-encode photos as data URIs (keeps payload small, avoids needing fal storage upload) ----
    const imageDataUris = await Promise.all(
      files.map(async (f) => {
        const resized = await sharp(f.buffer)
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        return `data:image/jpeg;base64,${resized.toString('base64')}`;
      })
    );

    const prompt = buildPrompt({ currentAge, targetAge, sceneDescription });

    const submitted = await falSubmit({
      prompt,
      image_urls: imageDataUris,
      num_images: 1,
      image_size: ASPECT_TO_IMAGE_SIZE[aspectRatio] || 'auto',
      quality: IMAGE_QUALITY,
      output_format: 'png',
    });

    const result = await falPollResult(submitted.status_url, submitted.response_url);

    const outputImage = result?.images?.[0];
    if (!outputImage?.url) {
      throw new Error('fal.ai response did not include an output image.');
    }

    const id = uuidv4();
    const destFile = `${id}.png`;
    await downloadToFile(outputImage.url, path.join(GENERATED_DIR, destFile));

    const newTotal = await addSpend(estimatedCost);

    const entry = {
      id,
      clientId: req.clientId,
      createdAt: new Date().toISOString(),
      currentAge,
      targetAge,
      sceneDescription: sceneDescription || null,
      resultUrl: `/generated/${destFile}`,
      costUsd: estimatedCost,
    };
    await appendHistory(entry);

    res.json({
      success: true,
      resultUrl: entry.resultUrl,
      costUsd: estimatedCost,
      spentTodayUsd: Number(newTotal.toFixed(4)),
      remainingTodayUsd: Number(Math.max(0, DAILY_BUDGET_USD - newTotal).toFixed(4)),
    });
  } catch (err) {
    console.error('generate error:', err);
    res.status(500).json({ error: err.message || 'Generation failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Age Transform app running at http://localhost:${PORT}`);
  if (!FAL_KEY) {
    console.warn('WARNING: FAL_KEY is not set. Copy .env.example to .env and add your fal.ai API key.');
  }
});
