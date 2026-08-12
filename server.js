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
const MAX_GENERATIONS_PER_CLIENT = parseInt(process.env.MAX_GENERATIONS_PER_CLIENT || '8', 10);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const DOWNLOAD_PRICE_USD = parseFloat(process.env.DOWNLOAD_PRICE_USD || '2.00');
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

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
const PAID_FILE = path.join(DATA_DIR, 'paid.json');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(__dirname, 'public', 'generated');
// Real, unwatermarked output lives here — this folder is NEVER served statically.
// Only the authenticated, paid /api/download route can read from it.
const PRIVATE_DIR = process.env.PRIVATE_DIR || path.join(DATA_DIR, 'private');

const WATERMARK_TEXT = 'MULTIVERSEMATRIX';

for (const dir of [DATA_DIR, GENERATED_DIR, PRIVATE_DIR]) {
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

// ---------- paid downloads ----------

async function isPaid(imageId, clientId) {
  const paid = await readJson(PAID_FILE, []);
  return paid.some((p) => p.imageId === imageId && p.clientId === clientId);
}

async function markPaid({ imageId, clientId, sessionId }) {
  const paid = await readJson(PAID_FILE, []);
  if (paid.some((p) => p.sessionId === sessionId)) return; // already recorded
  paid.push({ imageId, clientId, sessionId, paidAt: new Date().toISOString() });
  await writeJson(PAID_FILE, paid);
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

async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download result image (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Tiles the watermark text as a real, rendered SVG pattern sized to the
// image's own dimensions, then composites it onto the pixels — this can't
// be stripped by right-click-save the way a CSS overlay can, and density
// stays correct no matter the image's aspect ratio (portrait/landscape/etc).
function watermarkSvg(width, height, text) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="wm" width="240" height="120" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
          <text x="0" y="70" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="900"
                fill="rgba(255,255,255,0.42)" stroke="rgba(0,0,0,0.4)" stroke-width="1.5">${text}</text>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#wm)" />
    </svg>
  `);
}

// Saves the real output privately (never publicly servable), and a
// watermarked, slightly compressed copy publicly for the on-screen preview.
async function saveOriginalAndPreview(buffer, id) {
  const originalFile = `${id}.png`;
  await fsp.writeFile(path.join(PRIVATE_DIR, originalFile), buffer);

  const metadata = await sharp(buffer).metadata();
  const previewFile = `${id}-preview.jpg`;
  await sharp(buffer)
    .composite([{ input: watermarkSvg(metadata.width, metadata.height, WATERMARK_TEXT) }])
    .jpeg({ quality: 82 })
    .toFile(path.join(GENERATED_DIR, previewFile));

  return { originalFile, previewFile };
}

// ---------- prompt building ----------

function buildPrompt({ targetAge, sceneDescription }) {
  let prompt =
    `Transform the person in the reference photo(s) to look exactly ${targetAge} years old, ` +
    `based on their apparent current age in the photo(s). ` +
    `Preserve their exact identity, facial structure, ethnicity, and gender — do not change who they are, ` +
    `only adjust age-related features such as skin texture, wrinkles, hair color/thickness/hairline, ` +
    `and posture appropriate for age ${targetAge}. Keep it photorealistic with natural lighting. ` +
    `If the person appears to be balding or has thinning hair in the reference photo(s) and ${targetAge} ` +
    `is younger than their apparent current age, give them a fuller, thicker head of hair appropriate ` +
    `for a ${targetAge}-year-old, since hair loss is age-related and should be reversed when de-aging.`;
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

// ---------- paywall ----------

app.post('/api/checkout', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Server is missing STRIPE_SECRET_KEY. Add it to .env and restart.' });
  }

  const { imageId } = req.body;
  if (!imageId) {
    return res.status(400).json({ error: 'imageId is required.' });
  }

  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === imageId && h.clientId === req.clientId);
  if (!entry) {
    return res.status(404).json({ error: 'Image not found for this session.' });
  }

  if (await isPaid(imageId, req.clientId)) {
    return res.json({ alreadyPaid: true });
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(DOWNLOAD_PRICE_USD * 100),
          product_data: { name: 'Age Transform — HD Download' },
        },
        quantity: 1,
      },
    ],
    metadata: { imageId, clientId: req.clientId },
    success_url: `${origin}/?paid_image=${imageId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
  });

  res.json({ url: session.url });
});

