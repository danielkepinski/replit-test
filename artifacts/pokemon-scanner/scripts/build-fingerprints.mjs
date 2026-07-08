#!/usr/bin/env node
/**
 * Build-time fingerprint generator for the Pokémon card scanner.
 *
 * Fetches card metadata from the pokemontcg.io public API, downloads each
 * card's small image, computes a 63-bit DCT perceptual hash, and writes the
 * result to src/data/fingerprints.json.
 *
 * Usage:
 *   node scripts/build-fingerprints.mjs [--limit N] [--sets base1,base2,...]
 *
 * Options:
 *   --limit N      Process at most N cards total (useful for dev/testing)
 *   --sets a,b,c   Comma-separated set IDs to include (default: all sets)
 *   --concurrency N  Parallel image downloads (default: 12)
 *   --out PATH     Output path (default: src/data/fingerprints.json)
 *
 * Requirements:
 *   pnpm add -D sharp  (installed automatically by build:fingerprints script)
 */

import { createRequire } from 'module';
import { fileURLToPath }  from 'url';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync }   from 'fs';
import path             from 'path';

const require = createRequire(import.meta.url);
const __dir   = path.dirname(fileURLToPath(import.meta.url));
const ROOT    = path.resolve(__dir, '..');

// ── CLI arguments ────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const LIMIT       = parseInt(getArg('--limit', 'Infinity'), 10);
const CONCURRENCY = parseInt(getArg('--concurrency', '12'),  10);
const OUT_PATH    = path.resolve(ROOT, getArg('--out', 'src/data/fingerprints.json'));
const ONLY_SETS   = getArg('--sets', '') ? getArg('--sets', '').split(',') : [];

// ── Attempt to load sharp; fall back to pure-JS implementation ───────────────
let sharpFn = null;
try {
  sharpFn = (await import('sharp')).default;
  console.log('✓ Using sharp for image processing');
} catch {
  console.log('  sharp not available – using pure-JS fallback decoder');
}

// ── Pure-JS JPEG/PNG decoder fallback ───────────────────────────────────────
// Used when sharp is unavailable.  Handles the pokemontcg.io image format.
async function decodeImageFallback(buffer) {
  // Try to detect format by magic bytes
  const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50;
  if (isPNG) {
    // Lazy-require pngjs
    const { PNG } = await import('pngjs').catch(() => {
      throw new Error('Install pngjs:  pnpm add -D pngjs');
    });
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data }; // RGBA
  }
  // Assume JPEG
  const jpeg = await import('jpeg-js').catch(() => {
    throw new Error('Install jpeg-js:  pnpm add -D jpeg-js');
  });
  return jpeg.default.decode(buffer, { useTArray: true }); // { width, height, data }
}

// ── Crop region constants — mirrors of ArtworkExtractor.ts CROP_REGIONS ──────
// Three regions handle different card eras (classic illustration box,
// full-art/ex upper area, near-full borderless).  All use the same image;
// only the crop window differs.
const CROPS = {
  classic:    { xMin: 0.08, xMax: 0.92, yMin: 0.15, yMax: 0.55 },
  fullArt:    { xMin: 0.05, xMax: 0.95, yMin: 0.05, yMax: 0.75 },
  borderless: { xMin: 0.02, xMax: 0.98, yMin: 0.02, yMax: 0.98 },
};

// ── Bilinear resize to 32×32 grayscale with optional crop window ─────────────
// cropX/Y/W/H are in source-image pixels; when omitted the full image is used.
function bilinearResize32(rgbaData, srcW, srcH, cropX = 0, cropY = 0, cropW = srcW, cropH = srcH) {
  const out = new Float64Array(32 * 32);
  for (let dy = 0; dy < 32; dy++) {
    for (let dx = 0; dx < 32; dx++) {
      const sx = cropX + (dx + 0.5) * cropW / 32 - 0.5;
      const sy = cropY + (dy + 0.5) * cropH / 32 - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const y1 = Math.min(srcH - 1, y0 + 1);
      const fx  = sx - x0;
      const fy  = sy - y0;
      const gray = (px, py) => {
        const i = (py * srcW + px) * 4;
        return 0.299 * rgbaData[i] + 0.587 * rgbaData[i + 1] + 0.114 * rgbaData[i + 2];
      };
      out[dy * 32 + dx] =
        (1 - fx) * (1 - fy) * gray(x0, y0) +
        fx       * (1 - fy) * gray(x1, y0) +
        (1 - fx) * fy       * gray(x0, y1) +
        fx       * fy       * gray(x1, y1);
    }
  }
  return out;
}

