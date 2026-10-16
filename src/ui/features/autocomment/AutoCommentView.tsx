/**
 * AutoCommentView.tsx
 * Multi-account Auto Comment dashboard.
 *
 * Layout:
 *  - Header: title + worker status badge
 *  - Account bar: account picker + per-account session badge + "Mở Browser" + "Thêm tài khoản"
 *  - Flow list: configs filtered by selected account
 *  - Flow detail (inline): config summary + recent jobs + "Lịch sử job" + per-job "Logs" modal
 */

import React, { useState, useEffect, useCallback } from 'react';
import ipc from '../../lib/ipc';
import { useAppStore } from '../../store/appStore';
import { useAccountStore } from '../../store/accountStore';

interface AutoCommentConfig {
  id: string;
  account_id: string;
  comments: string[];
  group_ids: string[];
  max_posts_per_run: number;
  schedule_minutes: number;
  enabled: boolean;
  doc_id_create_comment?: string | null;
  comment_count_per_post?: number;
  comment_pick_mode?: 'random' | 'sequential';
}

interface AutoCommentJob {
  id: string;
  config_id: string;
  account_id: string;
  trigger: 'manual' | 'scheduled';
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  scheduled_at: number;
  started_at?: number | null;
  ended_at?: number | null;
  posts_targeted: number;
  comments_posted: number;
  error?: string;
}

interface AutoCommentLog {
  id: string;
  config_id: string;
  group_id: string;
  group_name: string;
  post_id: string;
  comments: string[];
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  executed_at: number;
  job_id?: string | null;
}

type SessionState = 'verified' | 'cookie_missing' | 'expired' | 'unknown';

interface WorkerStatus {
  enabled: boolean;
  lastTickAt: number;
  lastError: string;
  nextTickAt: number;
  runningCount: number;
  runningJobIds: string[];
  pendingCount: number;
  globalConcurrency: number;
}

const DEFAULT_COMMENTS = `Shopee mình nè: https://s.shopee.vn/7pu0VWbPVd
Nhóm chuyên săn sale ba mẹ yên tâm săn tại đây nha https://zalo.me/g/iu4snpgw7xhc7bp4stfm`;

// SVG Icons
const IconArrowLeft = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5M12 19l-7-7 7-7"/>
  </svg>
);

const IconUser = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

const IconMessage = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);

const IconUsers = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);

const IconSettings = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);

const IconX = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

const IconPlus = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

