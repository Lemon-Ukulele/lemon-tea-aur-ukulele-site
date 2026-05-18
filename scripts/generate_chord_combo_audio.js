const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = process.cwd();
const BASE_AUDIO_DIR = path.join(ROOT, 'site_audio_from_ukebuddy', 'chords');
const SAMPLES_DIR = path.join(ROOT, 'site_audio_from_ukebuddy', 'base_notes');
const OUT_BASE_DIR = path.join(BASE_AUDIO_DIR, 'combinations');
const MANIFEST_PATH = path.join(OUT_BASE_DIR, 'manifest.json');
const URL = 'https://ukebuddy.com/ukulele-chords-ub1';
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY_FIRST_POSITION = true;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value) {
  return String(value)
    .trim()
    .replace(/#/g, 's')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_+\-]/g, '_');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function runFfmpeg(outFile, noteEvents) {
  if (!noteEvents.length) {
    return false;
  }

  const args = ['-y'];
  for (const evt of noteEvents) {
    const sample = path.join(SAMPLES_DIR, `${evt.note}.mp3`);
    if (!fs.existsSync(sample)) {
      throw new Error(`Missing sample: ${sample}`);
    }
    args.push('-i', sample);
  }

  const chains = [];
  const mixInputs = [];
  noteEvents.forEach((evt, idx) => {
    const d = String(evt.delayMs);
    chains.push(`[${idx}:a]adelay=${d}|${d}[a${idx}]`);
    mixInputs.push(`[a${idx}]`);
  });

  chains.push(`${mixInputs.join('')}amix=inputs=${noteEvents.length}:normalize=0,alimiter=limit=0.95[aout]`);
  args.push('-filter_complex', chains.join(';'));
  args.push('-map', '[aout]');
  args.push('-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k');
  args.push(outFile);

  const res = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg failed for ${outFile}: ${res.stderr || res.stdout}`);
  }
  return true;
}

async function extractAllCombinations(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.control-key[data-keyid]');
  await page.waitForSelector('.control-type[data-typeid]');
  await page.waitForSelector('.position');

  // Let the app hydrate/render chord data fully.
  await sleep(1200);

  const keys = await page.$$eval('.control-key[data-keyid]', (els) =>
    Array.from(new Set(els.map((e) => e.getAttribute('data-keyid')).filter(Boolean)))
  );
  const types = await page.$$eval('.control-type[data-typeid]', (els) =>
    Array.from(new Set(els.map((e) => e.getAttribute('data-typeid')).filter(Boolean)))
  );

  const combos = [];

  for (const key of keys) {
    await page.locator(`.control-key[data-keyid="${key}"]`).first().click();
    await sleep(120);

    for (const type of types) {
      await page.locator(`.control-type[data-typeid="${type}"]`).first().click();
      await sleep(120);

      // Reset to first position.
      for (let i = 0; i < 30; i++) {
        const cur = await page.locator('.position').first().innerText();
        if (String(cur).trim() === '1') break;
        await page.locator('.position-change.position-left').first().click();
        await sleep(30);
      }

      const totalText = await page.locator('.position-total').first().innerText();
      const total = parseInt(String(totalText).trim(), 10);
      if (!Number.isFinite(total) || total < 1) continue;

      const maxPos = ONLY_FIRST_POSITION ? 1 : total;
      for (let pos = 1; pos <= maxPos; pos++) {
        if (pos > 1) {
          await page.locator('.position-change.position-right').first().click();
          await sleep(80);
        }

        const notesByString = await page.evaluate(() => {
          const out = [];
          const jq = window.jQuery || window.$;
          for (let s = 0; s < 4; s++) {
            const el = document.querySelector(`[data-string="${s}"] .fret--on:not([data-fret="-1"])`);
            if (!el) {
              out.push(null);
              continue;
            }
            const note = (el.textContent || '').trim().replace('#', 's');
            const oct = jq ? jq(el).data('oct') : null;
            out.push(note && oct ? `${note}${oct}` : null);
          }
          return out;
        });

        combos.push({
          key,
          type,
          position: pos,
          positionTotal: total,
          notesByString,
        });
      }
    }
  }

  return { keys, types, combos };
}

async function main() {
  ensureDir(OUT_BASE_DIR);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const page = await browser.newPage();
    const { keys, types, combos } = await extractAllCombinations(page);

    let rendered = 0;
    for (const combo of combos) {
      const keyDir = path.join(OUT_BASE_DIR, sanitize(combo.key));
      const typeDir = path.join(keyDir, sanitize(combo.type));
      ensureDir(typeDir);

      const outFile = path.join(typeDir, `pos_${String(combo.position).padStart(2, '0')}.mp3`);

      const noteEvents = combo.notesByString
        .map((note, stringIdx) => (note ? { note, delayMs: stringIdx * 40 } : null))
        .filter(Boolean);

      if (noteEvents.length) {
        runFfmpeg(outFile, noteEvents);
        rendered += 1;
      }

      combo.outputFile = path.relative(OUT_BASE_DIR, outFile);
      combo.noteEvents = noteEvents;
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      sourceUrl: URL,
      keyCount: keys.length,
      typeCount: types.length,
      comboCount: combos.length,
      renderedCount: rendered,
      keys,
      types,
      combinations: combos,
    };

    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`Generated ${rendered} audio files.`);
    console.log(`Manifest: ${MANIFEST_PATH}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