// ── 2-D DCT perceptual hash (mirrors src/utils/phash.ts exactly) ────────────
function computePHash(pixels /* Float64Array 1024 */) {
  const size = 32;

  const dctRows = new Float64Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let u = 0; u < size; u++) {
      let s = 0;
      for (let x = 0; x < size; x++) {
        s += pixels[r * size + x] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size));
      }
      dctRows[r * size + u] = s * (u === 0 ? 1 / Math.sqrt(2) : 1);
    }
  }

  const dct = new Float64Array(size * size);
  for (let c = 0; c < size; c++) {
    for (let v = 0; v < size; v++) {
      let s = 0;
      for (let y = 0; y < size; y++) {
        s += dctRows[y * size + c] * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
      }
      dct[v * size + c] = s * (v === 0 ? 1 / Math.sqrt(2) : 1);
    }
  }

  const ac = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (y === 0 && x === 0) continue; // skip DC coefficient
      ac.push(dct[y * size + x]);
    }
  }

  const sorted = [...ac].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let hash = 0n;
  for (let i = 0; i < ac.length; i++) {
    if (ac[i] > median) hash |= (1n << BigInt(i));
  }
  return hash.toString(16).padStart(16, '0');
}

// ── Image URL → multi-crop pHashes ───────────────────────────────────────────
// Returns { classicHash, fullArtHash, borderlessHash } for a single image.
// The image buffer is decoded once; all three crops share the same raw pixels.
async function hashImageUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const hashes = {};

  if (sharpFn) {
    const meta = await sharpFn(buf).metadata();
    const { width, height } = meta;
    for (const [mode, crop] of Object.entries(CROPS)) {
      const cropX = Math.round(crop.xMin * width);
      const cropY = Math.round(crop.yMin * height);
      const cropW = Math.round((crop.xMax - crop.xMin) * width);
      const cropH = Math.round((crop.yMax - crop.yMin) * height);
      const { data } = await sharpFn(buf)
        .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
        .resize(32, 32)
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pixels = new Float64Array(data.length);
      for (let i = 0; i < data.length; i++) pixels[i] = data[i];
      hashes[`${mode}Hash`] = computePHash(pixels);
    }
  } else {
    const { width, height, data } = await decodeImageFallback(buf);
    for (const [mode, crop] of Object.entries(CROPS)) {
      const cropX = Math.round(crop.xMin * width);
      const cropY = Math.round(crop.yMin * height);
      const cropW = Math.round((crop.xMax - crop.xMin) * width);
      const cropH = Math.round((crop.yMax - crop.yMin) * height);
      const pixels = bilinearResize32(data, width, height, cropX, cropY, cropW, cropH);
      hashes[`${mode}Hash`] = computePHash(pixels);
    }
  }

  return hashes; // { classicHash, fullArtHash, borderlessHash }
}

// ── pokemontcg.io API ────────────────────────────────────────────────────────
const API_BASE   = 'https://api.pokemontcg.io/v2';
const META_CACHE = path.resolve(ROOT, '.cache/card-meta.json');
const META_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Try to derive card metadata from an existing fingerprints.json.
 *
 * Each fingerprint entry already contains every field needed to re-download
 * and re-hash the card image: id, name, set, number, imageUrl.  When this
 * file is present and populated we can skip the pokemontcg.io API entirely.
 *
 * Returns the cards array (normalised to { id, name, set, number, imageUrl })
 * or null when the file is absent / unusable.
 */
