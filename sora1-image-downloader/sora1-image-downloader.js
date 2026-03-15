// @ts-check

/**
 * Sora image downloader for an already-open Chrome window with Chrome Develper Protocol.
 *
 */

// TODO it's seems unable to keep worker page open after browser close with playwright while Puppeteer can do that
// seems work

const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const WORKER_VIEWPORT = { width: 1500, height: 1000 };

const CONFIG = {
  cdpUrl: 'http://127.0.0.1:9222',
  libraryUrl: 'https://sora.chatgpt.com/library?type=images',
  outputDir: path.join(__dirname, 'downloads'),
  manifestPath: path.join(__dirname, 'manifest-batched.json'),
  screenshotDir: path.join(__dirname, 'error-screenshots'),
  promptMaxLen: 160,
  perDownloadTimeoutMs: 60000,
  postScrollWaitMs: 1600,
  recoveryWaitMs: 2600,
  maxStalledScrolls: 30,
  recoveryAttemptsPerStall: 3,
  //maxStalledScrolls: 50,
  //recoveryAttemptsPerStall: 5,
  scrollStepPx: Math.floor(WORKER_VIEWPORT.height * 0.8),
  stallStartBottomGapMultiplier: 1.5,
  harvestBatchSize: 25, 
  maxDownloads: null, // Set to null for the full run.
  retryErrors: true,
  settleAfterGotoMs: 1200,
  settleAfterSaveMs: 300,
  maxWindowsPathLen: 220,
  maxConsecutiveErrors: 10,
  workerResyncEvery: 250,
  downloadStartRetriesPerVisit: 2,
  logHarvestSamples: 3,
  workerViewport: WORKER_VIEWPORT,
};

const PROMPT_LABELS = new Set(['Prompt', 'Remix']);

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function sanitizeFilenameText(text) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\.+$/g, '')
    .trim();

  return cleaned || 'no prompt found';
}

function sanitizeFilenameComponent(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\.+$/g, '')
    .trim();
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizePromptText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function isDownloadStartTimeout(error) {
  const message = String(
    error && (error.stack || error.message) ? (error.stack || error.message) : error || ''
  );
  return /Timeout/i.test(message) && /event "download"/i.test(message);
}

function cleanPromptCandidateText(text) {
  let t = normalizePromptText(text);
  if (!t) return '';

  const prefixPatterns = [
    /^The old Sora will no longer be available after March 13\.?\s*Learn more\s*/i,
    /^(?:today|yesterday|just now|\d+[smhdwy]?\s+ago)\s+(?=(?:Image Generation|Prompt|Remix)\b)/i,
    /^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|thur(?:sday)?|thurs(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2}(?:,\s*\d{4})?)?\s+(?=(?:Image Generation|Prompt|Remix)\b)/i,
    /^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|thur(?:sday)?|thurs(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+(?=(?:Image Generation|Prompt|Remix)\b)/i,
    /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2}(?:,\s*\d{4})?)?\s+(?=(?:Image Generation|Prompt|Remix)\b)/i,
    /^Image Generation\b[:\s-]*/i,
    /^Prompt\b[:\s-]*/i,
    /^Remix\b[:\s-]*/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of prefixPatterns) {
      const next = t.replace(pattern, '').trim();
      if (next !== t) {
        t = next;
        changed = true;
      }
    }
  }

  return t;
}

