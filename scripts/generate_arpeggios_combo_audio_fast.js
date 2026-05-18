const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = process.cwd();
const BASE_AUDIO_DIR = path.join(ROOT, 'site_audio_from_ukebuddy', 'arpeggios');
const SAMPLES_DIR = path.join(ROOT, 'site_audio_from_ukebuddy', 'base_notes');
const OUT_BASE_DIR = path.join(BASE_AUDIO_DIR, 'combinations');
const MANIFEST_PATH = path.join(OUT_BASE_DIR, 'manifest.json');
const URL = 'https://ukebuddy.com/ukulele-arpeggios-ub1';
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitize(value) {
  return String(value)
    .trim()
    .replace(/#/g, 's')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_+\-]/g, '_');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runFfmpeg(outFile, noteEvents) {
  if (!noteEvents.length) return false;

  const args = ['-y'];
  for (const evt of noteEvents) {
    const sample = path.join(SAMPLES_DIR, `${evt.note}.mp3`);
    if (!fs.existsSync(sample)) throw new Error(`Missing sample: ${sample}`);
    args.push('-i', sample);
  }

  const chains = [];
  const mixInputs = [];
  noteEvents.forEach((evt, idx) => {
    const d = String(Math.max(0, Math.round(evt.delayMs)));
    chains.push(`[${idx}:a]adelay=${d}|${d}[a${idx}]`);
    mixInputs.push(`[a${idx}]`);
  });

  chains.push(`${mixInputs.join('')}amix=inputs=${noteEvents.length}:normalize=0,alimiter=limit=0.95[aout]`);
  args.push('-filter_complex', chains.join(';'));
  args.push('-map', '[aout]', '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', outFile);

  const res = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg failed for ${outFile}: ${res.stderr || res.stdout}`);
  }
  return true;
}

async function getArpeggioNoteEvents(page) {
  return page.evaluate(() => {
    const $ = window.jQuery || window.$;
    if (!$) return [];

    const toNote = (el) => {
      const note = ($(el).html() || '').trim().replace('#', 's');
      const oct = $(el).data('oct');
      return note && oct ? `${note}${oct}` : null;
    };

    const rootOnString1 = $('[data-string="1"] .fret--root').first();
    const e = rootOnString1.add(rootOnString1.nextAll('.fret--on'));
    const s = e.last();
    const n = $('[data-string="2"] .fret--on:contains("' + s.html() + '")').first();
    const o = n.nextAll('.fret--on');

    let a, l, i, r;
    if (o.length) {
      const t = o.last();
      a = $('[data-string="3"] .fret--on:contains("' + t.html() + '")').first();
      l = a.nextAll('.fret--on');
      i = e.add(o).add(l);
    } else {
      a = $('[data-string="3"] .fret--on:contains("' + s.html() + '")').first();
      l = a.nextAll('.fret--on');
      i = e.add(l);
    }

    for (let t = 0, len = i.length; t < len; t++) {
      if (t > 0 && i[t] && i[t].className.includes('fret--root')) {
        r = t;
      }
    }

    const arr = i.get();
    if (typeof r === 'number') {
      arr.splice(r, arr.length - r);
    }

    const events = [];
    arr.forEach((el, idx) => {
      const note = toNote(el);
      if (note) events.push({ note, delayMs: 180 * idx });
    });

    const rev = arr.slice().reverse();
    rev.forEach((el, idx) => {
      const note = toNote(el);
      if (note) events.push({ note, delayMs: 180 * (idx + arr.length - 1) });
    });

    return events;
  });
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
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.control-key[data-keyid]');
    await page.waitForSelector('.control-type[data-typeid]');

    await sleep(800);

    const keys = await page.$$eval('.control-key[data-keyid]', (els) =>
      Array.from(new Set(els.map((e) => e.getAttribute('data-keyid')).filter(Boolean)))
    );
    const types = await page.$$eval('.control-type[data-typeid]', (els) =>
      Array.from(new Set(els.map((e) => e.getAttribute('data-typeid')).filter(Boolean)))
    );

    const combinations = [];
    let renderedCount = 0;

    for (const key of keys) {
      await page.locator(`.control-key[data-keyid="${key}"]`).first().click();
      await sleep(70);

      for (const type of types) {
        await page.locator(`.control-type[data-typeid="${type}"]`).first().click();
        await sleep(90);

        const noteEvents = await getArpeggioNoteEvents(page);

        const keyDir = path.join(OUT_BASE_DIR, sanitize(key));
        const typeDir = path.join(keyDir, sanitize(type));
        ensureDir(typeDir);
        const outFile = path.join(typeDir, 'play.mp3');

        if (noteEvents.length) {
          runFfmpeg(outFile, noteEvents);
          renderedCount += 1;
        }

        combinations.push({
          key,
          type,
          eventCount: noteEvents.length,
          outputFile: path.relative(OUT_BASE_DIR, outFile),
          noteEvents,
        });
      }
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      sourceUrl: URL,
      method: 'fast-dom-sequence',
      keyCount: keys.length,
      typeCount: types.length,
      comboCount: keys.length * types.length,
      renderedCount,
      keys,
      types,
      combinations,
    };

    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`Generated ${renderedCount} audio files.`);
    console.log(`Manifest: ${MANIFEST_PATH}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