async function tryMetaFromFingerprints() {
  if (!existsSync(OUT_PATH)) return null;
  try {
    const raw  = await readFile(OUT_PATH, 'utf8');
    const db   = JSON.parse(raw);
    const cards = (db.cards ?? []).filter(c => c.id && c.imageUrl);
    if (cards.length === 0) return null;

    // Optionally filter to the requested sets
    const filtered = ONLY_SETS.length
      ? cards.filter(c => ONLY_SETS.some(s => c.id.startsWith(s + '-')))
      : cards;

    // Normalise: set is already a plain string in fingerprint entries
    const meta = filtered.map(c => ({
      id:       c.id,
      name:     c.name,
      set:      c.set,       // string, e.g. "Base Set"
      number:   c.number,
      imageUrl: c.imageUrl,
    }));

    console.log(`  Metadata: using fingerprints.json (${meta.length} cards) — skipping API`);
    return isFinite(LIMIT) ? meta.slice(0, LIMIT) : meta;
  } catch {
    return null;
  }
}

async function fetchCardsPage(page, pageSize = 250) {
  const params = new URLSearchParams({
    page:     String(page),
    pageSize: String(pageSize),
    select:   'id,name,set,number,images',
    orderBy:  'set.releaseDate',
  });
  if (ONLY_SETS.length > 0) {
    // pokemontcg.io v2 Lucene query: set.id:base1 OR set.id:jungle ...
    params.set('q', ONLY_SETS.map(s => `set.id:${s}`).join(' OR '));
  }
  const url = `${API_BASE}/cards?${params}`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'pokemon-scanner-builder/1.0' } });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllCardMeta() {
  // ── Prefer fingerprints.json as the metadata source ─────────────────────────
  // When it exists and contains imageUrl fields there is no need to hit the
  // pokemontcg.io API at all.  This allows offline rebuilds and avoids 404s
  // when the API is unavailable.
  const fromFingerprints = await tryMetaFromFingerprints();
  if (fromFingerprints) return fromFingerprints;

  // ── Fall back to pokemontcg.io API ──────────────────────────────────────────
  // Use cached metadata when available (avoids 10+ minutes of API pagination)
  const cacheKey = ONLY_SETS.length ? ONLY_SETS.join(',') : 'all';
  if (!ONLY_SETS.length && existsSync(META_CACHE)) {
    try {
      const raw   = await readFile(META_CACHE, 'utf8');
      const cache = JSON.parse(raw);
      if (cache.key === cacheKey && Date.now() - cache.fetchedAt < META_TTL_MS) {
        console.log(`  Metadata: using disk cache (${cache.cards.length} cards, fetched ${new Date(cache.fetchedAt).toISOString()})`);
        return isFinite(LIMIT) ? cache.cards.slice(0, LIMIT) : cache.cards;
      }
    } catch { /* ignore bad cache */ }
  }

  console.log('Fetching card metadata from pokemontcg.io…');
  const first = await fetchCardsPage(1);
  const total = Math.min(first.totalCount, isFinite(LIMIT) ? LIMIT : Infinity);
  const pageSize = first.pageSize ?? 250;
  const totalPages = Math.ceil(total / pageSize);

  console.log(`  Total cards available: ${first.totalCount} · ${totalPages} pages · fetching up to ${total}`);

  // Fetch remaining pages in parallel (8 concurrent) — much faster than sequential
  const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  let pagesReceived = 1;
  const pageResults = await (async () => {
    const out = new Array(pageNums.length);
    let idx = 0;
    async function worker() {
      while (idx < pageNums.length) {
        const i = idx++;
        out[i] = await fetchCardsPage(pageNums[i]);
        pagesReceived++;
        process.stdout.write(`  Metadata: page ${pagesReceived}/${totalPages}\r`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, pageNums.length) }, worker));
    return out;
  })();
  console.log();

  const cards = [...first.data];
  for (const page of pageResults) cards.push(...page.data);

  // Cache the full list for future runs
  if (!ONLY_SETS.length && !isFinite(LIMIT)) {
    await mkdir(path.dirname(META_CACHE), { recursive: true });
    await writeFile(META_CACHE, JSON.stringify({ key: cacheKey, fetchedAt: Date.now(), cards }), 'utf8');
    console.log(`  Metadata cached → ${META_CACHE}`);
  }

  return cards.slice(0, total);
}