export const AutoCommentView: React.FC = () => {
  const [fbAccounts, setFbAccounts] = useState<any[]>([]);
  const [configs, setConfigs] = useState<AutoCommentConfig[]>([]);
  const [selectedConfig, setSelectedConfig] = useState<AutoCommentConfig | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [formAccountId, setFormAccountId] = useState('');
  const [formCommentTemplates, setFormCommentTemplates] = useState<string[]>(['']);
  const [formCommentsPerPost, setFormCommentsPerPost] = useState(1);
  const [formPickMode, setFormPickMode] = useState<'sequential' | 'random'>('sequential');
  const [formGroupIds, setFormGroupIds] = useState<string[]>([]);
  const [formMaxPosts, setFormMaxPosts] = useState(10);
  const [formSchedule, setFormSchedule] = useState(60);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formGroupInput, setFormGroupInput] = useState('');
  const [formDocId, setFormDocId] = useState('');

  // Multi-account selection
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');

  // Per-account session state cache (probed via IPC)
  const [sessionStateByAccount, setSessionStateByAccount] = useState<Record<string, { state: SessionState; reason?: string }>>({});
  // Currently open debug browsers (multi-instance)
  const [openBrowsers, setOpenBrowsers] = useState<Set<string>>(new Set());

  // Worker status (new shape)
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  // Jobs grouped by config_id
  const [jobsByConfig, setJobsByConfig] = useState<Record<string, AutoCommentJob[]>>({});
  // Selected flow id for inline detail
  const [activeConfigId, setActiveConfigId] = useState<string | null>(null);
  // Per-job logs modal
  const [jobLogs, setJobLogs] = useState<{ jobId: string; logs: AutoCommentLog[] } | null>(null);
  // Legacy logs modal (per-config, includes job_id = null rows)
  const [legacyLogs, setLegacyLogs] = useState<{ configId: string; logs: AutoCommentLog[] } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  // Stores
  const { setAddAccountModalOpen } = useAppStore();
  const { setAccounts } = useAccountStore();

  const refreshAccounts = useCallback(async () => {
    const r = await ipc.fb.getAccounts();
    if (r?.success && r.accounts) {
      setFbAccounts(r.accounts);
      setAccounts(r.accounts);
      setSelectedAccountId((prev) => prev || r.accounts?.[0]?.id || '');
    }
  }, [setAccounts]);

  const refreshOpenBrowsers = useCallback(async () => {
    try {
      const r = await ipc.autoComment.debugListOpenBrowsers();
      if (r?.success) setOpenBrowsers(new Set(r.accountIds || []));
    } catch {}
  }, []);

  const refreshSessionStates = useCallback(async () => {
    if (fbAccounts.length === 0) return;
    const updates: Record<string, { state: SessionState; reason?: string }> = {};
    await Promise.all(fbAccounts.map(async (a) => {
      try {
        const r = await ipc.autoComment.checkAccountSession({ accountId: a.id });
        if (r?.success) updates[a.id] = { state: r.state, reason: r.reason };
      } catch {}
    }));
    if (Object.keys(updates).length > 0) {
      setSessionStateByAccount((prev) => ({ ...prev, ...updates }));
    }
  }, [fbAccounts]);

  const refreshWorker = useCallback(async () => {
    try {
      const r = await ipc.autoComment.getWorkerStatus();
      if (r?.success && r.status) setWorker(r.status);
    } catch {}
  }, []);

  const refreshJobs = useCallback(async (cfgIds: string[]) => {
    const map: Record<string, AutoCommentJob[]> = {};
    await Promise.all(cfgIds.map(async (cid) => {
      try {
        const r = await ipc.autoComment.getJobs({ configId: cid, limit: 20 });
        if (r?.success) map[cid] = r.jobs || [];
      } catch {}
    }));
    setJobsByConfig((prev) => ({ ...prev, ...map }));
  }, []);

  useEffect(() => {
    loadData();
    refreshWorker();
    refreshOpenBrowsers();
    const tick = setInterval(() => {
      refreshWorker();
      refreshOpenBrowsers();
      // Session states are not probed every 10s — too many accounts → too many probes.
      // Probe at 60s cadence below.
    }, 10_000);
    const sessionTick = setInterval(refreshSessionStates, 60_000);
    return () => { clearInterval(tick); clearInterval(sessionTick); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Probing once after accounts load. Re-probe when user changes account.
  useEffect(() => { refreshSessionStates(); }, [refreshSessionStates]);

  // Refresh jobs whenever the visible flow set changes.
  const visibleConfigIds = configs
    .filter((c) => selectedAccountId ? c.account_id === selectedAccountId : true)
    .map((c) => c.id);
  useEffect(() => {
    if (visibleConfigIds.length === 0) return;
    refreshJobs(visibleConfigIds);
    const t = setInterval(() => refreshJobs(visibleConfigIds), 10_000);
    return () => clearInterval(t);
  }, [visibleConfigIds.join(','), refreshJobs]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [configsResult] = await Promise.all([
        ipc.autoComment.getConfigs(),
      ]);
      if (configsResult.success) setConfigs(configsResult.configs || []);
      else setError(configsResult.error || 'Lỗi tải cấu hình');
      await refreshAccounts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleNewConfig = () => {
    setSelectedConfig(null);
    setFormAccountId(selectedAccountId || fbAccounts[0]?.id || '');
    // Seed 2 mẫu mặc định từ DEFAULT_COMMENTS (split theo \n) — mỗi mẫu 1 textarea riêng.
    setFormCommentTemplates(DEFAULT_COMMENTS.split('\n').map((s) => s.trim()).filter((s) => s));
    setFormCommentsPerPost(2);
    setFormPickMode('sequential');
    setFormGroupIds([]);
    setFormMaxPosts(10);
    setFormSchedule(60);
    setFormEnabled(true);
    setFormGroupInput('');
    setFormDocId('');
    setIsEditing(true);
    setError(null);
  };

  const handleEditConfig = (config: AutoCommentConfig) => {
    setSelectedConfig(config);
    setFormAccountId(config.account_id);
    // Mỗi mẫu = 1 phần tử (giữ nguyên \n bên trong). Nếu config rỗng, show 1 ô trống để user nhập.
    const tpls = config.comments && config.comments.length > 0 ? [...config.comments] : [''];
    setFormCommentTemplates(tpls);
    // Legacy: thiếu comment_count_per_post → mặc định = tất cả mẫu (giữ behavior cũ).
    const perPost = typeof config.comment_count_per_post === 'number' && config.comment_count_per_post > 0
      ? config.comment_count_per_post
      : tpls.length;
    setFormCommentsPerPost(Math.max(1, Math.min(perPost, tpls.length)));
    setFormPickMode(config.comment_pick_mode === 'random' ? 'random' : 'sequential');
    setFormGroupIds(config.group_ids);
    setFormMaxPosts(config.max_posts_per_run);
    setFormSchedule(config.schedule_minutes);
    setFormEnabled(config.enabled);
    setFormGroupInput('');
    setFormDocId(config.doc_id_create_comment || '');
    setIsEditing(true);
    setError(null);
  };

  const handleSaveConfig = async () => {
    if (!formAccountId) { setError('Vui lòng chọn tài khoản Facebook'); return; }
    // Mỗi mẫu trim whitespace; nếu trim rỗng → reject (yêu cầu người dùng xoá ô đó).
    const trimmed = formCommentTemplates.map((s) => s.trim());
    if (trimmed.length === 0) { setError('Cần ít nhất 1 mẫu bình luận'); return; }
    const blankIndex = trimmed.findIndex((s) => s.length === 0);
    if (blankIndex >= 0) {
      setError(`Mẫu ${blankIndex + 1} đang trống (chỉ có khoảng trắng). Hãy nhập nội dung hoặc xoá mẫu.`);
      return;
    }
    if (formCommentsPerPost < 1) { setError('Số bình luận trên mỗi bài phải ≥ 1'); return; }
    if (formCommentsPerPost > trimmed.length) {
      setError(`Số bình luận trên mỗi bài (${formCommentsPerPost}) không thể lớn hơn số mẫu (${trimmed.length})`);
      return;
    }
    if (formGroupIds.length === 0) { setError('Vui lòng thêm ít nhất 1 Group ID'); return; }

    setLoading(true);
    setError(null);
    try {
      const configData = {
        id: selectedConfig?.id,
        account_id: formAccountId,
        // Lưu nguyên văn (chưa trim ở đây — đã validate bằng trimmed[] ở trên, nhưng giữ nội dung gốc để emoji/format không bị mất whitespace quan trọng).
        comments: formCommentTemplates.map((s) => s),
        group_ids: formGroupIds,
        max_posts_per_run: formMaxPosts,
        schedule_minutes: formSchedule,
        enabled: formEnabled,
        doc_id_create_comment: formDocId.trim() || null,
        comment_count_per_post: formCommentsPerPost,
        comment_pick_mode: formPickMode,
      };
      const result = await ipc.autoComment.saveConfig(configData);
      if (result.success) { setIsEditing(false); await loadData(); }
      else setError(result.error || 'Lỗi lưu cấu hình');
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const handleDeleteConfig = async (id: string) => {
    setLoading(true);
    try {
      const result = await ipc.autoComment.deleteConfig({ id });
      if (result.success) { await loadData(); setSelectedConfig(null); setIsEditing(false); }
      else setError(result.error || 'Lỗi xóa cấu hình');
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); setShowDeleteConfirm(null); }
  };

  const handleRunNow = async (configId: string) => {
    setError(null);
    try {
      const r = await ipc.autoComment.runJob({ configId });
      if (!r.success) { setError(r.error || 'Không thể enqueue job'); return; }
      await refreshJobs([configId]);
    } catch (err: any) { setError(err.message); }
  };

  const handleStopFlow = async (configId: string) => {
    if (!confirm('Dừng flow này? Job đang chờ sẽ bị huỷ, job đang chạy sẽ được yêu cầu dừng an toàn. Lịch chạy tự động vẫn giữ.')) return;
    try {
      const r = await ipc.autoComment.stopFlow({ configId });
      if (!r.success) { setError(r.error || 'Lỗi dừng flow'); return; }
      await refreshJobs([configId]);
    } catch (err: any) { setError(err.message); }
  };

  const handleCancelJob = async (jobId: string, configId: string) => {
    try {
      const r = await ipc.autoComment.cancelJob({ jobId });
      if (!r.success) setError(r.error || 'Không thể huỷ job');
      await refreshJobs([configId]);
    } catch (err: any) { setError(err.message); }
  };

  const handleViewJobLogs = async (jobId: string) => {
    try {
      const r = await ipc.autoComment.getJobLogs({ jobId, limit: 200 });
      if (r.success) setJobLogs({ jobId, logs: r.logs || [] });
    } catch (err: any) { setError(err.message); }
  };

  const handleViewLegacyLogs = async (configId: string) => {
    try {
      const r = await ipc.autoComment.getLogs({ configId, limit: 50 });
      if (r.success) setLegacyLogs({ configId, logs: r.logs || [] });
    } catch (err: any) { setError(err.message); }
  };

  // Per-account: open browser cho account đang chọn. Multi-instance, không đóng browser account khác.
  const handleOpenBrowserForAccount = async (accountId: string) => {
    if (!accountId) return;
    setError(null);
    try {
      const r = await ipc.autoComment.debugOpenBrowserWithCookie({
        accountId,
        startUrl: 'https://www.facebook.com/',
      });
      if (!r.success) { setError(r.error || 'Lỗi mở browser'); return; }
      if ((r as any).alreadyOpen) {
        setError('Browser của tài khoản này đã mở — đã focus về cửa sổ đó.');
      }
      await refreshOpenBrowsers();
    } catch (err: any) { setError(err.message); }
  };

  const handleCloseBrowserForAccount = async (accountId: string) => {
    try {
      await ipc.autoComment.debugCloseBrowser({ accountId });
      await refreshOpenBrowsers();
    } catch (err: any) { setError(err.message); }
  };

  // ponytail: Debug - remove after capturing doc_ids
  const handleDebugDumpCookie = async (accountId: string) => {
    if (!accountId) return;
    try {
      const r = await ipc.autoComment.debugDumpCookie({ accountId });
      if (r.success) alert(`Đã dump cookie ra:\n${r.path}`);
      else setError(r.error || 'Lỗi dump cookie');
    } catch (err: any) { setError(err.message); }
  };

  const handleAddAccount = () => {
    setAddAccountModalOpen(true);
  };

  // Legacy: gán account cho config orphan (account_id không tồn tại trong fb_accounts).
  const handleAssignOrphan = (config: AutoCommentConfig) => {
    handleEditConfig(config);
  };

  const addGroupId = () => {
    const raw = formGroupInput.trim();
    if (!raw) return;
    // Accept: "1234567890", "facebook.com/groups/1234567890", "https://www.facebook.com/groups/1234567890/"
    const match = raw.match(/groups\/(\d+)|^\d+$/);
    const id = match ? (match[1] || match[0]) : '';
    if (!id) { setError('Group ID không hợp lệ. Vui lòng nhập ID số hoặc URL group.'); return; }
    if (!formGroupIds.includes(id)) setFormGroupIds([...formGroupIds, id]);
    setFormGroupInput('');
  };

  const removeGroupId = (id: string) => setFormGroupIds(formGroupIds.filter(g => g !== id));

  // ─── Comment template form helpers ─────────────────────────────────────────
  // Đổi tổng số mẫu (N). Mỗi phần tử = 1 textarea riêng.
  const setTemplateCount = (next: number) => {
    const n = Math.max(1, Math.floor(Number(next) || 1));
    setFormCommentTemplates((cur) => {
      if (n === cur.length) return cur;
      if (n > cur.length) {
        return [...cur, ...Array(n - cur.length).fill('')];
      }
      // Giảm: kiểm tra mẫu sắp bị loại có nội dung không.
      const removed = cur[n];
      if (removed && removed.trim().length > 0) {
        const ok = confirm(
          `Mẫu ${n + 1} có nội dung. Xoá vĩnh viễn mẫu này?\n\n"${removed.slice(0, 80)}${removed.length > 80 ? '…' : ''}"`,
        );
        if (!ok) return cur;
      }
      return cur.slice(0, n);
    });
  };

  const updateTemplate = (idx: number, val: string) => {
    setFormCommentTemplates((cur) => cur.map((t, i) => (i === idx ? val : t)));
  };

  const removeTemplate = (idx: number) => {
    setFormCommentTemplates((cur) => {
      if (cur.length <= 1) return cur; // luôn giữ ít nhất 1 mẫu
      const t = cur[idx];
      if (t && t.trim().length > 0) {
        const ok = confirm(`Xoá mẫu ${idx + 1}?\n\n"${t.slice(0, 80)}${t.length > 80 ? '…' : ''}"`);
        if (!ok) return cur;
      }
      const next = cur.filter((_, i) => i !== idx);
      // Đồng bộ comments-per-post nếu nó vượt quá số mẫu mới.
      if (formCommentsPerPost > next.length) setFormCommentsPerPost(next.length);
      return next;
    });
  };

  const addTemplate = () => {
    setFormCommentTemplates((cur) => [...cur, '']);
  };

  // ─── EDIT MODE ────────────────────────────────────────────────────────────────
  if (isEditing) {
    return (
      <div className="h-full overflow-y-auto bg-[#F8FAFC]">
        <div className="max-w-[880px] mx-auto px-4 md:px-6 py-8" style={{ paddingBottom: '120px' }}>
          {/* Header */}
          <div className="mb-8">
            <button
              onClick={() => setIsEditing(false)}
              className="flex items-center gap-2 text-[#64748B] hover:text-[#0F172A] transition-colors mb-4"
            >
              <IconArrowLeft />
              <span className="text-sm font-medium">Quay lại</span>
            </button>
            <h1 className="text-2xl font-semibold text-[#0F172A]">
              {selectedConfig ? 'Chỉnh sửa Auto Comment' : 'Tạo Auto Comment mới'}
            </h1>
            <p className="text-[#64748B] mt-1">Thiết lập tài khoản, nội dung bình luận, nhóm và lịch chạy.</p>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">
              {error}
            </div>
          )}

          <div className="space-y-5">
            {/* Section 1 - Account */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-lg bg-[#EFF6FF] flex items-center justify-center text-[#2563EB]">
                  <IconUser />
                </div>
                <h2 className="text-base font-semibold text-[#0F172A]">Tài khoản Facebook</h2>
              </div>
              <select
                className="w-full h-11 px-4 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all"
                value={formAccountId}
                onChange={(e) => setFormAccountId(e.target.value)}
              >
                <option value="">Chọn tài khoản...</option>
                {fbAccounts.map(acc => (
                  <option key={acc.id} value={acc.id}>{acc.name || acc.facebook_id}</option>
                ))}
              </select>
            </div>

            {/* Section 2 - Comments */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-lg bg-[#EFF6FF] flex items-center justify-center text-[#2563EB]">
                  <IconMessage />
                </div>
                <h2 className="text-base font-semibold text-[#0F172A]">Nội dung bình luận</h2>
                <span className="ml-auto text-sm text-[#64748B]">{formCommentTemplates.length} mẫu</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-[#0F172A] mb-2">
                    Số lượng mẫu bình luận
                  </label>
                  <input
                    type="number"
                    min={1}
                    className="w-full h-11 px-4 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all"
                    value={formCommentTemplates.length}
                    onChange={(e) => setTemplateCount(parseInt(e.target.value, 10) || 1)}
                    aria-label="Số lượng mẫu bình luận"
                  />
                  <p className="text-xs text-[#94A3B8] mt-2">Số nội dung bạn chuẩn bị sẵn.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#0F172A] mb-2">
                    Số bình luận trên mỗi bài
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={formCommentTemplates.length}
                    className="w-full h-11 px-4 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all"
                    value={formCommentsPerPost}
                    onChange={(e) => {
                      const v = Math.max(1, parseInt(e.target.value, 10) || 1);
                      setFormCommentsPerPost(Math.min(v, formCommentTemplates.length));
                    }}
                    aria-label="Số bình luận trên mỗi bài"
                  />
                  <p className="text-xs text-[#94A3B8] mt-2">
                    Số comment thực sự đăng / 1 bài viết. Tối đa = số mẫu hiện có.
                  </p>
                </div>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-[#0F172A] mb-2">
                  Cách dùng mẫu
                </label>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 px-3 h-10 rounded-lg border border-[#E2E8F0] cursor-pointer text-sm hover:bg-[#F8FAFC]">
                    <input
                      type="radio"
                      name="pickMode"
                      className="accent-[#2563EB]"
                      checked={formPickMode === 'sequential'}
                      onChange={() => setFormPickMode('sequential')}
                    />
                    <span>Theo thứ tự (1→2→… quay vòng)</span>
                  </label>
                  <label className="flex items-center gap-2 px-3 h-10 rounded-lg border border-[#E2E8F0] cursor-pointer text-sm hover:bg-[#F8FAFC]">
                    <input
                      type="radio"
                      name="pickMode"
                      className="accent-[#2563EB]"
                      checked={formPickMode === 'random'}
                      onChange={() => setFormPickMode('random')}
                    />
                    <span>Ngẫu nhiên (không trùng trong 1 bài)</span>
                  </label>
                </div>
              </div>

              <div className="space-y-3">
                {formCommentTemplates.map((tpl, idx) => (
                  <div key={idx} className="border border-[#E2E8F0] rounded-lg p-3 bg-[#F8FAFC]">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-medium text-[#64748B]">
                        Mẫu {idx + 1}
                        {tpl.trim().length === 0 && (
                          <span className="ml-2 text-red-500 font-normal">(trống — hãy nhập nội dung hoặc xoá)</span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeTemplate(idx)}
                        disabled={formCommentTemplates.length <= 1}
                        className="ml-auto w-7 h-7 rounded-lg hover:bg-[#FEE2E2] hover:text-red-500 transition-colors flex items-center justify-center text-[#94A3B8] disabled:opacity-30 disabled:cursor-not-allowed"
                        title={formCommentTemplates.length <= 1 ? 'Cần giữ ít nhất 1 mẫu' : 'Xoá mẫu này'}
                        aria-label={`Xoá mẫu ${idx + 1}`}
                      >
                        <IconX />
                      </button>
                    </div>
                    <textarea
                      className="w-full px-3 py-2 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm font-mono leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all"
                      style={{ minHeight: '88px' }}
                      placeholder="Nội dung mẫu — có thể gồm nhiều dòng, emoji, link…"
                      value={tpl}
                      onChange={(e) => updateTemplate(idx, e.target.value)}
                      aria-label={`Nội dung mẫu ${idx + 1}`}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addTemplate}
                  className="h-10 w-full rounded-lg border border-dashed border-[#94A3B8] text-[#64748B] text-sm font-medium hover:bg-[#F8FAFC] transition-colors flex items-center justify-center gap-2"
                  title="Thêm mẫu mới"
                >
                  <IconPlus />
                  <span>Thêm mẫu</span>
                </button>
              </div>
            </div>

            {/* Section 3 - Groups */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-lg bg-[#EFF6FF] flex items-center justify-center text-[#2563EB]">
                  <IconUsers />
                </div>
                <h2 className="text-base font-semibold text-[#0F172A]">Nhóm Facebook</h2>
                <span className="ml-auto text-sm text-[#64748B]">{formGroupIds.length} nhóm</span>
              </div>
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  className="flex-1 h-11 px-4 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all"
                  placeholder="Nhập Group ID hoặc URL..."
                  value={formGroupInput}
                  onChange={(e) => setFormGroupInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addGroupId())}
                />
                <button
                  onClick={addGroupId}
                  className="h-11 px-5 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors flex items-center gap-2"
                >
                  <IconPlus />
                  <span>Thêm</span>
                </button>
              </div>
              <div className="space-y-2">
                {formGroupIds.length === 0 && (
                  <p className="text-sm text-[#94A3B8] py-3">Chưa có nhóm nào được thêm.</p>
                )}
                {formGroupIds.map(groupId => (
                  <div key={groupId} className="flex items-center justify-between p-3 bg-[#F8FAFC] rounded-lg border border-[#E2E8F0]">
                    <span className="text-sm text-[#0F172A] truncate flex-1 mr-4">{groupId}</span>
                    <button
                      onClick={() => removeGroupId(groupId)}
                      className="w-8 h-8 rounded-lg hover:bg-[#FEE2E2] hover:text-red-500 transition-colors flex items-center justify-center text-[#94A3B8]"
                    >
                      <IconX />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Section 4 - Settings */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-9 h-9 rounded-lg bg-[#EFF6FF] flex items-center justify-center text-[#2563EB]">
                  <IconSettings />
                </div>
                <h2 className="text-base font-semibold text-[#0F172A]">Cài đặt tự động</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-[#0F172A] mb-2">Số bài viết mỗi lần</label>
                  <input
                    type="number"
                    className="w-full h-11 px-4 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all"
                    value={formMaxPosts}
                    onChange={(e) => setFormMaxPosts(Math.max(1, parseInt(e.target.value) || 1))}
                    min={1}
                  />
                  <p className="text-xs text-[#94A3B8] mt-2">Số bài viết tối đa được xử lý trong một lượt.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#0F172A] mb-2">Chu kỳ tự động</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      className="flex-1 h-11 px-4 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all"
                      value={formSchedule}
                      onChange={(e) => setFormSchedule(Math.max(10, parseInt(e.target.value) || 60))}
                      min={10}
                    />
                    <span className="text-sm text-[#64748B]">phút</span>
                  </div>
                  <p className="text-xs text-[#94A3B8] mt-2">Khoảng thời gian giữa các lượt chạy.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#0F172A] mb-2">
                    Doc ID override <span className="text-[#94A3B8] font-normal">(tùy chọn)</span>
                  </label>
                  <input
                    type="text"
                    className="w-full h-11 px-4 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all"
                    value={formDocId}
                    onChange={(e) => setFormDocId(e.target.value)}
                    placeholder="Để trống = dùng mặc định"
                  />
                  <p className="text-xs text-[#94A3B8] mt-2">
                    Chỉ đổi khi Facebook rotate doc_id. Mở Chrome đã login FB → F12 Network → filter graphql → comment thử → copy <code className="bg-slate-100 px-1 rounded">doc_id</code> từ Payload.
                  </p>
                </div>
              </div>
            </div>

            {/* Enable Toggle */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
              <label className="flex items-center gap-4 cursor-pointer">
                <div className="relative">
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={formEnabled}
                    onChange={(e) => setFormEnabled(e.target.checked)}
                  />
                  <div className={`w-12 h-7 rounded-full transition-colors ${formEnabled ? 'bg-[#2563EB]' : 'bg-[#E2E8F0]'}`}>
                    <div className={`w-5 h-5 bg-white rounded-full shadow-sm transform transition-transform mt-1 ${formEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </div>
                </div>
                <div>
                  <span className="text-sm font-medium text-[#0F172A]">Bật Auto Comment</span>
                  <p className="text-xs text-[#64748B] mt-0.5">Bot sẽ tự động chạy theo lịch trình.</p>
                </div>
              </label>
            </div>

            {/* Footer Actions */}
            <div className="flex items-center gap-3 pt-4">
              <button
                onClick={() => setIsEditing(false)}
                className="h-11 px-6 rounded-lg border border-[#E2E8F0] text-[#64748B] text-sm font-medium hover:bg-[#F8FAFC] transition-colors"
              >
                Hủy
              </button>
              <button
                onClick={handleSaveConfig}
                className="h-11 px-6 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors flex-1 md:flex-none md:min-w-[160px] justify-center"
                disabled={loading}
              >
                {loading ? (
                  <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  selectedConfig ? 'Lưu thay đổi' : 'Tạo Auto Comment'
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── LIST MODE ────────────────────────────────────────────────────────────────

  // Compute derived lists used by JSX
  const accountMap = new Map(fbAccounts.map((a) => [a.id, a]));
  const accountIds = new Set(fbAccounts.map((a) => a.id));
  const orphanConfigs = configs.filter((c) => !accountIds.has(c.account_id));
  const visibleConfigs = selectedAccountId
    ? configs.filter((c) => c.account_id === selectedAccountId)
    : configs;
  const selectedAccount = selectedAccountId ? accountMap.get(selectedAccountId) : null;
  const sessionForSelected = selectedAccountId ? sessionStateByAccount[selectedAccountId] : null;

  const sessionBadge = (state: SessionState | undefined, reason?: string) => {
    switch (state) {
      case 'verified':
        return { text: 'Session OK', cls: 'bg-green-100 text-green-700' };
      case 'expired':
        return { text: 'Cookie hết hạn', cls: 'bg-red-100 text-red-700', reason };
      case 'cookie_missing':
        return { text: 'Chưa có cookie', cls: 'bg-amber-100 text-amber-700', reason };
      case 'unknown':
      default:
        return { text: 'Đang kiểm tra…', cls: 'bg-slate-100 text-slate-600' };
    }
  };

  const jobStatusBadge = (s: AutoCommentJob['status']) => {
    switch (s) {
      case 'running':
        return { text: 'Đang chạy', cls: 'bg-blue-100 text-blue-700' };
      case 'pending':
        return { text: 'Đang chờ', cls: 'bg-slate-100 text-slate-700' };
      case 'success':
        return { text: 'Xong', cls: 'bg-green-100 text-green-700' };
      case 'failed':
        return { text: 'Lỗi', cls: 'bg-red-100 text-red-700' };
      case 'cancelled':
        return { text: 'Đã huỷ', cls: 'bg-amber-100 text-amber-700' };
      default:
        return { text: s, cls: 'bg-slate-100 text-slate-700' };
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#F8FAFC]">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-8 pb-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[#0F172A]">Auto Comment Facebook</h1>
            <p className="text-[#64748B] mt-1">Mỗi tài khoản có browser + job queue riêng. Worker chạy chung với concurrency cap.</p>
          </div>
          <button
            onClick={handleNewConfig}
            className="h-11 px-5 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors flex items-center gap-2"
          >
            <IconPlus />
            <span>Tạo flow</span>
          </button>
        </div>

        {/* Worker Status (compact) */}
        <div className="mb-4 bg-white rounded-xl border border-[#E2E8F0] px-5 py-3 flex items-center gap-3 flex-wrap text-sm">
          <div className={`w-2.5 h-2.5 rounded-full ${worker?.enabled ? (worker.lastError ? 'bg-red-500' : 'bg-green-500 animate-pulse') : 'bg-[#94A3B8]'}`} />
          <span className="font-semibold text-[#0F172A]">
            {worker?.enabled
              ? (worker.lastError ? `Worker lỗi: ${worker.lastError}` : `Worker sẵn sàng · ${worker.runningCount}/${worker.globalConcurrency} job đang chạy`)
              : 'Worker đã dừng'}
          </span>
          {worker && worker.pendingCount > 0 && (
            <span className="text-[#64748B]">· {worker.pendingCount} đang chờ slot</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {worker?.enabled ? (
              <button
                onClick={async () => { await ipc.autoComment.stopWorker(); await refreshWorker(); }}
                className="h-8 px-3 rounded-lg bg-[#F1F5F9] text-[#64748B] text-xs font-medium hover:bg-[#E2E8F0] transition-colors"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={async () => { await ipc.autoComment.startWorker(); await refreshWorker(); }}
                className="h-8 px-3 rounded-lg bg-[#EFF6FF] text-[#2563EB] text-xs font-medium hover:bg-[#DBEAFE] transition-colors"
              >
                Start
              </button>
            )}
          </div>
        </div>

        {/* Account bar */}
        <div className="mb-6 bg-white rounded-xl border border-[#E2E8F0] px-5 py-4 flex items-center gap-3 flex-wrap">
          <IconUser />
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            disabled={fbAccounts.length === 0}
            className="h-10 px-3 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] min-w-[240px]"
            aria-label="Chọn tài khoản Facebook"
          >
            {fbAccounts.length === 0 && <option value="">— chưa có tài khoản —</option>}
            {fbAccounts.map((acc) => {
              const st = sessionStateByAccount[acc.id]?.state || 'unknown';
              const label = `${acc.name || acc.facebook_id || acc.id.slice(0, 8)} · ${st}`;
              return <option key={acc.id} value={acc.id}>{label}</option>;
            })}
          </select>

          {selectedAccount && (() => {
            const badge = sessionBadge(sessionForSelected?.state, sessionForSelected?.reason);
            return (
              <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${badge.cls}`} title={badge.reason}>
                {badge.text}
              </span>
            );
          })()}

          {openBrowsers.has(selectedAccountId) && (
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
              ● Browser đang mở
            </span>
          )}

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <button
              onClick={() => selectedAccountId && handleOpenBrowserForAccount(selectedAccountId)}
              disabled={!selectedAccountId}
              className="h-10 px-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 transition-colors disabled:opacity-50"
              title="Mở Chromium với cookie đã lưu của tài khoản đang chọn"
            >
              🐞 {openBrowsers.has(selectedAccountId) ? 'Focus Browser' : 'Mở Browser'}
            </button>
            {openBrowsers.has(selectedAccountId) && (
              <button
                onClick={() => selectedAccountId && handleCloseBrowserForAccount(selectedAccountId)}
                className="h-10 px-3 rounded-lg border border-slate-300 bg-white text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
                title="Đóng browser của tài khoản đang chọn"
              >
                ✕ Đóng
              </button>
            )}
            {/* ponytail: Dump cookie — remove after capturing doc_ids */}
            {selectedAccountId && (
              <button
                onClick={() => handleDebugDumpCookie(selectedAccountId)}
                className="h-10 px-3 rounded-lg border border-slate-300 bg-white text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
                title="Dump cookie ra file"
              >
                📋
              </button>
            )}
            <button
              onClick={handleAddAccount}
              className="h-10 px-4 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors flex items-center gap-2"
            >
              <IconPlus />
              <span>Thêm tài khoản</span>
            </button>
          </div>
        </div>

        {/* Open browser indicator (others) */}
        {openBrowsers.size > 0 && (
          <div className="mb-4 text-xs text-[#64748B] flex items-center gap-2 flex-wrap">
            <span>Browser đang mở cho:</span>
            {Array.from(openBrowsers).map((aid) => {
              const acc = accountMap.get(aid);
              if (!acc) return null;
              const isSelected = aid === selectedAccountId;
              return (
                <button
                  key={aid}
                  onClick={() => setSelectedAccountId(aid)}
                  className={`px-2 py-0.5 rounded-full ${isSelected ? 'bg-[#2563EB] text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
                >
                  {acc.name || acc.id.slice(0, 8)}
                </button>
              );
            })}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
              <IconX />
            </button>
          </div>
        )}

        {/* Orphan configs banner */}
        {orphanConfigs.length > 0 && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl">
            <p className="text-sm text-amber-800 font-medium mb-1">
              {orphanConfigs.length} flow không tìm thấy tài khoản tương ứng (đã bị xoá account?)
            </p>
            <p className="text-xs text-amber-700 mb-3">
              Bấm "Gán lại" để chỉnh sửa và chọn tài khoản khác. Flow này sẽ không tự động chạy cho đến khi được gán.
            </p>
            <div className="space-y-1">
              {orphanConfigs.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-sm">
                  <span className="text-amber-900 truncate flex-1">
                    {c.comments[0]?.slice(0, 60) || 'Flow trống'} <span className="text-amber-600">({c.account_id.slice(0, 8)}…)</span>
                  </span>
                  <button
                    onClick={() => handleAssignOrphan(c)}
                    className="h-7 px-3 rounded-lg bg-amber-200 text-amber-800 text-xs font-medium hover:bg-amber-300 transition-colors"
                  >
                    Gán lại
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-[#E2E8F0] border-t-[#2563EB] rounded-full animate-spin" />
          </div>
        )}

        {/* Empty state (no accounts) */}
        {!loading && fbAccounts.length === 0 && (
          <div className="bg-white rounded-xl border border-[#E2E8F0] p-16 text-center">
            <div className="w-16 h-16 rounded-full bg-[#F8FAFC] flex items-center justify-center mx-auto mb-4">
              <IconUser />
            </div>
            <h3 className="text-lg font-medium text-[#0F172A] mb-2">Chưa có tài khoản Facebook nào</h3>
            <p className="text-sm text-[#64748B] mb-6">Thêm tài khoản trước khi tạo flow Auto Comment.</p>
            <button
              onClick={handleAddAccount}
              className="h-11 px-6 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors"
            >
              Thêm tài khoản
            </button>
          </div>
        )}

        {/* Empty state (per-account) */}
        {!loading && fbAccounts.length > 0 && visibleConfigs.length === 0 && (
          <div className="bg-white rounded-xl border border-[#E2E8F0] p-12 text-center">
            <p className="text-base text-[#0F172A] font-medium mb-1">
              {selectedAccount ? `Tài khoản "${selectedAccount.name || selectedAccount.id.slice(0, 8)}" chưa có flow` : 'Chưa có flow nào'}
            </p>
            <p className="text-sm text-[#64748B] mb-4">Tạo flow để bắt đầu auto comment cho tài khoản này.</p>
            <button
              onClick={handleNewConfig}
              className="h-10 px-5 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors"
            >
              Tạo flow cho {selectedAccount?.name || 'tài khoản này'}
            </button>
          </div>
        )}

        {/* Flow cards */}
        {!loading && visibleConfigs.length > 0 && (
          <div className="space-y-4">
            {visibleConfigs.map((config) => {
              const account = accountMap.get(config.account_id);
              const isActive = activeConfigId === config.id;
              const jobs = jobsByConfig[config.id] || [];
              const latestJob = jobs[0];
              const hasActiveJob = jobs.some((j) => j.status === 'running' || j.status === 'pending');
              return (
                <div key={config.id} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                  {/* Flow row */}
                  <div className="p-5">
                    <div className="flex items-center gap-3 mb-3 flex-wrap">
                      <h3 className="text-base font-semibold text-[#0F172A]">
                        {account?.name || config.account_id.slice(0, 8)}
                      </h3>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${config.enabled ? 'bg-green-100 text-green-700' : 'bg-[#F1F5F9] text-[#64748B]'}`}>
                        {config.enabled ? 'Đang bật' : 'Tắt'}
                      </span>
                      {config.doc_id_create_comment && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700" title={config.doc_id_create_comment}>
                          Custom doc_id
                        </span>
                      )}
                      {hasActiveJob && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                          Có job đang chạy
                        </span>
                      )}
                      <button
                        onClick={() => setActiveConfigId(isActive ? null : config.id)}
                        className="ml-auto text-xs text-[#2563EB] hover:underline"
                      >
                        {isActive ? 'Thu gọn' : 'Lịch sử job ▾'}
                      </button>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-3">
                      <div>
                        <p className="text-xs text-[#94A3B8]">Bình luận</p>
                        <p className="font-medium text-[#0F172A]">{config.comments.length} mẫu</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#94A3B8]">Nhóm</p>
                        <p className="font-medium text-[#0F172A]">{config.group_ids.length} nhóm</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#94A3B8]">Bài/lần</p>
                        <p className="font-medium text-[#0F172A]">{config.max_posts_per_run}</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#94A3B8]">Chu kỳ</p>
                        <p className="font-medium text-[#0F172A]">{config.schedule_minutes} phút</p>
                      </div>
                    </div>

                    {latestJob && (
                      <div className="mb-3 text-xs text-[#64748B]">
                        Job gần nhất: {(() => {
                          const b = jobStatusBadge(latestJob.status);
                          return <span className={`ml-1 px-2 py-0.5 rounded-full font-medium ${b.cls}`}>{b.text}</span>;
                        })()}
                        {' · '}
                        {new Date(latestJob.scheduled_at).toLocaleString('vi-VN')}
                        {latestJob.error && (
                          <span className="ml-1 text-red-600" title={latestJob.error}>
                            — {latestJob.error.slice(0, 80)}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => handleRunNow(config.id)}
                        disabled={hasActiveJob}
                        className="h-9 px-4 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title={hasActiveJob ? 'Đã có job đang chạy/đang chờ' : 'Chạy ngay bây giờ'}
                      >
                        ▶ Chạy ngay
                      </button>
                      <button
                        onClick={() => handleStopFlow(config.id)}
                        disabled={!hasActiveJob}
                        className="h-9 px-4 rounded-lg border border-[#E2E8F0] text-[#64748B] text-sm hover:bg-[#F8FAFC] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title={hasActiveJob ? 'Dừng job đang chạy/đang chờ' : 'Không có job để dừng'}
                      >
                        ■ Dừng
                      </button>
                      <button
                        onClick={() => handleEditConfig(config)}
                        className="h-9 px-4 rounded-lg border border-[#E2E8F0] text-[#64748B] text-sm hover:bg-[#F8FAFC] transition-colors"
                      >
                        Sửa
                      </button>
                      <button
                        onClick={() => handleViewLegacyLogs(config.id)}
                        className="h-9 px-4 rounded-lg border border-[#E2E8F0] text-[#64748B] text-sm hover:bg-[#F8FAFC] transition-colors"
                        title="Logs (legacy): tất cả log từ trước khi schema job_id ra mắt"
                      >
                        Logs (legacy)
                      </button>
                      {showDeleteConfirm === config.id ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleDeleteConfig(config.id)}
                            className="h-9 px-3 rounded-lg bg-red-500 text-white text-sm hover:bg-red-600 transition-colors"
                          >
                            Xóa
                          </button>
                          <button
                            onClick={() => setShowDeleteConfirm(null)}
                            className="h-9 px-3 rounded-lg border border-[#E2E8F0] text-[#64748B] text-sm hover:bg-[#F8FAFC]"
                          >
                            Hủy
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setShowDeleteConfirm(config.id)}
                          className="h-9 px-4 rounded-lg border border-[#E2E8F0] text-red-500 text-sm hover:bg-red-50 transition-colors"
                        >
                          Xóa
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Inline jobs table */}
                  {isActive && (
                    <div className="border-t border-[#E2E8F0] bg-[#F8FAFC]">
                      <div className="p-4">
                        <p className="text-sm font-medium text-[#0F172A] mb-2">Lịch sử job (5 gần nhất)</p>
                        {jobs.length === 0 ? (
                          <p className="text-xs text-[#94A3B8]">Chưa chạy job nào cho flow này.</p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-[#94A3B8]">
                                <th className="py-2 pr-2">Bắt đầu</th>
                                <th className="py-2 pr-2">Trạng thái</th>
                                <th className="py-2 pr-2">Trigger</th>
                                <th className="py-2 pr-2">Bài</th>
                                <th className="py-2 pr-2">Comment</th>
                                <th className="py-2 pr-2">Lỗi</th>
                                <th className="py-2 pr-2"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {jobs.slice(0, 5).map((j) => {
                                const b = jobStatusBadge(j.status);
                                return (
                                  <tr key={j.id} className="border-t border-[#E2E8F0]">
                                    <td className="py-2 pr-2 text-[#0F172A] whitespace-nowrap">
                                      {new Date(j.started_at || j.scheduled_at).toLocaleString('vi-VN')}
                                    </td>
                                    <td className="py-2 pr-2">
                                      <span className={`px-2 py-0.5 rounded-full font-medium ${b.cls}`}>{b.text}</span>
                                    </td>
                                    <td className="py-2 pr-2 text-[#64748B]">{j.trigger === 'manual' ? 'Thủ công' : 'Tự động'}</td>
                                    <td className="py-2 pr-2 text-[#0F172A]">{j.posts_targeted}</td>
                                    <td className="py-2 pr-2 text-[#0F172A]">{j.comments_posted}</td>
                                    <td className="py-2 pr-2 text-red-600 max-w-[180px] truncate" title={j.error || ''}>
                                      {j.error || '—'}
                                    </td>
                                    <td className="py-2 pr-2 flex items-center gap-2">
                                      {(j.status === 'pending' || j.status === 'running') && (
                                        <button
                                          onClick={() => handleCancelJob(j.id, config.id)}
                                          className="text-red-500 hover:underline whitespace-nowrap"
                                        >
                                          Huỷ
                                        </button>
                                      )}
                                      <button
                                        onClick={() => handleViewJobLogs(j.id)}
                                        className="text-[#2563EB] hover:underline whitespace-nowrap"
                                      >
                                        Logs
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Job logs modal */}
        {jobLogs && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
            <div className="bg-white rounded-xl w-full max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
              <div className="p-6 border-b border-[#E2E8F0] flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[#0F172A]">Logs của job {jobLogs.jobId.slice(0, 8)}</h3>
                <button onClick={() => setJobLogs(null)} className="text-[#64748B] hover:text-[#0F172A]"><IconX /></button>
              </div>
              <div className="overflow-auto p-4 flex-1">
                {jobLogs.logs.length === 0 ? (
                  <p className="text-center py-12 text-[#64748B]">Job này chưa ghi log post-level.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-[#94A3B8] uppercase">
                        <th className="py-2 px-2">Thời gian</th>
                        <th className="py-2 px-2">Nhóm</th>
                        <th className="py-2 px-2">Post</th>
                        <th className="py-2 px-2">Comments</th>
                        <th className="py-2 px-2">Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobLogs.logs.map((l) => (
                        <tr key={l.id} className={`border-t border-[#E2E8F0] ${l.status === 'failed' ? 'bg-red-50' : ''}`}>
                          <td className="py-2 px-2 text-[#0F172A] whitespace-nowrap">{new Date(l.executed_at).toLocaleString('vi-VN')}</td>
                          <td className="py-2 px-2 text-[#0F172A]">{l.group_name || l.group_id}</td>
                          <td className="py-2 px-2 text-[#0F172A] text-xs">{l.post_id}</td>
                          <td className="py-2 px-2 max-w-[280px]">
                            {l.comments.map((c, i) => (
                              <p key={i} className="text-xs text-[#64748B] truncate">{i + 1}. {c}</p>
                            ))}
                          </td>
                          <td className="py-2 px-2">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${l.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                              {l.status === 'success' ? 'OK' : 'Lỗi'}
                            </span>
                            {l.error && <p className="text-xs text-red-600 mt-1 truncate" title={l.error}>{l.error}</p>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="p-4 border-t border-[#E2E8F0] flex justify-end">
                <button
                  onClick={() => setJobLogs(null)}
                  className="h-10 px-5 rounded-lg border border-[#E2E8F0] text-[#64748B] text-sm font-medium hover:bg-[#F8FAFC] transition-colors"
                >
                  Đóng
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Legacy logs modal */}
        {legacyLogs && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
            <div className="bg-white rounded-xl w-full max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
              <div className="p-6 border-b border-[#E2E8F0] flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[#0F172A]">Logs (legacy) — flow {legacyLogs.configId.slice(0, 8)}</h3>
                <button onClick={() => setLegacyLogs(null)} className="text-[#64748B] hover:text-[#0F172A]"><IconX /></button>
              </div>
              <div className="overflow-auto p-4 flex-1">
                {legacyLogs.logs.length === 0 ? (
                  <p className="text-center py-12 text-[#64748B]">Chưa có log legacy nào.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-[#94A3B8] uppercase">
                        <th className="py-2 px-2">Thời gian</th>
                        <th className="py-2 px-2">Nhóm</th>
                        <th className="py-2 px-2">Post</th>
                        <th className="py-2 px-2">Job</th>
                        <th className="py-2 px-2">Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody>
                      {legacyLogs.logs.map((l) => (
                        <tr key={l.id} className={`border-t border-[#E2E8F0] ${l.status === 'failed' ? 'bg-red-50' : ''}`}>
                          <td className="py-2 px-2 text-[#0F172A] whitespace-nowrap">{new Date(l.executed_at).toLocaleString('vi-VN')}</td>
                          <td className="py-2 px-2 text-[#0F172A]">{l.group_name || l.group_id}</td>
                          <td className="py-2 px-2 text-[#0F172A] text-xs">{l.post_id}</td>
                          <td className="py-2 px-2 text-[#64748B] text-xs">{l.job_id ? l.job_id.slice(0, 8) : '(legacy)'}</td>
                          <td className="py-2 px-2">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${l.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                              {l.status === 'success' ? 'OK' : 'Lỗi'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="p-4 border-t border-[#E2E8F0] flex justify-end">
                <button
                  onClick={() => setLegacyLogs(null)}
                  className="h-10 px-5 rounded-lg border border-[#E2E8F0] text-[#64748B] text-sm font-medium hover:bg-[#F8FAFC] transition-colors"
                >
                  Đóng
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AutoCommentView;
