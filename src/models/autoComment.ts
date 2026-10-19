/**
 * Types cho Auto Comment Facebook Groups
 */

export interface AutoCommentAttachment {
  file_path: string;
}

export interface AutoCommentConfig {
  id: string;
  workspace_id: string;
  account_id: string;
  comments: string[];           // Mỗi phần tử = 1 mẫu comment trọn vẹn (có thể chứa \n)
  group_ids: string[];          // Array group IDs được chọn
  max_posts_per_run: number;   // Tổng bài viết được comment/lần chạy
  schedule_minutes: number;     // Phút giữa mỗi lần chạy
  enabled: boolean;
  created_at: number;
  updated_at: number;
  /** Override for useCometUFICreateCommentMutation doc_id. When null/empty, falls back to the hardcoded default in FacebookAutoCommentService. */
  doc_id_create_comment?: string | null;
  /**
   * Số comment thực sự đăng trên mỗi bài viết (cap bởi số mẫu).
   * Legacy (thiếu): default = config.comments.length (giữ behavior cũ "đăng tất cả mẫu").
   */
  comment_count_per_post?: number;
  /** 'sequential' (thứ tự 1→2→… quay vòng) hoặc 'random' (không trùng trong cùng bài). */
  comment_pick_mode?: 'random' | 'sequential';
  /** Ảnh tùy chọn, cùng index với comments. */
  comment_attachments?: Array<AutoCommentAttachment | null>;
}

export interface AutoCommentLog {
  id: string;
  config_id: string;
  group_id: string;
  group_name: string;
  post_id: string;
  comments: string[];           // Tất cả comments đã đăng
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  executed_at: number;
}

export interface AutoCommentRunResult {
  success: boolean;
  commentsPosted: number;
  postsTargeted: number;
  errors: string[];
  logs: AutoCommentLog[];
}

/** Status of one execution attempt of a flow. */
export type AutoCommentJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export interface AutoCommentJob {
  id: string;
  config_id: string;
  account_id: string;
  trigger: 'manual' | 'scheduled';
  status: AutoCommentJobStatus;
  scheduled_at: number;
  started_at?: number | null;
  ended_at?: number | null;
  posts_targeted: number;
  comments_posted: number;
  error?: string;
}

export type AccountSessionState = 'verified' | 'cookie_missing' | 'expired' | 'unknown';
