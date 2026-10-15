/**
 * FacebookAutoCommentService.ts
 * Service tự động comment vào các bài viết trong groups được chọn
 *
 * Luồng:
 * 1. Worker chạy theo schedule (mỗi X phút)
 * 2. Lấy config → groups → bài viết mới nhất từ mỗi group
 * 3. Với mỗi bài viết: comment tất cả templates theo thứ tự
 * 4. Log kết quả vào DB
 */

import DatabaseService from '../database/DatabaseService';
import FacebookService from './FacebookService';
import { secureGet } from '../secure/SecureSettingsService';
import Logger from '../../utils/Logger';
import { v4 as uuid } from 'uuid';
import { AutoCommentConfig, AutoCommentLog, AutoCommentRunResult } from '../../models/autoComment';
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
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;
  private lastRunAt: number = 0;
  private lastRunSummary: string = '';
  private nextRunAt: number = 0;
  private totalRuns: number = 0;

  static getInstance(): FacebookAutoCommentService {
    if (!FacebookAutoCommentService.instance) {
      FacebookAutoCommentService.instance = new FacebookAutoCommentService();
    }
    return FacebookAutoCommentService.instance;
  }

  /** Bắt đầu worker */
  start(): void {
    if (this.workerTimer) return;
    Logger.log('[FacebookAutoCommentService] Starting worker...');
    this.scheduleNextRun();
  }

  /** Dừng worker */
  stop(): void {
    if (this.workerTimer) {
      clearTimeout(this.workerTimer);
      this.workerTimer = null;
      Logger.log('[FacebookAutoCommentService] Worker stopped');
    }
  }

  /** Lên lịch chạy tiếp theo */
  private scheduleNextRun(): void {
    const configs = this.getAllEnabledConfigs();
    if (configs.length === 0) {
      Logger.log('[FacebookAutoCommentService] No enabled configs, retrying in 60s');
      this.workerTimer = setTimeout(() => this.scheduleNextRun(), 60000);
      this.nextRunAt = Date.now() + 60000;
      return;
    }

    const minSchedule = Math.min(...configs.map(c => c.schedule_minutes * 60 * 1000));
    this.nextRunAt = Date.now() + minSchedule;
    Logger.log(
      `[FacebookAutoCommentService] Next run in ${minSchedule / 60000} minutes ` +
      `(${new Date(this.nextRunAt).toISOString()}) for ${configs.length} config(s)`
    );

    this.workerTimer = setTimeout(async () => {
      try {
        await this.runAllConfigs();
      } catch (err: any) {
        Logger.error(`[FacebookAutoCommentService] Tick crashed: ${err.message}. Rescheduling.`);
      } finally {
        // Self-recovery: luôn schedule lại kể cả khi crash
        this.scheduleNextRun();
      }
    }, minSchedule);
  }

  /** Status cho UI — biết scheduler có chạy không */
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
      enabled: this.workerTimer !== null,
      lastRunAt: this.lastRunAt,
      lastRunSummary: this.lastRunSummary,
      nextRunAt: this.nextRunAt,
      totalRuns: this.totalRuns,
      minutesSinceLastRun: this.lastRunAt ? Math.round((now - this.lastRunAt) / 60000) : -1,
      minutesToNextRun: this.nextRunAt ? Math.max(0, Math.round((this.nextRunAt - now) / 60000)) : -1,
    };
  }

  /** Lấy tất cả configs đang enabled */
  private getAllEnabledConfigs(): AutoCommentConfig[] {
    try {
      const rows = DatabaseService.getInstance().query<any>(
        `SELECT * FROM fb_auto_comment_configs WHERE enabled = 1`
      ) || [];
      return rows.map(row => ({
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
      }));
    } catch (err: any) {
      Logger.error(`[FacebookAutoCommentService] Error getting configs: ${err.message}`);
      return [];
    }
  }

  /** Chạy tất cả configs */
  async runAllConfigs(): Promise<void> {
    if (this.isRunning) {
      Logger.warn('[FacebookAutoCommentService] Already running, skipping...');
      return;
    }

    this.isRunning = true;
    this.lastRunAt = Date.now();
    this.totalRuns++;
    const configs = this.getAllEnabledConfigs();
    Logger.log(`[FacebookAutoCommentService] Tick #${this.totalRuns} — running ${configs.length} config(s)`);

    let totalPosted = 0;
    let totalTargets = 0;
    const errors: string[] = [];

    for (const config of configs) {
      try {
        const r = await this.runConfig(config);
        totalPosted += r.commentsPosted;
        totalTargets += r.postsTargeted;
        if (!r.success) errors.push(...r.errors);
      } catch (err: any) {
        Logger.error(`[FacebookAutoCommentService] Error running config ${config.id}: ${err.message}`);
        errors.push(err.message);
      }
    }

    this.lastRunSummary = `Posted ${totalPosted} comments on ${totalTargets} posts${
      errors.length > 0 ? `, ${errors.length} error(s)` : ''
    }`;
    Logger.log(`[FacebookAutoCommentService] Tick #${this.totalRuns} done: ${this.lastRunSummary}`);

    this.isRunning = false;
  }

  /** Chạy 1 config */
  async runConfig(config: AutoCommentConfig): Promise<AutoCommentRunResult> {
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

    // Lấy danh sách comments (filter empty lines)
    const comments = config.comments.filter(c => c.trim());
    if (comments.length === 0) {
      result.success = false;
      result.errors.push('Chưa có nội dung comment');
      return result;
    }

    // Lấy bài viết từ mỗi group
    const allPosts: { groupId: string; groupName: string; posts: GroupPost[] }[] = [];

    for (const groupId of config.group_ids) {
      try {
        const posts = await this.getGroupPosts(service, groupId, config.max_posts_per_run);
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
    const sortedPosts = allPosts
      .flatMap(g => g.posts.map(p => ({ ...p, groupName: g.groupName })))
      .sort((a, b) => b.timestamp - a.timestamp);

    let postsCommented = 0;

    // Track posts đã comment để tránh spam cùng 1 post
    const commentedPosts = new Set<string>();

    for (const post of sortedPosts) {
      if (postsCommented >= config.max_posts_per_run) break;
      if (commentedPosts.has(post.postId)) continue;

      // Kiểm tra đã comment bài này chưa (trong 24h)
      if (await this.hasCommentedRecently(config.id, post.postId)) {
        Logger.log(`[FacebookAutoCommentService] Skipping post ${post.postId} - already commented recently`);
        continue;
      }

      const postedComments: string[] = [];
      let hasError = false;

      // Comment lần lượt từng template
      for (let i = 0; i < comments.length; i++) {
        const commentText = comments[i];

        try {
          const commentResult = await this.commentOnPost(service, post.postId, commentText, post.groupId);

          if (commentResult.success) {
            postedComments.push(commentText);
            result.commentsPosted++;
          } else {
            Logger.warn(`[FacebookAutoCommentService] Comment ${i + 1} failed: ${commentResult.error}`);
          }

          // Delay giữa các comments (tránh spam)
          if (i < comments.length - 1) {
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

      this.saveLog(log);
      result.logs.push(log);
      commentedPosts.add(post.postId);
      postsCommented++;
      result.postsTargeted++;

      Logger.log(`[FacebookAutoCommentService] Commented ${postedComments.length} times on post ${post.postId} in group ${post.groupName}`);

      // Delay giữa các bài viết
      await this.delay(3000);
    }

    // Đánh dấu fail nếu không comment được bài nào — tránh báo "Hoàn thành" sai
    if (result.commentsPosted === 0) {
      result.success = false;
      if (sortedPosts.length === 0) {
        result.errors.push(
          `Không lấy được bài viết nào từ ${config.group_ids.length} group(s). ` +
          `Có thể: group ID sai, doc ID GraphQL đã expired, hoặc tài khoản không có quyền truy cập.`
        );
      } else {
        result.errors.push(`Đã tìm thấy ${sortedPosts.length} bài nhưng không comment được bài nào.`);
      }
    }

    return result;
  }

  /** Lấy bài viết từ group - www endpoint (cookie work với www) */
  private async getGroupPosts(service: FacebookService, groupId: string, limit: number): Promise<GroupPost[]> {
    try {
      const cookie = secureGet(fbCookieKey(service['accountId']));
      if (!cookie) {
        Logger.error(`[AutoComment] No cookie for account ${service['accountId']}`);
        return [];
      }

      // Dùng www endpoint — browser thường work với cookie này
      // Thêm `?sk=wall` để bám feed thảo luận (sort by new posts)
      const url = `https://www.facebook.com/groups/${groupId}/?sk=wall`;
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
      Logger.log(
        `[AutoComment] www group=${groupId} status=${response.status} htmlLen=${html.length} ` +
        `permalinkMatches=${posts.length} firstPid=${posts[0]?.postId || 'none'}`
      );

      if (posts.length > 0) return posts.slice(0, limit);

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

      return [];
    } catch (err: any) {
      Logger.error(
        `[AutoComment] getGroupPosts error for group=${groupId}: ${err.message}. ` +
        `status=${err.response?.status ?? '?'}`
      );
      return [];
    }
  }

  /** Parse www HTML → list post IDs. Nhiều pattern vì FB thay đổi format. */
  private parseWwwGroupFeed(html: string, groupId: string): GroupPost[] {
    const posts: GroupPost[] = [];
    const seen = new Set<string>();

    // Pattern 1: /groups/<gid>/permalink/<pid>/ (classic permalink)
    // Pattern 2: /groups/<gid>/posts/<pid>/ (new layout)
    // Pattern 3: story_fbid=<pid> in query string
    // Pattern 4: fbid=<pid> in query
    // Pattern 5: "post_id":"<pid>" in embedded JSON
    const patterns: RegExp[] = [
      /\/groups\/\d+\/permalink\/(\d+)/g,
      /\/groups\/\d+\/posts\/(\d+)/g,
      /story_fbid(?:=|%3D)(\d+)/g,
      /fbid(?:=|%3D)(\d+)/g,
      /"post_id"\s*:\s*"?(\d+)"?/g,
      /"id"\s*:\s*"(\d{10,})"/g, // pure numeric ID
    ];

    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const postId = m[1];
        if (seen.has(postId) || postId === groupId) continue;
        seen.add(postId);
        posts.push({ postId, groupId, groupName: '', timestamp: Date.now() });
      }
    }
    return posts;
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
  private async commentOnPost(service: FacebookService, postId: string, text: string, groupId?: string): Promise<{ success: boolean; error?: string }> {
    try {
      return await this.commentViaGraphQL(service, postId, text, groupId);
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
  private async commentViaGraphQL(service: FacebookService, postId: string, text: string, groupId?: string): Promise<{ success: boolean; error?: string }> {
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
        docId: DOC_ID_CREATE_COMMENT,
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

  /** Kiểm tra đã comment bài này chưa */
  private async hasCommentedRecently(configId: string, postId: string): Promise<boolean> {
    try {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const row = DatabaseService.getInstance().queryOne<any>(
        `SELECT id FROM fb_auto_comment_logs
         WHERE config_id = ? AND post_id = ? AND status = 'success' AND executed_at > ?
         LIMIT 1`,
        [configId, postId, oneDayAgo]
      );
      return !!row;
    } catch {
      return false;
    }
  }

  /** Lưu log vào DB */
  private saveLog(log: AutoCommentLog): void {
    try {
      DatabaseService.getInstance().run(
        `INSERT INTO fb_auto_comment_logs
         (id, config_id, group_id, group_name, post_id, comments, status, error, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [log.id, log.config_id, log.group_id, log.group_name, log.post_id,
         JSON.stringify(log.comments), log.status, log.error || '', log.executed_at]
      );
    } catch (err: any) {
      Logger.error(`[FacebookAutoCommentService] Error saving log: ${err.message}`);
    }
  }

  /** Delay helper */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Lấy tất cả configs */
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
      return {
        id: row.id,
        workspace_id: row.workspace_id || '',
        account_id: row.account_id,
        comments: JSON.parse(row.comments || '[]'),
        group_ids: JSON.parse(row.group_ids || '[]'),
        max_posts_per_run: row.max_posts_per_run || 10,
        schedule_minutes: row.schedule_minutes || 60,
        enabled: !!row.enabled,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  /** Lưu config mới */
  saveConfig(config: Partial<AutoCommentConfig>): string {
    const id = config.id || uuid();
    const now = Date.now();
    const normalizedGroups = (config.group_ids || []).map(normalizeGroupId).filter((g: string) => g);

    DatabaseService.getInstance().run(
      `INSERT OR REPLACE INTO fb_auto_comment_configs
       (id, workspace_id, account_id, comments, group_ids,
        max_posts_per_run, schedule_minutes, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, config.workspace_id || '', config.account_id || '',
       JSON.stringify(config.comments || []),
       JSON.stringify(normalizedGroups),
       config.max_posts_per_run || 10,
       config.schedule_minutes || 60,
       config.enabled ? 1 : 0,
       config.created_at || now,
       now]
    );

    this.stop();
    this.start();

    return id;
  }

  /** Xóa config */
  deleteConfig(id: string): void {
    DatabaseService.getInstance().run(`DELETE FROM fb_auto_comment_configs WHERE id = ?`, [id]);
    DatabaseService.getInstance().run(`DELETE FROM fb_auto_comment_logs WHERE config_id = ?`, [id]);
  }

  /** Lấy logs */
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
      }));
    } catch {
      return [];
    }
  }

  /** Chạy thủ công 1 config */
  async runNow(configId: string): Promise<AutoCommentRunResult> {
    if (this.isRunning) {
      return {
        success: false,
        commentsPosted: 0,
        postsTargeted: 0,
        errors: ['Auto comment đang chạy, vui lòng đợi'],
        logs: [],
      };
    }
    const config = this.getConfig(configId);
    if (!config) {
      return { success: false, commentsPosted: 0, postsTargeted: 0, errors: ['Config not found'], logs: [] };
    }
    this.isRunning = true;
    try {
      return await this.runConfig(config);
    } finally {
      this.isRunning = false;
    }
  }
}

interface GroupPost {
  postId: string;
  groupId: string;
  groupName: string;
  timestamp: number;
}
