#!/usr/bin/env node
// V06 browser check: screenshots of the dashboard at 375 px and 1280 px, in
// light and dark, plus layout checks. One browser, closed in `finally`.
//
//   JFM_READ_TOKEN=<token> ~/.claude/bin/heavy-gate -n 1 -l jfm-shot -- node scripts/screenshot.mjs <out-dir>
//
// Env:
//   JFM_URL         dashboard origin (default http://127.0.0.1:8787); seed it first (npm run seed)
//   JFM_READ_TOKEN  read token (required); each context logs in via `/#token=...`
//   JFM_LANG        browser locale, e.g. zh-CN or en-US (default en-US)
//   JFM_CHROMIUM    optional browser executable; when unset and Playwright's own
//                   revision is not installed, the newest cached
//                   ~/.cache/ms-playwright/chromium_headless_shell-* (or chromium-*) is used
//   PLAYWRIGHT_MODULE  optional path to a `playwright` / `playwright-core` package
//                   when it is not resolvable from this repo
//
// Output: <out-dir>/{375,1280}-{light,dark}.png and a JSON report on stdout.
// Checks per shot: no horizontal scroll (scrollWidth <= innerWidth), sections
// in priority order (blocked, working, rest, ended), at most 4 progress lines
// per card on the board. Exit 1 if any check fails.

/* global document, window, location -- used inside page.evaluate() */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = process.argv[2];
const base = (process.env.JFM_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const token = process.env.JFM_READ_TOKEN || '';
const locale = process.env.JFM_LANG || 'en-US';
if (!outDir || !token) {
  console.error('usage: JFM_READ_TOKEN=<token> [JFM_URL=http://127.0.0.1:8787] node scripts/screenshot.mjs <out-dir>');
  process.exit(2);
}

const WIDTHS = [375, 1280];
const SCHEMES = ['light', 'dark'];
const SECTION_ORDER = ['blocked', 'working', 'rest', 'ended'];
const CARD_LINES = 4; // PROGRESS_CARD

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  for (const c of candidates) {
    try {
      const p = c.startsWith('/') || c.startsWith('.') ? resolve(c) : c;
      const resolved = require.resolve(p);
      const mod = await import(pathToFileURL(resolved).href);
      return mod.chromium ?? mod.default?.chromium;
    } catch {
      // try next
    }
  }
  throw new Error('Playwright is not installed: npm i -D playwright (or set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright)');
}

/** Newest cached headless shell / chromium under ~/.cache/ms-playwright. */
function cachedChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return null;
  const rev = (d) => Number(d.split('-').pop()) || 0;
  const dirs = readdirSync(root);
  const pickNewest = (prefix, rel) =>
    dirs.filter((d) => d.startsWith(prefix)).sort((a, b) => rev(b) - rev(a))
      .map((d) => join(root, d, rel)).find((p) => existsSync(p)) ?? null;
  return (
    pickNewest('chromium_headless_shell-', 'chrome-headless-shell-linux64/chrome-headless-shell') ??
    pickNewest('chromium-', 'chrome-linux64/chrome') ??
    pickNewest('chromium-', 'chrome-linux/chrome')
  );
}

async function launch(chromium) {
  if (process.env.JFM_CHROMIUM) return chromium.launch({ executablePath: process.env.JFM_CHROMIUM });
  try {
    return await chromium.launch();
  } catch (e) {
    const fallback = cachedChromium();
    if (!fallback || !/Executable doesn't exist|browserType\.launch/i.test(String(e))) throw e;
    console.error(`screenshot: Playwright's bundled browser is missing; using ${fallback}`);
    return chromium.launch({ executablePath: fallback });
  }
}

async function shoot(browser, width, scheme) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.board, .login', { timeout: 15_000 });
    await page.waitForSelector('.card', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const file = join(outDir, `${width}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const m = await page.evaluate(() => {
      const se = document.scrollingElement ?? document.documentElement;
      const sections = [...document.querySelectorAll('.section')]
        .map((el) => [...el.classList].find((c) => c.startsWith('section-'))?.slice('section-'.length) ?? '?');
      const progressMax = Math.max(0, ...[...document.querySelectorAll('.card .card-body > ol.progress, .card .progress')]
        .filter((ol) => !ol.closest('.detail'))
        .map((ol) => ol.querySelectorAll(':scope > li').length));
      return {
        loggedIn: !!document.querySelector('.board'),
        hashCleared: location.hash === '',
        scrollWidth: se.scrollWidth,
        innerWidth: window.innerWidth,
        sections,
        cards: document.querySelectorAll('.card').length,
        progressMax,
      };
    });
    const idx = m.sections.map((s) => SECTION_ORDER.indexOf(s));
    const checks = {
      loggedIn: m.loggedIn,
      hashCleared: m.hashCleared,
      noHorizontalScroll: m.scrollWidth <= m.innerWidth,
      sectionOrder: idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])),
      progressLines: m.progressMax <= CARD_LINES,
      noPageErrors: errors.length === 0,
    };
    return { file, width, scheme, ...m, errors, checks, ok: Object.values(checks).every(Boolean) };
  } finally {
    await context.close();
  }
}

mkdirSync(outDir, { recursive: true });
const chromium = await loadPlaywright();
const results = [];
let browser;
try {
  browser = await launch(chromium);
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) results.push(await shoot(browser, width, scheme));
  }
} finally {
  await browser?.close();
}
console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.error(failed.length ? `screenshot: ${failed.length} shot(s) failed checks` : `screenshot: ${results.length} shots OK in ${outDir}`);
process.exit(failed.length ? 1 : 0);
