/**
 * FacebookAutoCommentService.ts
 * Service tự động comment vào các bài viết trong groups được chọn
 *
 * Luồng (multi-account, flow/job tách biệt):
 * 1. Worker (scheduler) tick → với mỗi enabled flow quá hạn → enqueueJob
 * 2. Job chờ slot toàn cục (≤3) + account lock (1 job / account tại 1 thời điểm)
 * 3. Job chạy runConfig → log per-post vào fb_auto_comment_logs với job_id
 * 4. Kết thúc: cập nhật fb_auto_comment_jobs (status, started_at, ended_at, counters)
 *
 * Manual + scheduled cùng đi qua enqueueJob → cùng lock → chống duplicate.
 */

import DatabaseService from '../database/DatabaseService';
import FacebookService from './FacebookService';
import { FacebookScanService } from './FacebookScanService';
import { BrowserDebugService } from './BrowserDebugService';
import { secureGet } from '../secure/SecureSettingsService';
import Logger from '../../utils/Logger';
import { v4 as uuid } from 'uuid';
import {
  AutoCommentConfig,
  AutoCommentJob,
  AutoCommentJobStatus,
  AutoCommentLog,
  AutoCommentRunResult,
} from '../../models/autoComment';
import axios from 'axios';
import { buildFormData, buildGraphQLRequest, buildPostConfig, parseFBResponse, jsonMinimal, getNextReqId } from './FacebookUtils';
import { assertFacebookMutationSuccess } from './FacebookGraphQLResult';

const GRAPHQL_URL = 'https://www.facebook.com/webgraphql/mutation/';

// ─── Doc IDs + Friendly names (captured từ browser DevTools) ────────────────
// Nếu comment thất bại với lỗi "Invalid value ... passed to argument feedback_id"
// hoặc "field_exception" trên useCometUFICreateCommentMutation → FB đã rotate doc_id.
// Cách capture mới: mở post trong Chrome đã login FB → F12 Network → filter graphql →
// comment thử 1 chữ "ok" bằng tay → click request → copy doc_id từ Payload.
// Update dòng bên dưới rồi build lại.
const DOC_ID_CREATE_COMMENT = '29732233479699606';
// Doc ID 9815271091886179 đã bị Facebook rotate → dùng Pagination query mới
// (load feed khi scroll). Có thể cần initial query riêng để lấy cursor.
const DOC_ID_GROUP_FEED_PAGINATION = '28295952946774461';
const FRIENDLY_GROUP_FEED_PAGINATION = 'GroupsCometFeedRegularStoriesPaginationQuery';
const DOC_ID_GROUP_ROOT = '4901247942874490';
const FRIENDLY_CREATE_COMMENT = 'useCometUFICreateCommentMutation';
const FRIENDLY_GROUP_ROOT = 'GroupsCometQuery';

function fbCookieKey(accountId: string): string {
  return `fb_cookie_${accountId}`;
}

/**
 * Chuẩn hóa group ID: chấp nhận URL đầy đủ, relative path, hoặc ID số thuần.
 * GraphQL cần numeric group ID, không phải URL.
 */
function normalizeGroupId(raw: string): string {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  const fromUrl = trimmed.match(/groups\/(\d+)/);
  if (fromUrl) return fromUrl[1];
  if (/^\d+$/.test(trimmed)) return trimmed;
  return '';
}

export class FacebookAutoCommentService {
  private static instance: FacebookAutoCommentService;
  private workerTimer: ReturnType<typeof setTimeout> | null = null;
  private workerEnabled: boolean = false;
  private lastTickAt: number = 0;
  private lastTickError: string = '';

  /** Max parallel jobs across all accounts. */
  private readonly GLOBAL_CONCURRENCY = 3;
  /** Per-account serialization. accountId → promise chain. */
  private accountLocks = new Map<string, Promise<unknown>>();
  /** Currently executing job per account (for UI badges). */
  private activeJobByAccount = new Map<string, string>();
  /** Cancel flags by jobId, checked between posts. */
  private cancelFlags = new Map<string, boolean>();
  /** Set of jobIds scheduled but not yet started (so we don't double-enqueue). */
  private pendingJobIds = new Set<string>();
  /** Scheduler last-tick → for "minutesSinceLastRun" UI. */
  private lastRunAt: number = 0;
  private nextRunAt: number = 0;

  static getInstance(): FacebookAutoCommentService {
    if (!FacebookAutoCommentService.instance) {
      FacebookAutoCommentService.instance = new FacebookAutoCommentService();
    }
    return FacebookAutoCommentService.instance;
  }

  // ─── Worker (scheduler) ────────────────────────────────────────────────────

  start(): void {
    if (this.workerEnabled) return;
    this.workerEnabled = true;
    this.lastTickError = '';
    Logger.log('[FacebookAutoCommentService] Worker started');
    this.scheduleNextTick();
  }

  stop(): void {
    if (this.workerTimer) {
      clearTimeout(this.workerTimer);
      this.workerTimer = null;
    }
    this.workerEnabled = false;
    Logger.log('[FacebookAutoCommentService] Worker stopped');
  }

  /**
   * Schedule the next tick. Picks the smallest schedule_minutes across all
   * enabled flows so each flow gets re-evaluated at its own pace inside
   * enqueueDueJobs().
   */
  private scheduleNextTick(): void {
    if (!this.workerEnabled) return;
    const configs = this.getAllEnabledConfigs();
    if (configs.length === 0) {
      // Idle: ping every 60s so newly-saved configs pick up quickly.
      this.nextRunAt = Date.now() + 60_000;
      this.workerTimer = setTimeout(() => this.tick(), 60_000);
      return;
    }
    const minMs = Math.max(60_000, Math.min(...configs.map(c => c.schedule_minutes * 60 * 1000)));
    this.nextRunAt = Date.now() + minMs;
    this.workerTimer = setTimeout(() => this.tick(), minMs);
  }

  private async tick(): Promise<void> {
    if (!this.workerEnabled) return;
    this.lastTickAt = Date.now();
    this.lastRunAt = this.lastTickAt;
    try {
      await this.enqueueDueJobs();
    } catch (err: any) {
      this.lastTickError = err.message || String(err);
      Logger.error(`[FacebookAutoCommentService] Tick crashed: ${this.lastTickError}`);
    } finally {
      this.scheduleNextTick();
    }
  }