app.get('/api/verify-payment', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Server is missing STRIPE_SECRET_KEY.' });
  }
  const { session_id: sessionId } = req.query;
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id is required.' });
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') {
    return res.status(402).json({ paid: false });
  }
  if (session.metadata?.clientId !== req.clientId) {
    return res.status(403).json({ error: 'Session does not belong to this browser.' });
  }

  await markPaid({ imageId: session.metadata.imageId, clientId: req.clientId, sessionId });
  res.json({ paid: true, imageId: session.metadata.imageId });
});

app.get('/api/download/:imageId', async (req, res) => {
  const { imageId } = req.params;
  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === imageId && h.clientId === req.clientId);
  if (!entry) {
    return res.status(404).json({ error: 'Image not found.' });
  }
  if (!(await isPaid(imageId, req.clientId))) {
    return res.status(402).json({ error: 'Payment required.' });
  }
  res.download(path.join(PRIVATE_DIR, `${imageId}.png`), `age-transform-${imageId.slice(0, 8)}.png`);
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

    const targetAge = parseInt(req.body.targetAge, 10);
    const sceneDescription = req.body.sceneDescription || '';
    const aspectRatio = req.body.aspectRatio || 'auto';

    if (!Number.isFinite(targetAge) || targetAge < 0 || targetAge > 120) {
      return res.status(400).json({ error: 'Target age must be between 0 and 120.' });
    }
    if (!sceneDescription.trim()) {
      return res.status(400).json({ error: 'Scene/clothing description is required.' });
    }

    // ---- per-visitor generation cap: after the free limit, require at least 1 paid download ----
    const history = await readJson(HISTORY_FILE, []);
    const clientGenerationCount = history.filter((entry) => entry.clientId === req.clientId).length;
    if (clientGenerationCount >= MAX_GENERATIONS_PER_CLIENT) {
      const paid = await readJson(PAID_FILE, []);
      const hasPaid = paid.some((p) => p.clientId === req.clientId);
      if (!hasPaid) {
        return res.status(402).json({
          error: `You've used your ${MAX_GENERATIONS_PER_CLIENT} free generations. Pay to download an image to keep generating.`,
        });
      }
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

    const prompt = buildPrompt({ targetAge, sceneDescription });

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
    const outputBuffer = await downloadToBuffer(outputImage.url);
    const { previewFile } = await saveOriginalAndPreview(outputBuffer, id);

    const newTotal = await addSpend(estimatedCost);

    const entry = {
      id,
      clientId: req.clientId,
      createdAt: new Date().toISOString(),
      targetAge,
      sceneDescription: sceneDescription || null,
      resultUrl: `/generated/${previewFile}`,
      costUsd: estimatedCost,
    };
    await appendHistory(entry);

    res.json({
      success: true,
      id: entry.id,
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

// ---------- one-time migration: watermark + privatize images generated before this fix ----------
// Old entries have resultUrl like /generated/{id}.png — a raw, unwatermarked file that was
// sitting in the public folder. Move it to private storage and generate the real watermarked
// preview in its place. Safe to run every boot: already-migrated entries (resultUrl ending in
// -preview.jpg) are skipped.
async function migrateLegacyImages() {
  const history = await readJson(HISTORY_FILE, []);
  let migrated = 0;
  for (const entry of history) {
    if (!entry.resultUrl || entry.resultUrl.endsWith('-preview.jpg')) continue;
    const oldPublicPath = path.join(GENERATED_DIR, path.basename(entry.resultUrl));
    if (!fs.existsSync(oldPublicPath)) continue;
    try {
      const buffer = await fsp.readFile(oldPublicPath);
      const { previewFile } = await saveOriginalAndPreview(buffer, entry.id);
      await fsp.unlink(oldPublicPath);
      entry.resultUrl = `/generated/${previewFile}`;
      migrated++;
    } catch (err) {
      console.error(`migration failed for ${entry.id}:`, err.message);
    }
  }
  if (migrated > 0) {
    await writeJson(HISTORY_FILE, history);
    console.log(`Migrated ${migrated} legacy image(s) to private storage + watermarked preview.`);
  }
}

app.listen(PORT, () => {
  console.log(`Age Transform app running at http://localhost:${PORT}`);
  if (!FAL_KEY) {
    console.warn('WARNING: FAL_KEY is not set. Copy .env.example to .env and add your fal.ai API key.');
  }
  migrateLegacyImages().catch((err) => console.error('migration error:', err));
});