function isClearlyBadPromptText(text) {
  const t = cleanPromptCandidateText(text);
  if (!t) return true;
  if (t.length < 12) return true;

  const badExacts = new Set([
    'Sora',
    'Prompt',
    'Image Generation',
    'Download',
    'Share',
    'Copy',
    'Edit',
    'Delete',
    'Like',
    'Dislike',
    'Retry',
    'Variations',
    'Upscale',
    'Generated image',
    'Learn more',
    'Remix',
    'Create video',
  ]);

  if (badExacts.has(t)) return true;
  if (/^The old Sora will no longer be available after March 13\b/i.test(t)) return true;
  if (/^\d+[smhdwy]? ago$/i.test(t)) return true;
  if (/^(created|updated|aspect ratio|size|seed)\b/i.test(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  return false;
}

function promptQualityScore(text) {
  const t = cleanPromptCandidateText(text);
  if (isClearlyBadPromptText(t)) return -100000;

  let score = 0;
  score += Math.min(t.length, 500);
  score += Math.min(t.split(/\s+/).length * 4, 120);

  if (/[.,:;!?'"()\-]/.test(t)) score += 20;
  if (/[a-z]/.test(t) && /[A-Z]/.test(t)) score += 5;
  if (/[a-z]/.test(t)) score += 5;
  if (t.length >= 50) score += 25;
  if (t.length >= 100) score += 15;
  return score;
}

function chooseBetterPrompt(existingText, newText) {
  const existing = cleanPromptCandidateText(existingText);
  const next = cleanPromptCandidateText(newText);

  const existingScore = promptQualityScore(existing);
  const nextScore = promptQualityScore(next);

  if (nextScore > existingScore) return next;
  return existing;
}

function truncatePromptForFilename(text, maxLen) {
  const cleaned = sanitizeFilenameText(normalizeText(text));
  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLen)}[.]`;
}

function pad(num, width) {
  return String(num).padStart(width, '0');
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return String(url || '').trim();
  }
}

async function loadManifest(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      queue: [],
      items: {},
      totals: {
        harvested: 0,
        downloaded: 0,
        errors: 0,
      },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveManifest(filePath, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf8');
}

async function promptEnter(message) {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${message}\n`);
  rl.close();
}

function isDownloadableItem(item) {
  if (!item) return false;
  if (item.status === 'done') return false;
  if (item.status === 'error' && !CONFIG.retryErrors) return false;
  return true;
}

function countPendingItems(manifest) {
  let count = 0;
  for (const url of manifest.queue) {
    const item = manifest.items[url];
    if (isDownloadableItem(item)) count += 1;
  }
  return count;
}

function countErrorItems(manifest) {
  let count = 0;
  for (const url of manifest.queue) {
    const item = manifest.items[url];
    if (item && item.status === 'error') count += 1;
  }
  return count;
}

function batchTarget(remainingAllowance) {
  const base = CONFIG.maxDownloads !== null
    ? Math.min(CONFIG.maxDownloads, CONFIG.harvestBatchSize)
    : CONFIG.harvestBatchSize;

  if (remainingAllowance === Infinity) return base;
  return Math.max(1, Math.min(base, remainingAllowance));
}

async function findAttachedContext(browser) {
  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error(
      `No Chrome browser contexts were found at ${CONFIG.cdpUrl}. ` +
      'Start Chrome with --remote-debugging-port=9222 and keep that window open.'
    );
  }
  return contexts[0];
}

async function findSoraLibraryPage(context) {
  const soraPages = context.pages().filter((p) => p.url().includes('sora.chatgpt.com'));
  if (!soraPages.length) {
    throw new Error(
      'No open Sora tab was found in the attached Chrome window. ' +
      'Open https://sora.chatgpt.com/library?type=images in that same window, then rerun.'
    );
  }

  return (
    soraPages.find((p) => p.url().includes('/library?type=images')) ||
    soraPages[0]
  );
}

async function snapshotStorage(page, storageKind) {
  return page.evaluate((kind) => {
    try {
      const store = kind === 'local' ? window.localStorage : window.sessionStorage;
      const out = {};
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) out[key] = store.getItem(key);
      }
      return out;
    } catch {
      return {};
    }
  }, storageKind);
}

async function syncWorkerSessionFromLibrary(workerPage, libraryPage) {
  const sessionState = await snapshotStorage(libraryPage, 'session');

  await workerPage.evaluate((sessionState) => {
    try {
      window.sessionStorage.clear();
      for (const [key, value] of Object.entries(sessionState || {})) {
        window.sessionStorage.setItem(key, value ?? '');
      }
    } catch {}
  }, sessionState);

  return Object.keys(sessionState || {}).length;
}

async function installStorageSeeder(workerPage, libraryPage) {
  const [localState, sessionState] = await Promise.all([
    snapshotStorage(libraryPage, 'local'),
    snapshotStorage(libraryPage, 'session'),
  ]);

  await workerPage.addInitScript(({ localState, sessionState }) => {
    try {
      for (const [key, value] of Object.entries(localState || {})) {
        window.localStorage.setItem(key, value ?? '');
      }
    } catch {}

    try {
      for (const [key, value] of Object.entries(sessionState || {})) {
        window.sessionStorage.setItem(key, value ?? '');
      }
    } catch {}
  }, { localState, sessionState });

  return { localKeys: Object.keys(localState).length, sessionKeys: Object.keys(sessionState).length };
}