// ── Concurrency pool ─────────────────────────────────────────────────────────
async function pool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let   i       = 0;

  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Load existing fingerprints to skip already-processed cards ───────────────
async function loadExisting() {
  if (!existsSync(OUT_PATH)) return new Map();
  try {
    const raw  = await readFile(OUT_PATH, 'utf8');
    const db   = JSON.parse(raw);
    const map  = new Map();
    for (const c of db.cards ?? []) map.set(c.id, c);
    console.log(`  Resuming: ${map.size} cards already fingerprinted`);
    return map;
  } catch {
    return new Map();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== Pokémon Card Fingerprint Builder ===');
  console.log(`Limit: ${isFinite(LIMIT) ? LIMIT : 'all'} · Concurrency: ${CONCURRENCY}`);

  const existing = await loadExisting();
  const allMeta  = await fetchAllCardMeta();

  // Filter to only cards that still need processing.
  // Re-process old single-hash entries (only have `hash`, missing the new fields).
  const ZERO = '0'.repeat(16);
  const todo = allMeta.filter(c => {
    const e = existing.get(c.id);
    return !e
      || !e.classicHash    || e.classicHash    === ZERO
      || !e.fullArtHash    || e.fullArtHash    === ZERO
      || !e.borderlessHash || e.borderlessHash === ZERO;
  });

  console.log(`Cards to process: ${todo.length} (${existing.size} cached)`);

  let done  = 0;
  let errs  = 0;
  const results = new Map(existing);

  // Save progress to disk periodically so the resume logic works across runs.
  const SAVE_INTERVAL = 200; // write every N newly completed cards
  async function saveProgress() {
    const sorted = [...results.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    const db = { generated: new Date().toISOString(), count: sorted.length, cards: sorted };
    await mkdir(path.dirname(OUT_PATH), { recursive: true });
    await writeFile(OUT_PATH, JSON.stringify(db, null, 2), 'utf8');
  }

  const tasks = todo.map(card => async () => {
    // Support both shapes:
    //   fingerprints.json entry  → card.imageUrl (string), card.set (string)
    //   pokemontcg.io API entry  → card.images.small (string), card.set.name (string)
    const imageUrl = card.imageUrl ?? card.images?.small;
    const setName  = typeof card.set === 'string' ? card.set : (card.set?.name ?? '');
    if (!imageUrl) {
      errs++;
      return;
    }
    try {
      const hashes = await hashImageUrl(imageUrl); // { classicHash, fullArtHash, borderlessHash }
      results.set(card.id, {
        id:       card.id,
        name:     card.name,
        set:      setName,
        number:   card.number ?? '',
        imageUrl,
        ...hashes,
      });
      done++;
      if (done % SAVE_INTERVAL === 0) await saveProgress();
      process.stdout.write(
        `  Processed ${done + existing.size}/${allMeta.length} (${errs} errors)\r`
      );
    } catch (err) {
      errs++;
      console.error(`\n  ✗ ${card.id}: ${err.message}`);
    }
  });

  await pool(tasks, CONCURRENCY);
  console.log(`\nDone. ${done} new · ${existing.size} cached · ${errs} errors`);

  // Sort by set release order then card number for stable output
  const sorted = [...results.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );

  const db = {
    generated: new Date().toISOString(),
    count:     sorted.length,
    cards:     sorted,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log(`Wrote ${sorted.length} fingerprints → ${OUT_PATH}`);
  console.log(`File size: ${(JSON.stringify(db).length / 1024).toFixed(1)} KB`);
})();
