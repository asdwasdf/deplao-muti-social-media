/**
 * BrowserLoginService.ts
 * Singleton quản lý Playwright Chromium instances cho FB login bằng browser thật.
 * 1 attempt = 1 BrowserContext, FIFO queue.
 */

import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { resolvePlaywrightBrowserPath } from './FacebookUtils';
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';

// Lazy require Playwright để không crash app khi chưa cài browser
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

export type BrowserLoginEvent =
  | { kind: 'opening' }
  | { kind: 'navigating' }
  | { kind: 'waitingUser' }
  | { kind: 'captchaDetected' }
  | { kind: 'twofaRequired' }
  | { kind: 'verifying' }
  | { kind: 'success'; facebookId: string; name: string; cookie: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

export interface BrowserLoginParams {
  proxyId?: number | null;
  headless?: boolean;
}

export interface BrowserLoginStartResult {
  sessionId: string;
}

type QueueItem = {
  sessionId: string;
  params: BrowserLoginParams;
  onEvent: (ev: BrowserLoginEvent) => void;
  resolveStart: (res: BrowserLoginStartResult) => void;
};

type ActiveAttempt = {
  sessionId: string;
  context: import('playwright').BrowserContext | null;
  browser: import('playwright').Browser | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  proxyId: number | null;
  onEvent: (ev: BrowserLoginEvent) => void;
  done: boolean;
};

const BROWSER_LOGIN_TTL_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;
const NAV_TIMEOUT_MS = 60_000;
const MOBILE_LOGIN_URL = 'https://m.facebook.com/login/';

class BrowserLoginService {
  private static instance: BrowserLoginService | null = null;
  private emitter = new EventEmitter();
  private queue: QueueItem[] = [];
  private active: ActiveAttempt | null = null;
  private currentProxyUrl: string | null = null;
  private startingPromise: Promise<void> | null = null;

  static getInstance(): BrowserLoginService {
    if (!BrowserLoginService.instance) {
      BrowserLoginService.instance = new BrowserLoginService();
    }
    return BrowserLoginService.instance;
  }

  private constructor() {}

  /** Renderer gọi. Trả sessionId ngay; attempt chạy tuần tự qua queue. */
  async start(
    params: BrowserLoginParams,
    onEvent: (ev: BrowserLoginEvent) => void
  ): Promise<BrowserLoginStartResult> {
    const sessionId = uuid();
    return new Promise<BrowserLoginStartResult>((resolveStart) => {
      const item: QueueItem = { sessionId, params, onEvent, resolveStart };
      this.queue.push(item);
      this.emitter.emit('queued', { sessionId });
      this.pump();
      resolveStart({ sessionId });
    });
  }

  async cancel(sessionId: string): Promise<void> {
    // Xóa khỏi queue nếu đang chờ
    const idx = this.queue.findIndex(q => q.sessionId === sessionId);
    if (idx >= 0) {
      const [item] = this.queue.splice(idx, 1);
      item.onEvent({ kind: 'cancelled' });
      return;
    }
    // Nếu đang active → dispose
    if (this.active?.sessionId === sessionId) {
      this.active.onEvent({ kind: 'cancelled' });
      await this.disposeActive();
      this.pump();
    }
  }

  private async pump(): Promise<void> {
    if (this.active || this.startingPromise) return;
    const next = this.queue.shift();
    if (!next) return;

    const attempt: ActiveAttempt = {
      sessionId: next.sessionId,
      context: null,
      browser: null,
      pollTimer: null,
      expiryTimer: null,
      proxyId: next.params.proxyId ?? null,
      onEvent: next.onEvent,
      done: false,
    };
    this.active = attempt;

    // TTL
    attempt.expiryTimer = setTimeout(() => {
      if (!attempt.done) {
        attempt.onEvent({ kind: 'error', message: 'Phiên đăng nhập hết hạn (15 phút). Vui lòng thử lại.' });
        this.disposeActive().then(() => this.pump());
      }
    }, BROWSER_LOGIN_TTL_MS);

    this.startingPromise = this.runAttempt(attempt);
    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  private async runAttempt(attempt: ActiveAttempt): Promise<void> {
    try {
      attempt.onEvent({ kind: 'opening' });
      const playwright = await getPlaywright();
      const browserPath = resolvePlaywrightBrowserPath();
      Logger.log(`[BrowserLoginService] Launching Chromium: ${browserPath}`);

      // Resolve proxy
      let proxyOpt: { server: string; username?: string; password?: string } | undefined;
      if (attempt.proxyId) {
        try {
          const proxy = DatabaseService.getInstance().getProxyById(attempt.proxyId);
          if (proxy) {
            if (proxy.type === 'socks4') {
              // Playwright không hỗ trợ SOCKS4, warn
              Logger.warn(`[BrowserLoginService] Proxy ${proxy.name} dùng SOCKS4, Playwright chỉ hỗ trợ SOCKS5. Fallback về no proxy.`);
            } else {
              proxyOpt = {
                server: `${proxy.type}://${proxy.host}:${proxy.port}`,
                username: proxy.username || undefined,
                password: proxy.password || undefined,
              };
              this.currentProxyUrl = proxyOpt.server;
            }
          }
        } catch (err: any) {
          Logger.warn(`[BrowserLoginService] Không resolve được proxy ${attempt.proxyId}: ${err.message}`);
        }
      }

      const browser = await playwright.chromium.launch({
        executablePath: browserPath,
        headless: !!attempt.proxyId ? true : false, // mặc định headed để user thấy, force headless nếu qua proxy
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
      });
      attempt.browser = browser;

      const context = await browser.newContext({
        ...(proxyOpt ? { proxy: proxyOpt } : {}),
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        locale: 'vi-VN',
        viewport: { width: 1280, height: 800 },
        timezoneId: 'Asia/Ho_Chi_Minh',
        extraHTTPHeaders: { 'sec-ch-ua-platform': '"Windows"' },
      });
      attempt.context = context;

      const page = await context.newPage();
      attempt.onEvent({ kind: 'navigating' });

      // Anti-bot: xoá navigator.webdriver
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      try {
        await page.goto(MOBILE_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      } catch (err: any) {
        throw new Error(`Không tải được trang login Facebook: ${err.message}`);
      }

      attempt.onEvent({ kind: 'waitingUser' });

      // Poll cookies cho tới khi có c_user + xs
      const success = await this.pollForLogin(attempt, page);
      if (!success) {
        // cancelled hoặc timeout đã gửi event
        return;
      }

      attempt.onEvent({ kind: 'verifying' });
      const cookies = await context.cookies();
      const fbCookies = cookies.filter(c => /\.facebook\.com$/.test(c.domain));
      const cookieMap: Record<string, string> = {};
      for (const c of fbCookies) {
        if (c.name && c.value) cookieMap[c.name] = c.value;
      }
      if (!cookieMap.c_user || !cookieMap.xs) {
        throw new Error('Cookie thiếu c_user hoặc xs. Có thể tài khoản bị checkpoint.');
      }
      const cookieString = Object.entries(cookieMap).map(([n, v]) => `${n}=${v}`).join('; ');

      attempt.done = true;
      attempt.onEvent({
        kind: 'success',
        facebookId: cookieMap.c_user,
        name: cookieMap.c_user,
        cookie: cookieString,
      });
    } catch (err: any) {
      Logger.warn(`[BrowserLoginService] Attempt error: ${err.message}`);
      if (!attempt.done) {
        attempt.done = true;
        attempt.onEvent({ kind: 'error', message: err.message || String(err) });
      }
    } finally {
      await this.disposeActive();
      this.pump();
    }
  }

  private async pollForLogin(attempt: ActiveAttempt, page: import('playwright').Page): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const tick = async () => {
        if (attempt.done) {
          resolve(false);
          return;
        }
        try {
          const cookies = await attempt.context!.cookies();
          const cUser = cookies.find(c => c.name === 'c_user');
          const xs = cookies.find(c => c.name === 'xs');
          const hasUser = cUser?.value?.length > 0;
          const hasXs = xs?.value?.length > 0;
          Logger.log(`[BrowserLoginService] Poll cookies: c_user=${!!cUser?.value} (${cUser?.value?.substring(0,8)}...), xs=${!!xs?.value}, url=${page.url().substring(0,60)}`);
          // Detect 2FA / checkpoint URL changes
          const url = page.url();
          if (/checkpoint|checkpoint\//.test(url) || /two_step/.test(url)) {
            attempt.onEvent({ kind: 'twofaRequired' });
          }
          if (hasUser && hasXs) {
            if (attempt.pollTimer) {
              clearInterval(attempt.pollTimer);
              attempt.pollTimer = null;
            }
            clearInterval(checkDone);
            resolve(true);
            return;
          }
        } catch (err: any) { Logger.warn(`[BrowserLoginService] Poll error: ${err.message}`); }
      };
      attempt.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
      // Stop polling khi dispose
      const origDone = attempt.done;
      const checkDone = setInterval(() => {
        if (attempt.done !== origDone || !this.active || this.active.sessionId !== attempt.sessionId) {
          if (attempt.pollTimer) clearInterval(attempt.pollTimer);
          clearInterval(checkDone);
          resolve(false);
        }
      }, 500);
    });
  }

  private async disposeActive(): Promise<void> {
    if (!this.active) return;
    const a = this.active;
    this.active = null;
    if (a.pollTimer) clearInterval(a.pollTimer);
    if (a.expiryTimer) clearTimeout(a.expiryTimer);
    try { if (a.context) await a.context.close().catch(() => {}); } catch {}
    try { if (a.browser) await a.browser.close().catch(() => {}); } catch {}
    this.currentProxyUrl = null;
  }

  get activeSessionId(): string | null {
    return this.active?.sessionId ?? null;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}

export default BrowserLoginService;
