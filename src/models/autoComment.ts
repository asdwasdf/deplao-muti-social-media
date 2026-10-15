/**
 * Types cho Auto Comment Facebook Groups
 */

export interface AutoCommentConfig {
  id: string;
  workspace_id: string;
  account_id: string;
  comments: string[];           // Array comments, mỗi dòng = 1 comment template
  group_ids: string[];          // Array group IDs được chọn
  max_posts_per_run: number;   // Tổng bài viết được comment/lần chạy
  schedule_minutes: number;     // Phút giữa mỗi lần chạy
  enabled: boolean;
  created_at: number;
  updated_at: number;
  /** Override for useCometUFICreateCommentMutation doc_id. When null/empty, falls back to the hardcoded default in FacebookAutoCommentService. */
  doc_id_create_comment?: string | null;
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
