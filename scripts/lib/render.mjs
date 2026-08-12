import { chromium } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ローカル検証用の逃げ道。CI では playwright install したブラウザをそのまま使うので未設定でよい。
const EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

const NAV_TIMEOUT_MS = 45_000;
const RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ヘッドレスブラウザを1つ立ち上げ、複数ページの取得に使い回す。
// fetch と違い、対象サイトが JS でDOMを描画するSPAでも描画後のHTMLが取れる。
export async function withBrowser(fn) {
  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: 'ja-JP',
      extraHTTPHeaders: { 'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8' },
    });
    return await fn({
      render: (url, opts) => renderWithRetry(context, url, opts),
    });
  } finally {
    await browser.close();
  }
}

async function renderWithRetry(context, url, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await renderOnce(context, url, opts);
    } catch (err) {
      lastErr = err;
      // 一過性のネットワークエラー (実運用で ECONNRESET を観測済み) は間を置いて再試行する。
      console.warn(`render failed (attempt ${attempt}/${RETRIES}) for ${url}: ${err.message}`);
      if (attempt < RETRIES) await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

async function renderOnce(context, url, { waitForSelector } = {}) {
  const page = await context.newPage();
  try {
    const res = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });
    if (res && !res.ok()) {
      throw new Error(`GET ${url} -> ${res.status()}`);
    }

    // 目印になる要素が指定されていればそれを待つ。無ければ通信が落ち着くのを待つ。
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: NAV_TIMEOUT_MS });
    } else {
      await page
        .waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS })
        .catch(() => console.warn(`networkidle timed out for ${url}; using current DOM`));
    }

    return await page.content();
  } finally {
    await page.close();
  }
}