  /**
   * For each enabled flow, decide if a new job is due. Enqueue respects
   * per-account lock (one at a time per account) and global concurrency cap.
   */
  private async enqueueDueJobs(): Promise<void> {
    const configs = this.getAllEnabledConfigs();
    const now = Date.now();
    for (const config of configs) {
      // Skip flows whose account has no cookie / no live service.
      if (!secureGet(fbCookieKey(config.account_id))) continue;

      // Don't enqueue another if this account already has pending/running job for this config.
      if (this.activeJobByAccount.get(config.account_id)) {
        const activeJobId = this.activeJobByAccount.get(config.account_id)!;
        if (!this.cancelFlags.get(activeJobId) && this.jobBelongsToConfig(activeJobId, config.id)) {
          continue;
        }
      }
      if (this.hasPendingJobForConfig(config.id)) continue;

      const lastJob = this.getLastJobForConfig(config.id);
      const interval = config.schedule_minutes * 60 * 1000;
      const lastAt = lastJob ? (lastJob.ended_at || lastJob.started_at || lastJob.scheduled_at) : 0;
      if (now - lastAt < interval) continue;

      // Soft cap: don't enqueue if we're at global cap and this account is not already running.
      if (this.activeJobByAccount.size >= this.GLOBAL_CONCURRENCY) continue;

      // Fire-and-forget; enqueueJob handles its own error logging.
      this.enqueueJob(config.id, 'scheduled').catch((err) =>
        Logger.error(`[FacebookAutoCommentService] enqueueJob failed: ${err.message}`),
      );
    }
  }

  // ─── Job lifecycle (manual + scheduled share this) ─────────────────────────

