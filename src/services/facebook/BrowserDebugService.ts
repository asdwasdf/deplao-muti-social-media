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