async function createWorkerPage(context, libraryPage) {
  const existingSoraPages = context.pages().filter((p) => (
    p !== libraryPage && p.url().includes('sora.chatgpt.com')
  ));

  if (existingSoraPages.length) {
    const page =
      existingSoraPages.find((p) => p.url().includes('/g/gen_')) ||
      existingSoraPages.find((p) => p.url().includes('/library?type=images')) ||
      existingSoraPages[0];

    try {
      await page.setViewportSize(CONFIG.workerViewport);
    } catch {}

    console.log(`Using existing Sora tab as worker: ${page.url()}`);
    return page;
  }

  const page = await context.newPage();

  try {
    await page.setViewportSize(CONFIG.workerViewport);
  } catch {}

  console.log(
    'No second Sora tab was open, so a new worker tab was created. ' +
    'If prompt extraction is still blank, manually duplicate the library tab once before rerunning.'
  );

  await page.goto(CONFIG.libraryUrl, { waitUntil: 'domcontentloaded' });
  await sleep(CONFIG.settleAfterGotoMs);

  return page;
}

async function collectVisibleImageItems(page) {
  // TODO implement get prompt from library page
  const rows = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const anchors = Array.from(document.querySelectorAll('a[href*="/g/gen_"]')).filter(isVisible);
    const seen = new Set();
    const out = [];

    for (const anchor of anchors) {
      const url = String(anchor.href || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, promptText: '' });
    }

    return out;
  });

  return rows.map((row) => ({
    url: normalizeUrl(row.url),
    promptText: '',
  }));
}

async function addVisibleImageItemsToManifest(page, manifest, limitToAdd = Infinity, seenUrls) {
  const rows = await collectVisibleImageItems(page);
  let added = 0;
  let promptUpdates = 0;

  for (const row of rows) {
    const url = normalizeUrl(row.url);
    if (!url) continue;
    if (seenUrls) seenUrls.add(url);

    const harvestedPrompt = cleanPromptCandidateText(row.promptText || '');

    if (!manifest.items[url]) {
      if (added >= limitToAdd) continue;

      manifest.queue.push(url);
      manifest.items[url] = {
        key: sha1(url),
        url,
        order: manifest.queue.length,
        firstSeenAt: new Date().toISOString(),
        status: 'queued',
        promptText: !isClearlyBadPromptText(harvestedPrompt) ? harvestedPrompt : '',
        promptSource: !isClearlyBadPromptText(harvestedPrompt) ? 'library' : '',
      };

      manifest.totals.harvested += 1;
      added += 1;
      continue;
    }

    if (harvestedPrompt) {
      const item = manifest.items[url];
      const better = chooseBetterPrompt(item.promptText || '', harvestedPrompt);
      if (better && better !== normalizePromptText(item.promptText || '')) {
        item.promptText = better;
        item.promptSource = 'library';
        item.promptUpdatedAt = new Date().toISOString();
        promptUpdates += 1;
      }
    }
  }

  if (added || promptUpdates) {
    await saveManifest(CONFIG.manifestPath, manifest);
  }

  return {
    visibleCount: rows.length,
    added,
    promptUpdates,
    sample: rows
      .filter((row) => row.promptText && !isClearlyBadPromptText(row.promptText))
      .slice(0, CONFIG.logHarvestSamples),
  };
}

async function getLibraryMetrics(page) {
  return page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement || document.body;
    const viewportHeight = window.innerHeight || 0;
    const scrollY = window.scrollY || root.scrollTop || 0;
    const scrollHeight = Math.max(
      root?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0
    );
    const bottomGap = Math.max(0, scrollHeight - (scrollY + viewportHeight));

    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const loaderSelectors = [
      '.spin_loader',
      '[role="progressbar"]',
      '[aria-busy="true"]',
      '[class*="spinner"]',
      '[class*="Spinner"]',
      '[class*="loader"]',
      '[class*="Loader"]',
      '[class*="loading"]',
      '[class*="Loading"]',
      '[class*="progress"]',
      '[class*="Progress"]',
    ].join(',');

    const loaderVisible = Array.from(document.querySelectorAll(loaderSelectors)).some((el) => {
      if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.bottom >= -40 && rect.top <= window.innerHeight + 200;
    });

    return {
      viewportHeight,
      scrollY,
      scrollHeight,
      bottomGap,
      loaderVisible,
    };
  });
}