  /**
   * Insert a job row, then schedule execution through the lock pipeline.
   * Returns the jobId immediately so the caller can navigate / poll.
   */
  async enqueueJob(configId: string, trigger: 'manual' | 'scheduled'): Promise<string> {
    const config = this.getConfig(configId);
    if (!config) throw new Error(`Config not found: ${configId}`);
    if (!config.account_id) {
      throw new Error('Config chưa gán tài khoản. Vui lòng chỉnh sửa flow và chọn tài khoản.');
    }

    // Reject duplicate manual clicks: if this config already has pending/running job.
    if (this.hasPendingJobForConfig(configId)) {
      throw new Error('Flow đã có job đang chờ/đang chạy. Vui lòng đợi hoặc dừng.');
    }

    const jobId = uuid();
    const now = Date.now();
    DatabaseService.getInstance().run(
      `INSERT INTO fb_auto_comment_jobs
         (id, config_id, account_id, trigger, status, scheduled_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [jobId, configId, config.account_id, trigger, now],
    );
    this.pendingJobIds.add(jobId);

    // Schedule actual execution without awaiting (caller gets jobId now).
    this.runJob(jobId, config).catch((err) =>
      Logger.error(`[FacebookAutoCommentService] runJob crashed: ${err.message}`),
    );
    return jobId;
  }

  private async runJob(jobId: string, config: AutoCommentConfig): Promise<void> {
    // Acquire account lock — chain on existing promise.
    const prev = this.accountLocks.get(config.account_id) || Promise.resolve();
    const next = prev.then(() => this.executeJob(jobId, config)).catch(() => undefined);
    this.accountLocks.set(config.account_id, next);
    try {
      await next;
    } finally {
      // Only clear if we are still the head of the chain.
      if (this.accountLocks.get(config.account_id) === next) {
        this.accountLocks.delete(config.account_id);
      }
    }
  }

  private async executeJob(jobId: string, config: AutoCommentConfig): Promise<void> {
    this.pendingJobIds.delete(jobId);
    this.activeJobByAccount.set(config.account_id, jobId);

    const startedAt = Date.now();
    this.updateJob(jobId, { status: 'running', started_at: startedAt });
    Logger.log(`[FacebookAutoCommentService] Job ${jobId.slice(0, 8)} start account=${config.account_id.slice(0, 8)} config=${config.id.slice(0, 8)}`);

    let result: AutoCommentRunResult;
    try {
      result = await this.runConfig(config, jobId);
    } catch (err: any) {
      Logger.error(`[FacebookAutoCommentService] runConfig threw: ${err.message}`);
      result = { success: false, commentsPosted: 0, postsTargeted: 0, errors: [err.message], logs: [] };
    } finally {
      this.activeJobByAccount.delete(config.account_id);
    }

    const endedAt = Date.now();
    const cancelRequested = !!this.cancelFlags.get(jobId);
    this.cancelFlags.delete(jobId);

    let finalStatus: AutoCommentJobStatus = 'success';
    let errorSummary = '';
    if (cancelRequested) {
      finalStatus = 'cancelled';
      errorSummary = 'Đã huỷ bởi người dùng';
    } else if (!result.success) {
      finalStatus = 'failed';
      errorSummary = (result.errors[0] || 'Không rõ lỗi').slice(0, 500);
    }

    this.updateJob(jobId, {
      status: finalStatus,
      ended_at: endedAt,
      posts_targeted: result.postsTargeted,
      comments_posted: result.commentsPosted,
      error: errorSummary,
    });
    Logger.log(
      `[FacebookAutoCommentService] Job ${jobId.slice(0, 8)} ${finalStatus} ` +
      `posts=${result.postsTargeted} comments=${result.commentsPosted}`,
    );
  }

  /** Convenience: enqueue + return UI-shaped result. */
  async runJobNow(configId: string): Promise<{ jobId: string }> {
    const jobId = await this.enqueueJob(configId, 'manual');
    return { jobId };
  }

  cancelJob(jobId: string): { success: boolean; error?: string } {
    const job = this.getJob(jobId);
    if (!job) return { success: false, error: 'Job not found' };
    if (job.status === 'success' || job.status === 'failed' || job.status === 'cancelled') {
      return { success: false, error: `Job đã ở trạng thái ${job.status}` };
    }
    // pending → mark immediately. running → set cancel flag for runConfig to honor.
    this.cancelFlags.set(jobId, true);
    if (job.status === 'pending') {
      this.updateJob(jobId, { status: 'cancelled', ended_at: Date.now(), error: 'Đã huỷ trước khi chạy' });
      this.pendingJobIds.delete(jobId);
    }
    return { success: true };
  }

  /**
   * Cancel every pending job of a flow and signal any running job to stop.
   * Does NOT toggle the schedule — flow remains enabled and will fire again.
   */
  stopFlow(configId: string): { cancelled: number; signalled: number } {
    let cancelled = 0;
    let signalled = 0;
    const all = this.getJobsByConfig(configId);
    for (const j of all) {
      if (j.status === 'pending') {
        this.updateJob(j.id, { status: 'cancelled', ended_at: Date.now(), error: 'Dừng flow' });
        this.pendingJobIds.delete(j.id);
        cancelled++;
      } else if (j.status === 'running') {
        this.cancelFlags.set(j.id, true);
        signalled++;
      }
    }
    Logger.log(`[FacebookAutoCommentService] stopFlow ${configId.slice(0, 8)} cancelled=${cancelled} signalled=${signalled}`);
    return { cancelled, signalled };
  }

  private hasPendingJobForConfig(configId: string): boolean {
    const jobs = this.getJobsByConfig(configId);
    return jobs.some(j => j.status === 'pending' || j.status === 'running');
  }

  private jobBelongsToConfig(jobId: string, configId: string): boolean {
    const j = this.getJob(jobId);
    return !!j && j.config_id === configId;
  }

  // ─── Status / read APIs ────────────────────────────────────────────────────

  /**
   * Worker-level status. Kept the legacy fields for back-compat with
   * getStatus callers; add runningCount/pendingCount for the new UI.
   */
  getStatus(): {
    enabled: boolean;
    lastRunAt: number;
    lastRunSummary: string;
    nextRunAt: number;
    totalRuns: number;
    minutesSinceLastRun: number;
    minutesToNextRun: number;
  } {
    const now = Date.now();
    return {
      enabled: this.workerEnabled,
      lastRunAt: this.lastRunAt,
      lastRunSummary: this.lastRunAt
        ? `Worker tick — ${this.activeJobByAccount.size}/${this.GLOBAL_CONCURRENCY} job(s) running`
        : '',
      nextRunAt: this.nextRunAt,
      totalRuns: this.lastRunAt ? 1 : 0,
      minutesSinceLastRun: this.lastRunAt ? Math.round((now - this.lastRunAt) / 60000) : -1,
      minutesToNextRun: this.nextRunAt ? Math.max(0, Math.round((this.nextRunAt - now) / 60000)) : -1,
    };
  }

  /** New, richer worker status for the redesigned UI card. */
  getWorkerStatus(): {
    enabled: boolean;
    lastTickAt: number;
    lastError: string;
    nextTickAt: number;
    runningCount: number;
    runningJobIds: string[];
    pendingCount: number;
    globalConcurrency: number;
  } {
    return {
      enabled: this.workerEnabled,
      lastTickAt: this.lastTickAt,
      lastError: this.lastTickError,
      nextTickAt: this.nextRunAt,
      runningCount: this.activeJobByAccount.size,
      runningJobIds: Array.from(this.activeJobByAccount.values()),
      pendingCount: this.pendingJobIds.size,
      globalConcurrency: this.GLOBAL_CONCURRENCY,
    };
  }

  getJobs(opts: { configId?: string; accountId?: string; limit?: number } = {}): AutoCommentJob[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.configId) { where.push('config_id = ?'); params.push(opts.configId); }
    if (opts.accountId) { where.push('account_id = ?'); params.push(opts.accountId); }
    const sql = `SELECT * FROM fb_auto_comment_jobs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY scheduled_at DESC LIMIT ?`;
    params.push(opts.limit ?? 50);
    const rows = DatabaseService.getInstance().query<any>(sql, params) || [];
    return rows.map(this.mapJob);
  }

  getJob(id: string): AutoCommentJob | null {
    const row = DatabaseService.getInstance().queryOne<any>(
      `SELECT * FROM fb_auto_comment_jobs WHERE id = ?`, [id],
    );
    return row ? this.mapJob(row) : null;
  }

  getJobsByConfig(configId: string): AutoCommentJob[] {
    return this.getJobs({ configId, limit: 100 });
  }

  getLastJobForConfig(configId: string): AutoCommentJob | null {
    const rows = this.getJobs({ configId, limit: 1 });
    return rows[0] || null;
  }

  getJobLogs(jobId: string): AutoCommentLog[] {
    return this.getLogsByJob(jobId);
  }

  private mapJob = (row: any): AutoCommentJob => ({
    id: row.id,
    config_id: row.config_id,
    account_id: row.account_id,
    trigger: row.trigger,
    status: row.status,
    scheduled_at: row.scheduled_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    posts_targeted: row.posts_targeted || 0,
    comments_posted: row.comments_posted || 0,
    error: row.error || '',
  });

  private updateJob(jobId: string, patch: Partial<AutoCommentJob>): void {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = ?`);
      values.push(v ?? null);
    }
    if (fields.length === 0) return;
    values.push(jobId);
    DatabaseService.getInstance().run(
      `UPDATE fb_auto_comment_jobs SET ${fields.join(', ')} WHERE id = ?`,
      values,
    );
  }

  // ─── Configs / logs (unchanged behavior) ──────────────────────────────────

  private getAllEnabledConfigs(): AutoCommentConfig[] {
    try {
      const rows = DatabaseService.getInstance().query<any>(
        `SELECT * FROM fb_auto_comment_configs WHERE enabled = 1`
      ) || [];
      return rows.map((row) => this.rowToConfig(row));
    } catch (err: any) {
      Logger.error(`[FacebookAutoCommentService] Error getting configs: ${err.message}`);
      return [];
    }
  }

  /** Map raw DB row → AutoCommentConfig. Giữ nguyên \n bên trong từng comment template. */
  private rowToConfig(row: any): AutoCommentConfig {
    return {
      id: row.id,
      workspace_id: row.workspace_id || '',
      account_id: row.account_id,
      comments: JSON.parse(row.comments || '[]'),
      group_ids: JSON.parse(row.group_ids || '[]').map(normalizeGroupId).filter((id: string) => id),
      max_posts_per_run: row.max_posts_per_run || 10,
      schedule_minutes: row.schedule_minutes || 60,
      enabled: !!row.enabled,
      created_at: row.created_at,
      updated_at: row.updated_at,
      doc_id_create_comment: row.doc_id_create_comment || null,
      comment_count_per_post: row.comment_count_per_post == null ? undefined : Number(row.comment_count_per_post),
      comment_pick_mode: row.comment_pick_mode === 'random' ? 'random' : 'sequential',
    };
  }

  /** Chạy 1 config — giữ nguyên logic, thêm jobId/cancelToken. */
  async runConfig(config: AutoCommentConfig, jobId?: string): Promise<AutoCommentRunResult> {
    const result: AutoCommentRunResult = {
      success: true,
      commentsPosted: 0,
      postsTargeted: 0,
      errors: [],
      logs: [],
    };

    const cookie = secureGet(fbCookieKey(config.account_id));
    if (!cookie) {
      result.success = false;
      result.errors.push('Cookie not found');
      return result;
    }

    const service = await FacebookService.getInstance(config.account_id);
    if (!service || !service.isConnected()) {
      result.success = false;
      result.errors.push('Account not connected');
      return result;
    }

    // Mỗi phần tử của config.comments = 1 mẫu trọn vẹn (có thể chứa \n).
    // Không split theo \n ở đây — chỉ filter mẫu rỗng (data cũ từ schema split-by-line).
    const comments = config.comments.filter((c) => c.trim().length > 0);
    if (comments.length === 0) {
      result.success = false;
      result.errors.push('Chưa có nội dung comment');
      return result;
    }

    // Số comment / bài: legacy (thiếu field) → mặc định = tất cả mẫu.
    // Mới: cap bởi số mẫu hiện có, tối thiểu 1.
    const perPost = Math.max(
      1,
      Math.min(
        comments.length,
        Number.isFinite(config.comment_count_per_post) && (config.comment_count_per_post ?? 0) > 0
          ? Math.floor(config.comment_count_per_post as number)
          : comments.length,
      ),
    );
    const pickMode: 'random' | 'sequential' = config.comment_pick_mode === 'random' ? 'random' : 'sequential';
    // Sequential: chỉ số chung cho cả job (xoay vòng giữa các bài).
    let seqCursor = 0;

    // Load replacement candidates too: skipped/failed posts must not consume success quota.
    const candidateLimit = getAutoCommentCandidateLimit(config.max_posts_per_run);
    const allPosts: { groupId: string; groupName: string; posts: GroupPost[] }[] = [];

    for (const groupId of config.group_ids) {
      // Honor cancel between groups too.
      if (jobId && this.cancelFlags.get(jobId)) {
        result.success = false;
        result.errors.push('Đã huỷ giữa chừng');
        return result;
      }
      try {
        const posts = await this.getGroupPosts(service, groupId, candidateLimit);
        const groupName = await this.getGroupName(service, groupId);
        if (posts.length > 0) {
          allPosts.push({ groupId, groupName, posts });
        }
      } catch (err: any) {
        Logger.warn(`[FacebookAutoCommentService] Error getting posts from group ${groupId}: ${err.message}`);
        result.errors.push(`Group ${groupId}: ${err.message}`);
      }
    }

    // Flatten và sort (mới nhất trước)
    const sortedPosts = selectNewestGroupPosts(
      allPosts.flatMap(g => g.posts.map(p => ({ ...p, groupName: g.groupName }))),
      candidateLimit,
    );

    let postsAttempted = 0;
    let successfulPosts = 0;

    // Track posts đã comment để tránh spam cùng 1 post
    const commentedPosts = new Set<string>();

    // Resolve doc_id once per config. Operator can override per-config in DB
    // when Facebook rotates the mutation's doc_id; otherwise fall back to the
    // hardcoded default captured from a working browser request.
    const resolvedDocId = (config.doc_id_create_comment || '').trim() || DOC_ID_CREATE_COMMENT;
    if (resolvedDocId !== DOC_ID_CREATE_COMMENT) {
      Logger.log(`[FacebookAutoCommentService] Using custom doc_id from config: ${resolvedDocId}`);
    }

    for (const post of sortedPosts) {
      if (jobId && this.cancelFlags.get(jobId)) {
        result.success = false;
        if (!result.errors.includes('Đã huỷ giữa chừng')) {
          result.errors.push('Đã huỷ giữa chừng');
        }
        break;
      }
      if (hasReachedAutoCommentTarget(successfulPosts, config.max_posts_per_run)) break;
      if (commentedPosts.has(post.postId)) continue;

      // Top N was fixed before this loop. Recently handled posts are skipped,
      // never replaced with older posts outside that newest-N set.
      if (await this.hasCommentedRecently(config.id, post.postId)) {
        Logger.log(`[FacebookAutoCommentService] Skipping post ${post.postId} - already commented recently`);
        continue;
      }

      const postedComments: string[] = [];
      let hasError = false;

      // Chọn tối đa `perPost` mẫu cho bài này theo pickMode.
      const picks = pickCommentIndices({
        total: comments.length,
        perPost,
        mode: pickMode,
        seqCursor,
        randomSeed: post.postId + ':' + postsAttempted, // deterministic-ish per (post, slot) cho log
      });
      // Cập nhật seqCursor cho sequential mode (xoay vòng giữa các bài).
      if (pickMode === 'sequential') {
        seqCursor = (seqCursor + perPost) % comments.length;
      }

      for (let i = 0; i < picks.length; i++) {
        const commentText = comments[picks[i]];

        try {
          const commentResult = await this.commentOnPost(service, post.postId, commentText, post.groupId, resolvedDocId);

          if (commentResult.success) {
            postedComments.push(commentText);
            result.commentsPosted++;
          } else {
            Logger.warn(`[FacebookAutoCommentService] Comment ${i + 1} failed: ${commentResult.error}`);
          }

          // Delay giữa các comments (tránh spam)
          if (i < picks.length - 1) {
            await this.delay(2000);
          }
        } catch (err: any) {
          Logger.error(`[FacebookAutoCommentService] Error posting comment ${i + 1}: ${err.message}`);
          hasError = true;
        }
      }

      // Log kết quả — failed nếu không comment được cái nào hoặc có lỗi
      const logStatus: 'success' | 'failed' =
        postedComments.length === 0 || hasError ? 'failed' : 'success';
      const log: AutoCommentLog = {
        id: uuid(),
        config_id: config.id,
        group_id: post.groupId,
        group_name: post.groupName,
        post_id: post.postId,
        comments: postedComments,
        status: logStatus,
        error: logStatus === 'failed'
          ? (postedComments.length === 0 ? 'No comment posted' : 'Some comments failed')
          : undefined,
        executed_at: Date.now(),
      };

      this.saveLog(log, jobId);
      result.logs.push(log);
      commentedPosts.add(post.postId);
      postsAttempted++;
      result.postsTargeted = postsAttempted;
      if (postedComments.length > 0) successfulPosts++;

      Logger.log(
        `[FacebookAutoCommentService] Commented ${postedComments.length} times on post ${post.postId} ` +
        `in group ${post.groupName}; progress=${successfulPosts}/${config.max_posts_per_run}`
      );

      // Delay giữa các bài viết
      await this.delay(3000);
    }

    if (!hasReachedAutoCommentTarget(successfulPosts, config.max_posts_per_run)) {
      result.success = false;
      if (sortedPosts.length === 0 && result.errors.length === 0) {
        result.errors.push(
          `Không lấy được bài viết nào từ ${config.group_ids.length} group(s). ` +
          `Kiểm tra group ID và quyền xem group của tài khoản Facebook.`
        );
      } else if (result.errors.length === 0) {
        result.errors.push(
          `Chỉ comment thành công ${successfulPosts}/${config.max_posts_per_run} bài; ` +
          `đã hết ${sortedPosts.length} bài ứng viên.`
        );
      }
    }

    return result;
  }

  /** Lấy bài viết mới nhất từ GraphQL; HTML chỉ là fallback cho markup cũ. */
  private async getGroupPosts(service: FacebookService, groupId: string, limit: number): Promise<GroupPost[]> {
    try {
      const accountId = service['accountId'];
      const scan = await FacebookScanService.getInstance().scanPostTimeline(accountId, groupId, 'group');
      if (scan.success) {
        const posts = normalizeScannedGroupPosts(scan.items, groupId, limit);
        const response = scan._lastResponse || '';
        Logger.log(
          `[AutoComment] GraphQL group=${groupId} docId=${scan._lastDocId || 'none'} ` +
          `items=${scan.items.length} posts=${posts.length} ` +
          `signals={errors:${response.includes('"errors"')},node:${response.includes('"node"')},` +
          `groupFeed:${response.includes('"group_feed"')},edges:${response.includes('"edges"')},` +
          `postId:${response.includes('"post_id"')},story:${response.includes('"story"')}}`
        );
        if (posts.length >= limit) return posts;
      } else {
        Logger.warn(`[AutoComment] GraphQL group=${groupId} failed: ${scan.error || 'unknown error'}`);
      }

      const cookie = secureGet(fbCookieKey(accountId));
      if (!cookie) {
        Logger.error(`[AutoComment] No cookie for account ${service['accountId']}`);
        return [];
      }

      // `sorting_setting=CHRONOLOGICAL` requests newest-first discussion feed.
      // Publication timestamps are still parsed and sorted locally across groups.
      const url = `https://www.facebook.com/groups/${groupId}/?sorting_setting=CHRONOLOGICAL`;
      const response = await axios.get(url, {
        headers: {
          'Cookie': cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
          'sec-fetch-user': '?1',
          'upgrade-insecure-requests': '1',
        },
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const html = String(response.data || '');
      const posts = this.parseWwwGroupFeed(html, groupId);
      const count = (pattern: RegExp) => Array.from(html.matchAll(pattern)).length;
      Logger.log(
        `[AutoComment] www group=${groupId} status=${response.status} htmlLen=${html.length} ` +
        `parsedPosts=${posts.length} firstPid=${posts[0]?.postId || 'none'} ` +
        `signals={group:${count(new RegExp(groupId, 'g'))},permalink:${count(/(?:\/|\\\/)permalink(?:\/|\\\/)/g)},` +
        `posts:${count(/(?:\/|\\\/)posts(?:\/|\\\/)/g)},storyFbid:${count(/story_fbid/g)},postId:${count(/post_id/g)}}`
      );

      if (posts.length >= limit) return selectNewestGroupPosts(posts, limit);

      const rendered = await BrowserDebugService.getInstance().renderWithCookie(accountId, url, {
        maxScrolls: Math.min(30, Math.max(6, limit)),
        scrollDelayMs: 1500,
        stableScrolls: 4,
      });
      if (rendered.success && rendered.html) {
        const renderedPosts = this.parseWwwGroupFeed(rendered.html, groupId);
        Logger.log(
          `[AutoComment] browser group=${groupId} url=${rendered.url || 'none'} ` +
          `title=${JSON.stringify(rendered.title || '')} feedReady=${!!rendered.feedReady} ` +
          `htmlLen=${rendered.html.length} posts=${renderedPosts.length} ` +
          `firstPid=${renderedPosts[0]?.postId || 'none'} ` +
          `queries=${JSON.stringify(rendered.graphqlQueries || [])}`
        );
        const mergedPosts = selectNewestGroupPosts([...posts, ...renderedPosts], limit);
        if (mergedPosts.length > 0) return mergedPosts;
      } else {
        const error = rendered.error || 'unknown error';
        Logger.warn(`[AutoComment] browser group=${groupId} failed: ${error}`);
        if (error.includes('không có quyền xem group')) throw new Error(error);
      }

      // Diagnostic — detect login page (tight check, không match incidental text trong HTML)
      const isLogin = /<form[^>]*action="[^"]*login\.php/i.test(html)
        || /"isLoginPage":\s*true/i.test(html)
        || /<title>Đăng nhập Facebook<\/title>/i.test(html);
      if (isLogin) {
        Logger.error(`[AutoComment] www returned login page. Cookie hết hạn.`);
      } else {
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        Logger.log(`[AutoComment] www HTML title: "${titleMatch?.[1] || 'no title'}"`);
      }

      return selectNewestGroupPosts(posts, limit);
    } catch (err: any) {
      Logger.error(
        `[AutoComment] getGroupPosts error for group=${groupId}: ${err.message}. ` +
        `status=${err.response?.status ?? '?'}`
      );
      return [];
    }
  }

  /**
   * Parse www HTML → list top-level post IDs.
   *
   * BUG-FIX: trước đây regex match mọi `/groups/<gid>/permalink/<pid>/` xuất hiện
   * trong toàn trang — kể cả permalink của comment/reply (vì mỗi comment có URL
   * permalink riêng). Hậu quả: bot duyệt cả reply và tự comment vào đó → spam
   * câu trả lời. Cách phân biệt: top-level post permalink thường nằm trong
   * FeedUnit_*, comment permalink nằm trong subtree có `data-pagelet*Comment*`
   * hoặc anchor có `aria-label` chứa "Bình luận". Ta scan ~600 char phía trước
   * anchor để xem anchor có nằm trong comment context không — nếu có thì bỏ qua.
   *
   * Implementation lives in module-level `extractPostIdsFromWwwFeed` so it can be
   * unit-tested without instantiating the service.
   */
  private parseWwwGroupFeed(html: string, groupId: string): GroupPost[] {
    return extractPostIdsFromWwwFeed(html, groupId);
  }

  /** Lấy tên group từ GraphQL — fallback `Group <id>` nếu query fail */
  private async getGroupName(service: FacebookService, groupId: string): Promise<string> {
    try {
      const cookie = secureGet(fbCookieKey(service['accountId']));
      if (!cookie) return `Group ${groupId}`;
      const dataFB = service['dataFB'];
      if (!dataFB || !dataFB.lsd) return `Group ${groupId}`;

      const variables = {
        id: groupId,
        scale: 1.5,
        __relay_internal__pv__GroupsCometMemberYouShouldVisit_relayprovider: false,
      };

      const { url, body, headers } = buildGraphQLRequest(dataFB, cookie, {
        friendlyName: FRIENDLY_GROUP_ROOT,
        docId: DOC_ID_GROUP_ROOT,
        variables,
        endpoint: '/webgraphql/query/',
      });

      const response = await axios.post(url, body, { headers, timeout: 15000 });
      const parsed = parseFBResponse(response.data);
      const name = parsed?.data?.group?.name
        || parsed?.data?.node?.name
        || parsed?.data?.viewer?.group?.name;
      return name || `Group ${groupId}`;
    } catch {
      return `Group ${groupId}`;
    }
  }

  /** Comment lên bài viết */
  private async commentOnPost(service: FacebookService, postId: string, text: string, groupId?: string, docId?: string): Promise<{ success: boolean; error?: string }> {
    try {
      return await this.commentViaGraphQL(service, postId, text, groupId, docId);
    } catch (err: any) {
      Logger.error(`[AutoComment.commentOnPost] post=${postId} threw: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /** Strip for(;;); prefix AND unwrap {"__ar":..,"payload":..} envelope.
   *  Use this for auto-comment responses — the existing parseFBResponse in FacebookUtils
   *  does not unwrap the envelope, which causes checks like `result.data.X` to always miss.
   */
  private parseMutationResponse(text: string): any {
    const cleaned = String(text || '').replace(/^for\s*\(;;\);/, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }
    if (parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload === 'object') {
      return parsed.payload;
    }
    return parsed;
  }

  /** Comment qua GraphQL mutation */
  private async commentViaGraphQL(service: FacebookService, postId: string, text: string, groupId?: string, docId?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const cookie = secureGet(fbCookieKey(service['accountId']));
      if (!cookie) return { success: false, error: 'No cookie' };

      const dataFB = service['dataFB'];
      if (!dataFB) return { success: false, error: 'Session not initialized' };
      if (!dataFB.lsd) return { success: false, error: 'LSD missing — re-login required' };

      // FB expects feedback_id as base64("feedback:<postId>"), not the raw numeric id.
      // Capture from working browser request: "ZmVlZGJhY2s6MTQ2MTMxNTQxMjYyOTgxMQ==" → "feedback:1461315412629811".
      const feedbackIdB64 = Buffer.from(`feedback:${postId}`, 'utf8').toString('base64');

      // Per working DevTools capture, useCometUFICreateCommentMutation requires:
      //  - top-level: groupID, feedLocation, feedbackSource, renderLocation, scale, useDefaultActor,
      //    focusCommentID, translationType, canUseNicknameOnComet, several __relay_internal__pv__ flags
      //  - input.*: feedback_id (base64), message.ranges, attribution_id_v2, tracking, idempotence_token,
      //    session_id, feedback_source, formatting_style, is_inline_vote_enabled_for_qna, vod_video_timestamp
      const variables: Record<string, any> = {
        feedLocation: 'POST_PERMALINK_DIALOG',
        feedbackSource: 2,
        groupID: groupId || null,
        renderLocation: null,
        scale: 1,
        useDefaultActor: false,
        focusCommentID: null,
        translationType: 'AUTO_TRANSLATE',
        canUseNicknameOnComet: false,
        __relay_internal__pv__groups_comet_use_glvrelayprovider: false,
        __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
        __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
        __relay_internal__pv__IsWorkUserrelayprovider: false,
        __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'AUTO_TRANSLATE',
        input: {
          client_mutation_id: Math.random().toString(36).substring(2),
          feedback_id: feedbackIdB64,
          message: { ranges: [], text },
          attachments: null,
          formatting_style: null,
          is_inline_vote_enabled_for_qna: false,
          vod_video_timestamp: null,
          is_tracking_encrypted: true,
          tracking: [],
          feedback_source: 'OBJECT',
          idempotence_token: `client:${uuid()}`,
          session_id: uuid(),
          attribution_id_v2: `CometGroupDiscussionRoot.react,comet.group,${Date.now()},${Math.floor(Math.random() * 1000000)}${groupId ? ',' + groupId : ''},,`,
        },
      };

      const { url, body, headers } = buildGraphQLRequest(dataFB, cookie, {
        friendlyName: FRIENDLY_CREATE_COMMENT,
        docId: docId || DOC_ID_CREATE_COMMENT,
        variables,
      });

      const response = await axios.post(url, body, { headers, timeout: 30000 });

      const result = this.parseMutationResponse(response.data);
      assertFacebookMutationSuccess(FRIENDLY_CREATE_COMMENT, result);

      // Success signals from useCometUFICreateCommentMutation response:
      //  - feedback_comment_edge.node.id  → the just-created comment (most reliable)
      //  - comment_rendering_instance.comments.total_count > 0  → at least one comment exists
      // FB renders `comments_disabled_notice_renderer` even for normal posts (placeholder),
      // so we cannot use that to detect disabled.
      const newCommentId = result?.data?.comment_create?.feedback_comment_edge?.node?.id
        || result?.data?.comment_create?.comment?.id
        || result?.data?.comment_create?.feedback?.id
        || result?.data?.comment_create?.id
        || result?.data?.feedback_create?.comment?.id
        || null;
      const totalComments = result?.data?.comment_create?.feedback?.comment_rendering_instance?.comments?.total_count;
      const commentsDisabled = totalComments === 0
        && !result?.data?.comment_create?.feedback_comment_edge;
      Logger.log(
        `[AutoComment.mutation.parsed] post=${postId} ` +
        `newCommentId=${newCommentId || 'NONE'} totalComments=${totalComments} ` +
        `disabled=${commentsDisabled}`
      );

      if (newCommentId) {
        return { success: true };
      }

      if (commentsDisabled) {
        return { success: false, error: 'Comments are disabled on this post' };
      }

      return { success: false, error: 'Mutation returned no comment id (filtered, rotated doc_id, or unknown error)' };
    } catch (err: any) {
      this.logGraphQLError(FRIENDLY_CREATE_COMMENT, DOC_ID_CREATE_COMMENT, err, `post=${postId}`);
      return { success: false, error: err.message };
    }
  }

  /** Log 1 dòng gọn cho trial-and-error debug — user paste cho mình diagnose */
  private logGraphQLError(op: string, docId: string, err: any, context: string): void {
    const status = err.response?.status ?? '?';
    const code = err.code ?? 'unknown';
    const body = (err.response?.data ?? err.message ?? '').toString().slice(0, 200);
    Logger.error(
      `[AutoComment.graphql] op=${op} doc_id=${docId} ctx=${context} ` +
      `status=${status} code=${code} msg="${err.message}" body=${body}`
    );
  }

  /** Kiểm tra đã comment bài này chưa.
   *  Trả về true nếu có bất kỳ log nào (success hoặc failed) trong 24h.
   *  ponytail: dùng status IN ('success','failed') thay vì chỉ success
   *  để nếu comment thất bại 1 lần, các job sau không spam thử lại cùng post.
   */
  private async hasCommentedRecently(configId: string, postId: string): Promise<boolean> {
    try {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const row = DatabaseService.getInstance().queryOne<any>(
        `SELECT id FROM fb_auto_comment_logs
         WHERE config_id = ? AND post_id = ? AND status IN ('success','failed') AND executed_at > ?
         LIMIT 1`,
        [configId, postId, oneDayAgo]
      );
      return !!row;
    } catch {
      return false;
    }
  }

  /** Lưu log vào DB. jobId gắn row với job đang chạy (nullable cho legacy). */
  private saveLog(log: AutoCommentLog, jobId?: string): void {
    try {
      DatabaseService.getInstance().run(
        `INSERT INTO fb_auto_comment_logs
         (id, config_id, group_id, group_name, post_id, comments, status, error, executed_at, job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [log.id, log.config_id, log.group_id, log.group_name, log.post_id,
         JSON.stringify(log.comments), log.status, log.error || '', log.executed_at,
         jobId || null]
      );
    } catch (err: any) {
      Logger.error(`[FacebookAutoCommentService] Error saving log: ${err.message}`);
    }
  }

  /** Delay helper */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Lấy tất cả configs (back-compat — đã trả về enabled trước đây nên giữ nguyên). */
  getAllConfigs(): AutoCommentConfig[] {
    return this.getAllEnabledConfigs();
  }

  /** Lấy 1 config */
  getConfig(id: string): AutoCommentConfig | null {
    try {
      const row = DatabaseService.getInstance().queryOne<any>(
        `SELECT * FROM fb_auto_comment_configs WHERE id = ?`,
        [id]
      );
      if (!row) return null;
      return this.rowToConfig(row);
    } catch {
      return null;
    }
  }

  /** Lưu config mới */
  saveConfig(config: Partial<AutoCommentConfig>): string {
    const id = config.id || uuid();
    const now = Date.now();
    const normalizedGroups = (config.group_ids || []).map(normalizeGroupId).filter((g: string) => g);

    // comment_count_per_post: explicit number → write through. undefined → NULL (= legacy
    //   "đăng tất cả mẫu", giữ tương thích với dữ liệu cũ).
    const perPostForDb =
      config.comment_count_per_post == null
        ? null
        : Math.max(1, Math.floor(config.comment_count_per_post));
    const pickModeForDb = config.comment_pick_mode === 'random' ? 'random' : 'sequential';

    DatabaseService.getInstance().run(
      `INSERT OR REPLACE INTO fb_auto_comment_configs
       (id, workspace_id, account_id, comments, group_ids,
        max_posts_per_run, schedule_minutes, enabled, created_at, updated_at, doc_id_create_comment,
        comment_count_per_post, comment_pick_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, config.workspace_id || '', config.account_id || '',
       JSON.stringify(config.comments || []),
       JSON.stringify(normalizedGroups),
       config.max_posts_per_run || 10,
       config.schedule_minutes || 60,
       config.enabled ? 1 : 0,
       config.created_at || now,
       now,
       config.doc_id_create_comment || null,
       perPostForDb,
       pickModeForDb]
    );

    // Refresh scheduler so new schedule_minutes takes effect.
    this.stop();
    this.start();

    return id;
  }

  /** Xóa config */
  deleteConfig(id: string): void {
    DatabaseService.getInstance().run(`DELETE FROM fb_auto_comment_configs WHERE id = ?`, [id]);
    DatabaseService.getInstance().run(`DELETE FROM fb_auto_comment_logs WHERE config_id = ?`, [id]);
    // Jobs rows left in place for audit; FK CASCADE handles configs.
  }

  /** Lấy logs theo config (giữ API cũ). jobId = null → trả legacy bucket. */
  getLogs(configId: string, limit: number = 100): AutoCommentLog[] {
    try {
      const rows = DatabaseService.getInstance().query<any>(
        `SELECT * FROM fb_auto_comment_logs WHERE config_id = ? ORDER BY executed_at DESC LIMIT ?`,
        [configId, limit]
      ) || [];
      return rows.map(row => ({
        id: row.id,
        config_id: row.config_id,
        group_id: row.group_id,
        group_name: row.group_name,
        post_id: row.post_id,
        comments: JSON.parse(row.comments || '[]'),
        status: row.status,
        error: row.error,
        executed_at: row.executed_at,
        job_id: row.job_id,
      } as any));
    } catch {
      return [];
    }
  }

  /** Logs của một job cụ thể. */
  getLogsByJob(jobId: string, limit: number = 200): AutoCommentLog[] {
    try {
      const rows = DatabaseService.getInstance().query<any>(
        `SELECT * FROM fb_auto_comment_logs WHERE job_id = ? ORDER BY executed_at DESC LIMIT ?`,
        [jobId, limit]
      ) || [];
      return rows.map(row => ({
        id: row.id,
        config_id: row.config_id,
        group_id: row.group_id,
        group_name: row.group_name,
        post_id: row.post_id,
        comments: JSON.parse(row.comments || '[]'),
        status: row.status,
        error: row.error,
        executed_at: row.executed_at,
        job_id: row.job_id,
      } as any));
    } catch {
      return [];
    }
  }

  /** Legacy API for UI: chạy thủ công 1 config qua enqueueJob. */
  async runNow(configId: string): Promise<AutoCommentRunResult> {
    try {
      const jobId = await this.enqueueJob(configId, 'manual');
      // Wait for terminal state by polling DB.
      const deadline = Date.now() + 30 * 60_000;
      while (Date.now() < deadline) {
        const j = this.getJob(jobId);
        if (j && (j.status === 'success' || j.status === 'failed' || j.status === 'cancelled')) {
          return {
            success: j.status === 'success',
            commentsPosted: j.comments_posted || 0,
            postsTargeted: j.posts_targeted || 0,
            errors: j.status === 'success' ? [] : [j.error || 'Job failed'],
            logs: this.getLogsByJob(jobId),
          };
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      return { success: false, commentsPosted: 0, postsTargeted: 0, errors: ['Timeout waiting for job'], logs: [] };
    } catch (err: any) {
      return { success: false, commentsPosted: 0, postsTargeted: 0, errors: [err.message], logs: [] };
    }
  }

  /**
   * Probe the session state of one account without doing network calls.
   * Returns one of:
   *  - 'cookie_missing': no encrypted cookie stored
   *  - 'expired': cookie present but FacebookService not connected
   *  - 'verified': cookie present + service reports connected
   *  - 'unknown': unexpected state (cookie present but no service instance)
   */
  async checkAccountSession(accountId: string): Promise<{ state: 'verified' | 'cookie_missing' | 'expired' | 'unknown'; reason?: string }> {
    try {
      const cookie = secureGet(fbCookieKey(accountId));
      if (!cookie) return { state: 'cookie_missing', reason: 'Chưa có cookie cho tài khoản này' };
      const service = await FacebookService.getInstance(accountId).catch(() => null);
      if (!service) return { state: 'unknown', reason: 'Service chưa khởi tạo' };
      if (!service.isConnected()) return { state: 'expired', reason: 'Cookie hết hạn hoặc phiên đã đăng xuất' };
      return { state: 'verified' };
    } catch (err: any) {
      return { state: 'unknown', reason: err.message };
    }
  }
}

export function getAutoCommentCandidateLimit(target: number): number {
  return Math.max(0, target) * 3;
}

export function hasReachedAutoCommentTarget(successfulPosts: number, target: number): boolean {
  return successfulPosts >= Math.max(0, target);
}

interface GroupPost {
  postId: string;
  groupId: string;
  groupName: string;
  timestamp: number;
}

export function normalizeScannedGroupPosts(items: any[], groupId: string, limit: number): GroupPost[] {
  const now = Date.now();
  return selectNewestGroupPosts(items.flatMap((item, index) => {
    const postId = String(item?.postId || '').trim();
    if (!/^\d+$/.test(postId)) return [];
    const raw = Number(item?.timestamp);
    const parsed = raw > 0 && raw < 10_000_000_000 ? raw * 1000 : raw;
    const timestamp = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : now - index;
    return [{ postId, groupId, groupName: '', timestamp }];
  }), limit);
}

/** Select N newest unique posts across all configured groups. */
export function selectNewestGroupPosts(posts: GroupPost[], limit: number): GroupPost[] {
  const newestById = new Map<string, GroupPost>();
  for (const post of posts) {
    const previous = newestById.get(post.postId);
    if (!previous || post.timestamp > previous.timestamp) newestById.set(post.postId, post);
  }
  return Array.from(newestById.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, Math.max(0, limit));
}

/**
 * Parse www HTML → list top-level post IDs. Module-level so it can be
 * unit-tested. See `parseWwwGroupFeed` for full comment.
 *
 * @internal exported for testability
 */
export function extractPostIdsFromWwwFeed(html: string, groupId: string): GroupPost[] {
  const posts: GroupPost[] = [];
  const seen = new Set<string>();

  const push = (postId: string, timestamp: number) => {
    if (seen.has(postId) || postId === groupId) return;
    seen.add(postId);
    posts.push({ postId, groupId, groupName: '', timestamp });
  };

  // Tìm kiếm "đang ở trong comment subtree" cho anchor tại vị trí idx.
  // Ý tưởng: tìm comment-marker gần nhất trước anchor, lùi về `<tag` mở chứa
  // marker đó, rồi đếm thẻ mở/đóng từ `<tag` đó tới anchor. Nếu depth > 0
  // → anchor vẫn nằm trong comment subtree → bỏ.
  const COMMENT_MARKER = /(?:data-pagelet="[^"]*[Cc]omment[^"]*"|aria-label="[^"]*[Bb]ình luận[^"]*"|aria-label="[^"]*[Cc]omment[^"]*"|data-testid="[^"]*[Cc]omment[^"]*")/g;
  const OPEN_TAG = /<(div|article|section|aside)\b[^>]*>/g;
  const CLOSE_TAG = /<\/(div|article|section|aside)>/g;

  const isInCommentContext = (idx: number): boolean => {
    // 1. Tìm comment-marker gần nhất trước anchor.
    COMMENT_MARKER.lastIndex = 0;
    let lastMarkerIdx = -1;
    let mk: RegExpExecArray | null;
    while ((mk = COMMENT_MARKER.exec(html)) !== null) {
      if (mk.index >= idx) break;
      lastMarkerIdx = mk.index;
    }
    if (lastMarkerIdx < 0) return false;

    // 2. Lùi từ marker về `<tag` mở gần nhất chứa nó. Đây là thẻ "gốc" của
    //    comment subtree. Nếu không tìm thấy (self-closing / marker ở thẻ khác),
    //    fallback về vị trí marker.
    OPEN_TAG.lastIndex = 0;
    let enclosingOpenIdx = -1;
    let openM: RegExpExecArray | null;
    while ((openM = OPEN_TAG.exec(html)) !== null) {
      if (openM.index >= lastMarkerIdx) break;
      enclosingOpenIdx = openM.index;
    }
    const startFrom = enclosingOpenIdx >= 0 ? enclosingOpenIdx : lastMarkerIdx;

    // 3. Đếm thẻ mở/đóng từ startFrom tới idx.
    let depth = 0;
    OPEN_TAG.lastIndex = startFrom;
    CLOSE_TAG.lastIndex = startFrom;
    openM = OPEN_TAG.exec(html);
    let closeM: RegExpExecArray | null = CLOSE_TAG.exec(html);
    while ((openM && openM.index < idx) || (closeM && closeM.index < idx)) {
      const nextOpen = openM ? openM.index : Infinity;
      const nextClose = closeM ? closeM.index : Infinity;
      if (nextOpen < nextClose) {
        depth++;
        openM = OPEN_TAG.exec(html);
      } else {
        depth--;
        if (depth <= 0) return false; // đã đóng subtree trước anchor
        closeM = CLOSE_TAG.exec(html);
      }
    }
    return depth > 0;
  };

  // Facebook embeds feed URLs both normally and JSON-escaped (`\/groups\/...`).
  // Only IDs coupled to this exact group URL are safe post IDs. Generic fields
  // such as actorID, fbid, post_id and id also describe users/tracking objects.
  const groupPath = String(groupId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const timestampPattern = /["'](?:creation_time|publish_time|created_time|creation_timestamp)["']\s*:\s*["']?(\d{10,13})/g;
  const directPatterns = [
    new RegExp(`(?:/|\\\\/)groups(?:/|\\\\/)${groupPath}(?:/|\\\\/)permalink(?:/|\\\\/)(\\d+)`, 'g'),
    new RegExp(`(?:/|\\\\/)groups(?:/|\\\\/)${groupPath}(?:/|\\\\/)posts(?:/|\\\\/)(\\d+)`, 'g'),
  ];
  const candidates: Array<{ postId: string; index: number }> = [];
  let m: RegExpExecArray | null;
  for (const re of directPatterns) {
    while ((m = re.exec(html)) !== null) {
      if (!isInCommentContext(m.index)) candidates.push({ postId: m[1], index: m.index });
    }
  }
  candidates.sort((a, b) => a.index - b.index);

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    // Bound metadata by adjacent post URLs, then use nearest publication field.
    // This prevents one story's timestamp from being reused by the next story.
    const start = Math.max(
      candidate.index - 2000,
      i > 0 ? Math.floor((candidates[i - 1].index + candidate.index) / 2) : 0,
    );
    const end = Math.min(
      candidate.index + 2000,
      i + 1 < candidates.length
        ? Math.floor((candidate.index + candidates[i + 1].index) / 2)
        : html.length,
    );
    const metadata = html.slice(start, end);
    const relativeIndex = candidate.index - start;
    timestampPattern.lastIndex = 0;
    let timestampMatch: RegExpExecArray | null;
    let nearest: { raw: string; distance: number } | null = null;
    while ((timestampMatch = timestampPattern.exec(metadata)) !== null) {
      const distance = Math.abs(timestampMatch.index - relativeIndex);
      if (!nearest || distance < nearest.distance) nearest = { raw: timestampMatch[1], distance };
    }
    const value = Number(nearest?.raw);
    const parsedTimestamp = nearest?.raw.length === 10 ? value * 1000 : value;
    const timestamp = Number.isSafeInteger(parsedTimestamp)
      && parsedTimestamp > 0
      && parsedTimestamp <= Date.now() + 24 * 60 * 60 * 1000
      ? parsedTimestamp
      : Date.now() - i;
    push(candidate.postId, timestamp);
  }

  return posts;
}

/**
 * Chọn chỉ số mẫu để comment trên 1 bài.
 * - sequential: lấy liên tiếp từ `seqCursor`, dừng khi hết 1 vòng.
 * - random: shuffle lấy `perPost` mẫu không trùng; seed ổn định theo randomSeed.
 *
 * Không vượt quá `total`. Nếu `perPost >= total`, trả về tất cả (1 vòng).
 */
function pickCommentIndices(opts: {
  total: number;
  perPost: number;
  mode: 'random' | 'sequential';
  seqCursor: number;
  randomSeed: string;
}): number[] {
  const { total, perPost, mode, seqCursor } = opts;
  if (total <= 0 || perPost <= 0) return [];
  const want = Math.min(perPost, total);

  if (mode === 'random') {
    // Seedable shuffle (mulberry32) — đảm bảo mỗi post lấy cùng tập con
    // cho cùng seed; tránh kết quả khác nhau giữa các log của cùng job.
    let h = 1779033703 ^ opts.randomSeed.length;
    for (let i = 0; i < opts.randomSeed.length; i++) {
      h = Math.imul(h ^ opts.randomSeed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    const rng = () => {
      h = (h + 0x6D2B79F5) | 0;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const idxs = Array.from({ length: total }, (_, i) => i);
    for (let i = idxs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    return idxs.slice(0, want);
  }

  // sequential
  const out: number[] = [];
  for (let k = 0; k < want; k++) {
    out.push((seqCursor + k) % total);
  }
  return out;
}
