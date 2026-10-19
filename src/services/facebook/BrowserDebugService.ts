/**
 * BrowserDebugService.ts
 * Per-account Playwright Chromium instances. Each FB account has its own
 * cookie + browser context — opening account B never closes account A.
 *
 * Reopening an already-open account focuses the existing page (no new
 * process, no extra profile). Closing one account only disposes that one.
 */

import { resolvePlaywrightBrowserPath } from './FacebookUtils';
import { secureGet } from '../secure/SecureSettingsService';
import Logger from '../../utils/Logger';

function fbCookieKey(accountId: string): string {
  return `fb_cookie_${accountId}`;
}

type PlaywrightModule = typeof import('playwright');
let _playwright: PlaywrightModule | null = null;
async function getPlaywright(): Promise<PlaywrightModule> {
  if (_playwright) return _playwright;
  try {
    _playwright = await import('playwright');
    return _playwright;
  } catch (err: any) {
    throw new Error(`Không thể load Playwright: ${err.message}. Chạy 'npm run install:playwright' để cài.`);
  }
}

const FB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export function isFacebookContentUnavailable(text: string): boolean {
  return /Bạn hiện không xem được nội dung này|This content isn't available/i.test(text);
}

export function mergeUniqueHtmlSnapshots(snapshots: string[]): string {
  return Array.from(new Set(snapshots.filter(Boolean))).join('\n');
}

export function isFacebookGroupFeedGraphQLRequest(url: string, body: string): boolean {
  if (!url.includes('/api/graphql/')) return false;
  const name = new URLSearchParams(body).get('fb_api_req_friendly_name') || '';
  return name.startsWith('GroupsCometFeed');
}

export async function openFacebookTab(context: any, url: string): Promise<OpenBrowserResult> {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.bringToFront();
  return { success: true, url: page.url() };
}

export interface OpenBrowserOptions {
  accountId: string;
  startUrl?: string;
  headless?: boolean;
  keepOpen?: boolean;
}

export interface OpenBrowserResult {
  success: boolean;
  url?: string;
  alreadyOpen?: boolean;
  error?: string;
}

export interface RenderedPageResult {
  success: boolean;
  html?: string;
  url?: string;
  title?: string;
  feedReady?: boolean;
  graphqlQueries?: Array<{ name: string; docId: string }>;
  error?: string;
}

export interface RenderPageOptions {
  maxScrolls?: number;
  scrollDelayMs?: number;
  stableScrolls?: number;
}

interface BrowserRecord {
  browser: any;
  context: any;
  page: any;
  headless: boolean;
  keepOpen: boolean;
}

export class BrowserDebugService {
  private static instance: BrowserDebugService;
  private byAccount = new Map<string, BrowserRecord>();

  static getInstance(): BrowserDebugService {
    if (!BrowserDebugService.instance) {
      BrowserDebugService.instance = new BrowserDebugService();
    }
    return BrowserDebugService.instance;
  }