async function waitForLibraryGrowth(page, beforeVisibleCount, beforeScrollHeight, timeoutMs, seenUrls) {
  const deadline = Date.now() + timeoutMs;
  let lastMetrics = await getLibraryMetrics(page);

  while (Date.now() < deadline) {
    const [rows, metrics] = await Promise.all([
      collectVisibleImageItems(page),
      getLibraryMetrics(page),
    ]);

    lastMetrics = metrics;
    let hasNewVisible = false;
    if (seenUrls) {
      for (const row of rows) {
        const url = normalizeUrl(row.url);
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        hasNewVisible = true;
      }
    } else if (rows.length > beforeVisibleCount) {
      hasNewVisible = true;
    }

    if (hasNewVisible || metrics.scrollHeight > beforeScrollHeight + 32) {
      return {
        grew: true,
        visibleCount: rows.length,
        metrics,
      };
    }

    await sleep(250);
  }

  return {
    grew: false,
    visibleCount: beforeVisibleCount,
    metrics: lastMetrics,
  };
}

async function recoverStalledInfiniteScroll(page, beforeVisibleCount, beforeScrollHeight, priorMetrics, seenUrls) {
  for (let attempt = 1; attempt <= CONFIG.recoveryAttemptsPerStall; attempt += 1) {
    const upStep = Math.max(500, Math.floor(priorMetrics.viewportHeight * (0.9 + attempt * 0.2)));
    const downStep = upStep + Math.max(700, Math.floor(priorMetrics.viewportHeight * 1.1));

    console.log(
      `Scroll stall detected${priorMetrics.loaderVisible ? ' (loader visible)' : ''}; ` +
      `recovery ${attempt}/${CONFIG.recoveryAttemptsPerStall}...`
    );

    await page.bringToFront().catch(() => {});
    await page.mouse.move(200, 200).catch(() => {});
    await page.mouse.wheel(0, -upStep).catch(async () => {
      await page.evaluate((amount) => window.scrollBy(0, -amount), upStep);
    });
    await sleep(700 + attempt * 200);

    await page.mouse.wheel(0, downStep).catch(async () => {
      await page.evaluate((amount) => window.scrollBy(0, amount), downStep);
    });

    const result = await waitForLibraryGrowth(
      page,
      beforeVisibleCount,
      beforeScrollHeight,
      CONFIG.recoveryWaitMs + (priorMetrics.loaderVisible ? 1000 : 0),
      seenUrls
    );

    if (result.grew) {
      return true;
    }
  }

  return false;
}

async function fillPendingQueueFromLibrary(page, manifest, targetPending) {
  await page.bringToFront().catch(() => {});
  await page.mouse.move(200, 200).catch(() => {});

  const alreadyPending = countPendingItems(manifest);
  if (alreadyPending >= targetPending) {
    console.log(`Pending queue already has ${alreadyPending} items, enough for this batch.`);
    return { reachedEnd: false, pending: alreadyPending };
  }

  console.log(`Harvesting until at least ${targetPending} pending items are queued...`);

  let stalled = 0;
  const seenUrls = new Set();

  while (countPendingItems(manifest) < targetPending) {
    const missing = Math.max(1, targetPending - countPendingItems(manifest));
    const { visibleCount, added, promptUpdates, sample } = await addVisibleImageItemsToManifest(
      page,
      manifest,
      missing,
      seenUrls
    );
    const pending = countPendingItems(manifest);

    console.log(`Visible image URLs this pass: ${visibleCount}`);
    console.log(`Added this pass: ${added} | Prompt updates: ${promptUpdates} | Pending queue: ${pending} | Total harvested: ${manifest.totals.harvested}`);

    for (const row of sample) {
      console.log(`  sample: ${truncateForConsole(row.promptText, 95)} -> ${shortUrl(row.url)}`);
    }

    if (pending >= targetPending) {
      return { reachedEnd: false, pending };
    }

    const beforeMetrics = await getLibraryMetrics(page);

    await page.mouse.wheel(0, CONFIG.scrollStepPx).catch(async () => {
      await page.evaluate((amount) => window.scrollBy(0, amount), CONFIG.scrollStepPx);
    });

    await sleep(500);
    const afterMetrics = await getLibraryMetrics(page);
    const viewportForThreshold = afterMetrics.viewportHeight > 0 ? afterMetrics.viewportHeight : 0;
    const fallbackThreshold = 800;
    const thresholdPx = Math.max(
      fallbackThreshold,
      Math.floor(viewportForThreshold * CONFIG.stallStartBottomGapMultiplier)
    );

    if (afterMetrics.bottomGap > thresholdPx) {
      await sleep(150);
      stalled = 0;
      continue;
    }

    const growth = await waitForLibraryGrowth(
      page,
      visibleCount,
      beforeMetrics.scrollHeight,
      CONFIG.postScrollWaitMs + (beforeMetrics.loaderVisible ? 600 : 0),
      seenUrls
    );

    if (growth.grew) {
      stalled = 0;
      continue;
    }

    const recovered = await recoverStalledInfiniteScroll(
      page,
      visibleCount,
      beforeMetrics.scrollHeight,
      beforeMetrics,
      seenUrls
    );

    if (recovered) {
      stalled = 0;
      continue;
    }

    stalled += 1;
    console.log(`No new image URLs after scroll (${stalled}/${CONFIG.maxStalledScrolls})`);

    if (stalled >= CONFIG.maxStalledScrolls) {
      console.log('Treating the library as temporarily exhausted or stuck after repeated recovery attempts.');
      return { reachedEnd: true, pending: countPendingItems(manifest) };
    }
  }

  return { reachedEnd: false, pending: countPendingItems(manifest) };
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}`;
  } catch {
    return String(url || '');
  }
}

function truncateForConsole(text, maxLen) {
  const t = normalizePromptText(text);
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 4).trimEnd()} ...`;
}