  async openTabWithCookie(accountId: string, url: string): Promise<OpenBrowserResult> {
    if (!accountId) return { success: false, error: 'accountId is required' };
    if (!/^https:\/\/(?:www\.)?facebook\.com\//i.test(url)) {
      return { success: false, error: 'Chỉ cho phép mở URL Facebook HTTPS' };
    }

    let record = this.byAccount.get(accountId);
    if (!record || !record.page || record.page.isClosed()) {
      const opened = await this.openWithCookie({ accountId, startUrl: 'https://www.facebook.com/', keepOpen: true, headless: false });
      if (!opened.success) return opened;
      record = this.byAccount.get(accountId);
    }
    if (!record) return { success: false, error: 'Không khởi tạo được browser Facebook' };

    try {
      return await openFacebookTab(record.context, url);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async openWithCookie(opts: OpenBrowserOptions): Promise<OpenBrowserResult> {
    const accountId = opts.accountId;
    if (!accountId) return { success: false, error: 'accountId is required' };

    // Already open → focus, do not spawn.
    const existing = this.byAccount.get(accountId);
    if (existing) {
      try {
        if (existing.page && !existing.page.isClosed()) {
          await existing.page.bringToFront().catch(() => {});
          return { success: true, alreadyOpen: true, url: existing.page.url() };
        }
      } catch {}
      // Stale entry — drop and reopen.
      this.byAccount.delete(accountId);
    }

    const cookieString = secureGet(fbCookieKey(accountId));
    if (!cookieString) {
      return { success: false, error: `Không có cookie cho account ${accountId}` };
    }

    let browser: any;
    let context: any;
    try {
      const playwright = await getPlaywright();
      const browserPath = resolvePlaywrightBrowserPath();
      if (!browserPath) {
        return { success: false, error: 'Không tìm thấy Playwright Chromium binary.' };
      }

      Logger.log(`[BrowserDebugService] Launching Chromium for account ${accountId.slice(0, 8)}: ${browserPath}`);
      browser = await playwright.chromium.launch({
        executablePath: browserPath,
        headless: !!opts.headless,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--ignore-certificate-errors',
        ],
      });
      context = await browser.newContext({
        userAgent: FB_USER_AGENT,
        locale: 'vi-VN',
        viewport: { width: 1366, height: 768 },
        timezoneId: 'Asia/Ho_Chi_Minh',
        extraHTTPHeaders: {
          'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
          'sec-ch-ua-platform': '"Windows"',
          'sec-ch-ua-mobile': '?0',
          'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });

      const cookies = cookieString
        .split('; ')
        .filter(Boolean)
        .map((pair) => {
          const idx = pair.indexOf('=');
          const name = pair.slice(0, idx);
          const value = decodeURIComponent(pair.slice(idx + 1));
          return {
            name,
            value,
            domain: '.facebook.com',
            path: '/',
            secure: true,
            httpOnly: false,
            sameSite: 'None' as const,
          };
        });
      await context.addCookies(cookies);
      Logger.log(`[BrowserDebugService] Injected ${cookies.length} cookies for account ${accountId.slice(0, 8)}`);

      const page = await context.newPage();
      const url = opts.startUrl || 'https://www.facebook.com/';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      Logger.log(`[BrowserDebugService] Navigated to ${url} for account ${accountId.slice(0, 8)}`);

      this.byAccount.set(accountId, {
        browser,
        context,
        page,
        headless: !!opts.headless,
        keepOpen: opts.keepOpen !== false,
      });

      return { success: true, url };
    } catch (err: any) {
      Logger.error(`[BrowserDebugService] openWithCookie error: ${err.message}`);
      try { if (context) await context.close().catch(() => {}); } catch {}
      try { if (browser) await browser.close().catch(() => {}); } catch {}
      return { success: false, error: err.message };
    }
  }

  /** Render one authenticated page in an isolated headless browser, then close it. */
  async renderWithCookie(
    accountId: string,
    url: string,
    options: RenderPageOptions = {},
  ): Promise<RenderedPageResult> {
    const cookieString = secureGet(fbCookieKey(accountId));
    if (!cookieString) return { success: false, error: `Không có cookie cho account ${accountId}` };

    let browser: any;
    let context: any;
    try {
      const playwright = await getPlaywright();
      const browserPath = resolvePlaywrightBrowserPath();
      if (!browserPath) return { success: false, error: 'Không tìm thấy Playwright Chromium binary.' };

      browser = await playwright.chromium.launch({
        executablePath: browserPath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--ignore-certificate-errors',
        ],
      });
      context = await browser.newContext({
        userAgent: FB_USER_AGENT,
        locale: 'vi-VN',
        viewport: { width: 1366, height: 768 },
        timezoneId: 'Asia/Ho_Chi_Minh',
      });
      const cookies = cookieString.split('; ').filter(Boolean).flatMap((pair) => {
        const idx = pair.indexOf('=');
        if (idx <= 0) return [];
        return [{
          name: pair.slice(0, idx),
          value: decodeURIComponent(pair.slice(idx + 1)),
          domain: '.facebook.com',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'None' as const,
        }];
      });
      await context.addCookies(cookies);
      const page = await context.newPage();
      const graphqlQueries = new Map<string, string>();
      const graphqlResponses: string[] = [];
      page.on('request', (request: any) => {
        if (!request.url().includes('/api/graphql/')) return;
        const body = request.postData() || '';
        const params = new URLSearchParams(body);
        const name = params.get('fb_api_req_friendly_name') || '';
        const docId = params.get('doc_id') || '';
        if (name && docId) graphqlQueries.set(name, docId);
      });
      page.on('response', async (response: any) => {
        const request = response.request();
        const body = request.postData() || '';
        if (!isFacebookGroupFeedGraphQLRequest(response.url(), body)) return;
        const text = await response.text().catch(() => '');
        if (text) graphqlResponses.push(text);
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      let feedReady = true;
      try {
        await page.waitForSelector('[role="feed"] [role="article"], [role="article"]', { timeout: 20000 });
      } catch {
        feedReady = false;
      }

      const maxScrolls = Math.max(0, options.maxScrolls || 0);
      const stableLimit = Math.max(1, options.stableScrolls || 3);
      const snapshots = [await page.content()];
      let stable = 0;
      let previousHeight = 0;
      for (let i = 0; i < maxScrolls && stable < stableLimit; i++) {
        const height = await page.evaluate('document.documentElement.scrollHeight');
        await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
        await page.waitForTimeout(Math.max(250, options.scrollDelayMs || 1500));
        snapshots.push(await page.content());
        const nextHeight = await page.evaluate('document.documentElement.scrollHeight');
        stable = nextHeight <= height && nextHeight <= previousHeight ? stable + 1 : 0;
        previousHeight = nextHeight;
      }

      const html = mergeUniqueHtmlSnapshots([...snapshots, ...graphqlResponses]);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (isFacebookContentUnavailable(bodyText)) {
        return {
          success: false,
          url: page.url(),
          title: await page.title(),
          error: 'Tài khoản Facebook không có quyền xem group hoặc group không tồn tại.',
        };
      }
      return {
        success: true,
        html,
        url: page.url(),
        title: await page.title(),
        feedReady,
        graphqlQueries: Array.from(graphqlQueries, ([name, docId]) => ({ name, docId })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    } finally {
      try { if (context) await context.close(); } catch {}
      try { if (browser) await browser.close(); } catch {}
    }
  }

  /** Close one account's browser, or all if accountId omitted. */
  async close(accountId?: string): Promise<void> {
    if (accountId) {
      const rec = this.byAccount.get(accountId);
      if (!rec) return;
      this.byAccount.delete(accountId);
      await this.dispose(rec);
      Logger.log(`[BrowserDebugService] Closed browser for account ${accountId.slice(0, 8)}`);
      return;
    }
    const ids = Array.from(this.byAccount.keys());
    this.byAccount.clear();
    for (const id of ids) {
      const rec = this.byAccount.get(id); // may be empty; that's fine
      if (rec) await this.dispose(rec);
    }
    Logger.log('[BrowserDebugService] Closed all browsers');
  }

  listOpen(): string[] {
    // Prune any closed pages lazily before returning.
    for (const [id, rec] of this.byAccount) {
      try {
        if (!rec.page || rec.page.isClosed()) this.byAccount.delete(id);
      } catch {
        this.byAccount.delete(id);
      }
    }
    return Array.from(this.byAccount.keys()).sort();
  }

  isOpen(accountId: string): boolean {
    const rec = this.byAccount.get(accountId);
    if (!rec) return false;
    try { return !rec.page.isClosed(); } catch { return false; }
  }

  private async dispose(rec: BrowserRecord): Promise<void> {
    try { if (rec.context) await rec.context.close().catch(() => {}); } catch {}
    try { if (rec.browser) await rec.browser.close().catch(() => {}); } catch {}
  }
}

export default BrowserDebugService;