async function extractPromptFromImagePageStrict(page) {
  await page.getByText(/^(Prompt|Remix)$/, { exact: true }).first().waitFor({
    state: 'visible',
    timeout: 5000,
  }).catch(() => {});

  await sleep(250);

  const promptText = await page.evaluate(() => {
    const normalize = (text) => String(text || '').replace(/\r\n?/g, '\n').trim();

    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const isPromptLabel = (text) => text === 'Prompt' || text === 'Remix';

    const labels = Array.from(document.querySelectorAll('div, span, p')).filter((el) =>
      el instanceof HTMLElement &&
      isVisible(el) &&
      isPromptLabel(normalize(el.textContent || ''))
    );

    for (const label of labels) {
      let sibling = label.nextElementSibling;

      while (sibling) {
        if (sibling instanceof HTMLElement && isVisible(sibling)) {
          const text = normalize(sibling.textContent || sibling.innerText || '');
          if (text && !isPromptLabel(text)) {
            return text;
          }
        }
        sibling = sibling.nextElementSibling;
      }

      const parent = label.parentElement;
      if (parent) {
        const button = Array.from(parent.querySelectorAll('button')).find((el) => {
          if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
          const text = normalize(el.textContent || el.innerText || '');
          return Boolean(text && !isPromptLabel(text));
        });

        if (button) {
          return normalize(button.textContent || button.innerText || '');
        }
      }
    }

    return '';
  });

  return normalizePromptText(promptText);
}

async function clickDownloadOnImagePage(page) {
  const attempts = [
    async () => {
      const locator = page.getByRole('button', { name: 'Download' });
      await locator.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await locator.count()) {
        await locator.first().click();
        return true;
      }
      return false;
    },
    async () => {
      const locator = page.getByRole('menuitem', { name: 'Download' });
      if (await locator.count()) {
        await locator.first().click();
        return true;
      }
      return false;
    },
    async () => {
      const locator = page.getByRole('link', { name: 'Download' });
      if (await locator.count()) {
        await locator.first().click();
        return true;
      }
      return false;
    },
    async () => {
      const clicked = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')
        );
        const target = candidates.find((el) => {
          const text = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`
            .replace(/\s+/g, ' ')
            .trim();
          return /^download$/i.test(text);
        });
        if (target instanceof HTMLElement) {
          target.click();
          return true;
        }
        return false;
      });
      return clicked;
    },
    async () => {
      await page.keyboard.press('d');
      return true;
    },
  ];

  for (const attempt of attempts) {
    try {
      const ok = await attempt();
      if (ok) return;
    } catch {
      // try next fallback
    }
  }

  throw new Error('Could not find a usable Download control on the image page.');
}

function extractImageId(url, suggestedFilename) {
  const suggestedBase = path.basename(suggestedFilename || '');
  const fromSuggested = suggestedBase.match(/_([A-Za-z0-9]+)\.[^.]+$/);
  if (fromSuggested) {
    return fromSuggested[1];
  }

  const fromUrl = String(url || '').match(/\/g\/gen_([A-Za-z0-9]+)/);
  if (fromUrl) {
    return fromUrl[1];
  }

  return sha1(`${url} ${suggestedFilename || ''}`).slice(0, 26);
}

function buildFileName(promptText, suggestedFilename, url) {
  const ext = path.extname(suggestedFilename || '') || '.jpg';
  const imageId = extractImageId(url, suggestedFilename);

const promptBase = normalizeText(promptText) || 'no prompt found';

  let promptPart = truncatePromptForFilename(promptBase, CONFIG.promptMaxLen);
  let filename = `${promptPart}_${imageId}${ext}`;

  if (process.platform === 'win32') {
    let fullPath = path.join(CONFIG.outputDir, filename);
    if (fullPath.length > CONFIG.maxWindowsPathLen) {
      const overflow = fullPath.length - CONFIG.maxWindowsPathLen;
      const shorterPromptLen = Math.max(60, CONFIG.promptMaxLen - overflow - 8);
      promptPart = truncatePromptForFilename(promptBase, shorterPromptLen);
      filename = `${promptPart}_${imageId}${ext}`;
      fullPath = path.join(CONFIG.outputDir, filename);

      if (fullPath.length > CONFIG.maxWindowsPathLen) {
        const maxPromptChars = Math.max(40, shorterPromptLen - (fullPath.length - CONFIG.maxWindowsPathLen) - 4);
        promptPart = truncatePromptForFilename(promptBase, maxPromptChars);
        filename = `${promptPart}_${imageId}${ext}`;
      }
    }
  }

  return filename;
}

function sanitizeSuggestedFilename(suggestedFilename, url) {
  const base = sanitizeFilenameComponent(path.basename(suggestedFilename || ''));
  const ext = path.extname(base) || path.extname(suggestedFilename || '') || '.jpg';
  const stem = path.basename(base, path.extname(base) || ext) || 'image';
  const safeStem = sanitizeFilenameComponent(stem) || 'image';
  const safeName = `${safeStem}${ext}`;
  if (safeName && safeName !== ext) return safeName;
  const imageId = extractImageId(url, suggestedFilename);
  return `image_${imageId}${ext}`;
}

async function resolveFilenameCollision(dir, filename) {
  let candidate = filename;
  let counter = 1;
  while (true) {
    const fullPath = path.join(dir, candidate);
    try {
      await fs.access(fullPath);
      counter += 1;
      const parsed = path.parse(filename);
      candidate = `${parsed.name}_${counter}${parsed.ext}`;
    } catch {
      return candidate;
    }
  }
}

function toPromptSidecarName(imageFilename) {
  const parsed = path.parse(imageFilename);
  return `${parsed.name}.txt`;
}

async function downloadQueuedImages(workerPage, libraryPage, manifest, limit) {
  let downloaded = 0;
  let consecutiveErrors = 0;

  for (const url of manifest.queue) {
    if (downloaded >= limit) break;

    const item = manifest.items[url];
    if (!isDownloadableItem(item)) continue;

    console.log(`Opening ${item.order}/${manifest.queue.length}: ${url}`);

    try {
      item.status = 'opening';
      item.lastVisitedAt = new Date().toISOString();
      await saveManifest(CONFIG.manifestPath, manifest);

      if (manifest.totals.downloaded > 0 && manifest.totals.downloaded % CONFIG.workerResyncEvery === 0) {
        const sessionKeys = await syncWorkerSessionFromLibrary(workerPage, libraryPage).catch(() => 0);
        console.log(`  resynced worker sessionStorage from library tab (${sessionKeys} keys).`);
      }

      await workerPage.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(CONFIG.settleAfterGotoMs);

      if (!item.promptText || isClearlyBadPromptText(item.promptText)) {
        const strictPrompt = await extractPromptFromImagePageStrict(workerPage);
        if (strictPrompt && !isClearlyBadPromptText(strictPrompt)) {
          item.promptText = strictPrompt;
          item.promptSource = 'image-page';
        }
      }

      let download = null;
      let lastDownloadError = null;

      for (let attempt = 1; attempt <= CONFIG.downloadStartRetriesPerVisit; attempt += 1) {
        if (attempt > 1) {
          console.log(`  download did not start; refreshing worker page/session and retrying (${attempt}/${CONFIG.downloadStartRetriesPerVisit})...`);
          await syncWorkerSessionFromLibrary(workerPage, libraryPage).catch(() => {});
          await workerPage.goto(url, { waitUntil: 'domcontentloaded' });
          await sleep(CONFIG.settleAfterGotoMs);
        }

        try {
          const downloadPromise = workerPage.waitForEvent('download', {
            timeout: CONFIG.perDownloadTimeoutMs,
          });

          if (attempt === 1) {
            await clickDownloadOnImagePage(workerPage);
          } else {
            await workerPage.bringToFront().catch(() => {});
            await workerPage.mouse.move(20, 20).catch(() => {});
            await workerPage.keyboard.press('d', { delay: 100 });
          }

          download = await downloadPromise;
          break;
        } catch (error) {
          lastDownloadError = error;
          if (!isDownloadStartTimeout(error)) {
            throw error;
          }
        }
      }

      if (!download) {
        throw lastDownloadError || new Error('Download did not start.');
      }

      const failure = await download.failure();
      if (failure) {
        throw new Error(`Download failed: ${failure}`);
      }

      const suggestedBase = path.basename(download.suggestedFilename() || '');
      console.log(`  suggested filename: ${truncateForConsole(suggestedBase || '(empty)', 160)}`);

      let filename = suggestedBase;
      let targetPath = '';
      let usedSanitized = false;

      if (!filename) {
        filename = sanitizeSuggestedFilename(suggestedBase, url);
        filename = await resolveFilenameCollision(CONFIG.outputDir, filename);
        targetPath = path.join(CONFIG.outputDir, filename);
        await download.saveAs(targetPath);
        usedSanitized = true;
      } else {
        filename = await resolveFilenameCollision(CONFIG.outputDir, filename);
        targetPath = path.join(CONFIG.outputDir, filename);
        try {
          await download.saveAs(targetPath);
        } catch (error) {
          const sanitized = sanitizeSuggestedFilename(filename, url);
          const sanitizedResolved = await resolveFilenameCollision(CONFIG.outputDir, sanitized);
          const sanitizedPath = path.join(CONFIG.outputDir, sanitizedResolved);
          await download.saveAs(sanitizedPath);
          filename = sanitizedResolved;
          targetPath = sanitizedPath;
          usedSanitized = true;
        }
      }

      if (usedSanitized) {
        console.log(`  saved with sanitized filename: ${truncateForConsole(filename, 160)}`);
      } else {
        console.log(`  saving as: ${truncateForConsole(filename, 160)}`);
      }

      const promptSidecar = toPromptSidecarName(filename);
      const promptPath = path.join(CONFIG.outputDir, promptSidecar);
      await fs.writeFile(promptPath, item.promptText || '', 'utf8');

      item.status = 'done';
      item.filename = filename;
      item.savedAt = new Date().toISOString();
      item.error = undefined;
      manifest.totals.downloaded += 1;
      downloaded += 1;
      consecutiveErrors = 0;
      await saveManifest(CONFIG.manifestPath, manifest);

      console.log(`Saved: ${filename}`);
      await sleep(CONFIG.settleAfterSaveMs);
    } catch (error) {
      item.status = 'error';
      item.error = String(error && error.stack ? error.stack : error);
      item.failedAt = new Date().toISOString();
      manifest.totals.errors += 1;
      consecutiveErrors += 1;
      await saveManifest(CONFIG.manifestPath, manifest);

      const shotBase = `error_${pad(item.order, 6)}`;
      const shot = path.join(CONFIG.screenshotDir, `${shotBase}.png`);
      const shotMeta = path.join(CONFIG.screenshotDir, `${shotBase}.txt`);
      try {
        await workerPage.screenshot({ path: shot, fullPage: false });
      } catch {}
      try {
        const workerUrl = await workerPage.url();
        await fs.appendFile(
          shotMeta,
          `Failed on item ${item.order}: \n${url}\n${error.stack || error}\n${workerUrl || ''}\n`,
          'utf8'
        );
      } catch {}

      console.error(`Failed on item ${item.order}: ${url}`);
      console.error(error);
      console.error(`Screenshot: ${shot}`);
      console.error(`Worker URL: ${shotMeta}`);
      console.error('Continuing to the next item.');

      if (consecutiveErrors >= CONFIG.maxConsecutiveErrors) {
        throw new Error(
          `Stopping after ${CONFIG.maxConsecutiveErrors} consecutive download failures. ` +
          'This usually means the session or page state needs attention.'
        );
      }
    }
  }

  return downloaded;
}

async function runBatches(libraryPage, workerPage, manifest) {
  let downloadsThisRun = 0;
  let reachedEnd = false;

  while (true) {
    const remainingAllowance = CONFIG.maxDownloads === null
      ? Infinity
      : CONFIG.maxDownloads - downloadsThisRun;

    if (remainingAllowance <= 0) {
      console.log('Reached maxDownloads test limit for this run.');
      break;
    }

    const targetPending = batchTarget(remainingAllowance);
    const pendingBeforeHarvest = countPendingItems(manifest);

    console.log(`Pending queued items before harvest: ${pendingBeforeHarvest}`);

    if (pendingBeforeHarvest < targetPending && !reachedEnd) {
      const harvestResult = await fillPendingQueueFromLibrary(libraryPage, manifest, targetPending);
      reachedEnd = harvestResult.reachedEnd;
      await saveManifest(CONFIG.manifestPath, manifest);
    }

    const pendingAfterHarvest = countPendingItems(manifest);
    console.log(`Pending queued items after harvest: ${pendingAfterHarvest}`);

    if (pendingAfterHarvest === 0) {
      if (reachedEnd) {
        console.log('No pending items remain and the library appears exhausted. Stopping.');
        break;
      }

      console.log('No pending items are available yet; retrying harvest.');
      continue;
    }

    const limitThisBatch = remainingAllowance === Infinity
      ? Math.min(pendingAfterHarvest, targetPending)
      : Math.min(pendingAfterHarvest, remainingAllowance);

    console.log(`Starting download batch of up to ${limitThisBatch} items...`);

    const downloaded = await downloadQueuedImages(workerPage, libraryPage, manifest, limitThisBatch);
    downloadsThisRun += downloaded;

    console.log(`Downloaded this run so far: ${downloadsThisRun}`);

    if (CONFIG.maxDownloads !== null && downloadsThisRun >= CONFIG.maxDownloads) {
      console.log('Reached maxDownloads test limit for this run.');
      break;
    }

    if (downloaded === 0) {
      if (reachedEnd) {
        console.log('No more downloadable items could be processed. Stopping.');
        break;
      }

      console.log('This batch produced no downloads; going back to harvest.');
    }

    if (reachedEnd && countPendingItems(manifest) === 0) {
      console.log('All harvested items are processed and no new items are appearing. Stopping.');
      break;
    }
  }
}

async function main() {
  await ensureDir(CONFIG.outputDir);
  await ensureDir(CONFIG.screenshotDir);

  const manifest = await loadManifest(CONFIG.manifestPath);

  const browser = await chromium.connectOverCDP(CONFIG.cdpUrl);
  const context = await findAttachedContext(browser);

  await promptEnter(
    [
      'In the already-open Chrome window:',
      '- make sure you are signed into Sora',
      '- switch to Old Sora mode',
      '- open the image library tab',
      '- leave that tab open',
      '- avoid using that Chrome window while the script runs',
      '',
      'Then press Enter here to begin the batched pass.'
    ].join('\n')
  );

  const libraryPage = await findSoraLibraryPage(context);
  await libraryPage.bringToFront().catch(() => {});

  if (!libraryPage.url().includes('/library?type=images')) {
    console.log(`Navigating attached tab to ${CONFIG.libraryUrl}`);
    await libraryPage.goto(CONFIG.libraryUrl, { waitUntil: 'domcontentloaded' });
    await sleep(CONFIG.settleAfterGotoMs);
  }

  const workerPage = await createWorkerPage(context, libraryPage);

  console.log(`Attached to library page: ${libraryPage.url()}`);
  console.log(`Worker page URL: ${workerPage.url()}`);
  console.log(`Pending queued items already in manifest: ${countPendingItems(manifest)}`);
  console.log(`Manifest path: ${CONFIG.manifestPath}`);

  await runBatches(libraryPage, workerPage, manifest);
  await saveManifest(CONFIG.manifestPath, manifest);

  // try {
  //   await workerPage.close();
  // } catch {}
  //
  await browser.close();

  console.log(`Done. Downloaded total so far: ${manifest.totals.downloaded}`);
  console.log(`Items still marked error: ${countErrorItems(manifest)}`);
  console.log(`Output folder: ${CONFIG.outputDir}`);
  console.log(`Manifest: ${CONFIG.manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
