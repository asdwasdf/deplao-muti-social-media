/**
 * AutoCommentView.tsx
 * Giao diện cấu hình Auto Comment - Minimal Form Design
 */

import React, { useState, useEffect } from 'react';
import ipc from '../../lib/ipc';

interface AutoCommentConfig {
  id: string;
  account_id: string;
  comments: string[];
  group_ids: string[];
  max_posts_per_run: number;
  schedule_minutes: number;
  enabled: boolean;
  doc_id_create_comment?: string | null;
}

interface AutoCommentLog {
  id: string;
  group_id: string;
  group_name: string;
  post_id: string;
  comments: string[];
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  executed_at: number;
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
  const [formComments, setFormComments] = useState('');
  const [formGroupIds, setFormGroupIds] = useState<string[]>([]);
  const [formMaxPosts, setFormMaxPosts] = useState(10);
  const [formSchedule, setFormSchedule] = useState(60);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formGroupInput, setFormGroupInput] = useState('');
  const [formDocId, setFormDocId] = useState('');

  // Logs
  const [logs, setLogs] = useState<AutoCommentLog[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  // Scheduler status (poll mỗi 10s)
  const [status, setStatus] = useState<{
    enabled: boolean;
    lastRunAt: number;
    lastRunSummary: string;
    nextRunAt: number;
    totalRuns: number;
    minutesSinceLastRun: number;
    minutesToNextRun: number;
  } | null>(null);

  useEffect(() => {
    loadData();
    const loadStatus = async () => {
      try {
        const r = await ipc.autoComment.getStatus();
        if (r.success && r.status) setStatus(r.status);
      } catch {}
    };
    loadStatus();
    const t = setInterval(loadStatus, 10_000);
    return () => clearInterval(t);
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [configsResult, accountsResult] = await Promise.all([
        ipc.autoComment.getConfigs(),
        ipc.fb.getAccounts(),
      ]);
      if (configsResult.success) setConfigs(configsResult.configs || []);
      else setError(configsResult.error || 'Lỗi tải cấu hình');
      if (accountsResult.success) setFbAccounts(accountsResult.accounts || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleNewConfig = () => {
    setSelectedConfig(null);
    setFormAccountId(fbAccounts[0]?.id || '');
    setFormComments(DEFAULT_COMMENTS);
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
    setFormComments(config.comments.join('\n'));
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
    const comments = formComments.split('\n').map(s => s.trim()).filter(Boolean);
    if (comments.length === 0) { setError('Vui lòng nhập ít nhất 1 comment'); return; }
    if (formGroupIds.length === 0) { setError('Vui lòng thêm ít nhất 1 Group ID'); return; }

    setLoading(true);
    setError(null);
    try {
      const configData = {
        id: selectedConfig?.id,
        account_id: formAccountId,
        comments,
        group_ids: formGroupIds,
        max_posts_per_run: formMaxPosts,
        schedule_minutes: formSchedule,
        enabled: formEnabled,
        doc_id_create_comment: formDocId.trim() || null,
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
    if (!confirm('Chạy auto comment ngay bây giờ?')) return;
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.autoComment.runNow({ configId });
      if (result.success) alert(`Hoàn thành! Đã comment ${result.commentsPosted} bài viết, targeting ${result.postsTargeted} posts`);
      else setError(result.error || 'Lỗi chạy auto comment');
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const handleViewLogs = async (configId: string) => {
    try {
      const result = await ipc.autoComment.getLogs({ configId, limit: 50 });
      if (result.success) { setLogs(result.logs || []); setShowLogs(true); }
    } catch (err: any) { setError(err.message); }
  };

  // ponytail: Debug - remove after capturing doc_ids
  const handleDebugDumpCookie = async () => {
    const acc = fbAccounts[0];
    if (!acc) { setError('Không có tài khoản Facebook nào để dump.'); return; }
    try {
      const result = await ipc.autoComment.debugDumpCookie({ accountId: acc.id });
      if (result.success) {
        alert(`Đã dump cookie ra:\n${result.path}`);
      } else {
        setError(result.error || 'Lỗi dump cookie');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  // ponytail: Debug - mở Chromium với cookie inject, giữ mở cho DevTools
  const handleOpenBrowser = async () => {
    const acc = fbAccounts[0];
    if (!acc) { setError('Không có tài khoản Facebook nào.'); return; }
    setError(null);
    try {
      // Mặc định mở thẳng home; user có thể tự navigate sau trong browser
      const result = await ipc.autoComment.debugOpenBrowserWithCookie({
        accountId: acc.id,
        startUrl: 'https://www.facebook.com/',
      });
      if (!result.success) setError(result.error || 'Lỗi mở browser');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleCloseBrowser = async () => {
    try {
      await ipc.autoComment.debugCloseBrowser();
    } catch (err: any) {
      setError(err.message);
    }
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

  const commentCount = formComments.split('\n').filter(c => c.trim()).length;

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
              </div>
              <p className="text-sm text-[#64748B] mb-4">Mỗi dòng tương ứng một mẫu bình luận.</p>
              <textarea
                className="w-full px-4 py-3 rounded-lg border border-[#E2E8F0] bg-white text-[#0F172A] text-sm font-mono leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all"
                style={{ minHeight: '160px' }}
                placeholder="Shopee mình nè: https://shopee.vn/...
Nhóm chuyên săn sale: https://zalo.me/g/..."
                value={formComments}
                onChange={(e) => setFormComments(e.target.value)}
              />
              <p className="text-sm text-[#64748B] mt-3">{commentCount} mẫu bình luận</p>
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
  return (
    <div className="h-full overflow-y-auto bg-[#F8FAFC]">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-8 pb-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-[#0F172A]">Auto Comment Facebook</h1>
            <p className="text-[#64748B] mt-1">Tự động bình luận vào các bài viết trong nhóm</p>
          </div>
          <div className="flex items-center gap-2">
            {/* ponytail: Debug buttons - remove after capturing doc_ids */}
            <button
              onClick={handleOpenBrowser}
              className="h-11 px-4 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 transition-colors"
              title="Mở Chromium với cookie đã lưu, xem DevTools"
            >
              🐞 Mở Browser
            </button>
            <button
              onClick={handleCloseBrowser}
              className="h-11 px-3 rounded-lg border border-slate-300 bg-white text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
              title="Đóng browser debug"
            >
              ✕
            </button>
            <button
              onClick={handleDebugDumpCookie}
              className="h-11 px-3 rounded-lg border border-slate-300 bg-white text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
              title="Dump cookie ra file"
            >
              📋
            </button>
            <button
              onClick={handleNewConfig}
              className="h-11 px-5 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors flex items-center gap-2"
            >
              <IconPlus />
              <span>Tạo mới</span>
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
              <IconX />
            </button>
          </div>
        )}

        {/* Scheduler Status */}
        {status && (
          <div className="mb-6 bg-white rounded-xl border border-[#E2E8F0] p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full ${status.enabled ? 'bg-green-500 animate-pulse' : 'bg-[#94A3B8]'}`} />
                <h3 className="text-sm font-semibold text-[#0F172A]">
                  Worker {status.enabled ? 'đang chạy' : 'đã dừng'}
                </h3>
              </div>
              <span className="text-xs text-[#94A3B8]">Tổng tick: {status.totalRuns}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-xs text-[#94A3B8] mb-1">Lần chạy cuối</p>
                <p className="font-medium text-[#0F172A]">
                  {status.minutesSinceLastRun < 0
                    ? '—'
                    : status.minutesSinceLastRun === 0
                      ? 'Vừa xong'
                      : `${status.minutesSinceLastRun} phút trước`}
                </p>
                {status.lastRunSummary && (
                  <p className="text-xs text-[#64748B] mt-0.5 truncate" title={status.lastRunSummary}>
                    {status.lastRunSummary}
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs text-[#94A3B8] mb-1">Lần chạy tới</p>
                <p className="font-medium text-[#0F172A]">
                  {status.minutesToNextRun < 0 ? '—' : `~${status.minutesToNextRun} phút nữa`}
                </p>
              </div>
              <div className="col-span-2 md:col-span-1 flex items-end gap-2">
                <button
                  onClick={async () => {
                    const r = await ipc.autoComment.startWorker();
                    if (r.success) {
                      const s = await ipc.autoComment.getStatus();
                      if (s.success && s.status) setStatus(s.status);
                    }
                  }}
                  className="flex-1 h-9 px-3 rounded-lg bg-[#EFF6FF] text-[#2563EB] text-xs font-medium hover:bg-[#DBEAFE] transition-colors"
                >
                  Start
                </button>
                <button
                  onClick={async () => {
                    const r = await ipc.autoComment.stopWorker();
                    if (r.success) {
                      const s = await ipc.autoComment.getStatus();
                      if (s.success && s.status) setStatus(s.status);
                    }
                  }}
                  className="flex-1 h-9 px-3 rounded-lg bg-[#F1F5F9] text-[#64748B] text-xs font-medium hover:bg-[#E2E8F0] transition-colors"
                >
                  Stop
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-[#E2E8F0] border-t-[#2563EB] rounded-full animate-spin" />
          </div>
        )}

        {/* Empty State */}
        {!loading && configs.length === 0 && (
          <div className="bg-white rounded-xl border border-[#E2E8F0] p-16 text-center">
            <div className="w-16 h-16 rounded-full bg-[#F8FAFC] flex items-center justify-center mx-auto mb-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <h3 className="text-lg font-medium text-[#0F172A] mb-2">Chưa có cấu hình nào</h3>
            <p className="text-sm text-[#64748B] mb-6">Tạo cấu hình đầu tiên để bắt đầu auto comment.</p>
            <button
              onClick={handleNewConfig}
              className="h-11 px-6 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors"
            >
              Tạo Auto Comment
            </button>
          </div>
        )}

        {/* Config List */}
        {!loading && configs.length > 0 && (
          <div className="space-y-4">
            {configs.map(config => {
              const account = fbAccounts.find(a => a.id === config.account_id);
              return (
                <div key={config.id} className="bg-white rounded-xl border border-[#E2E8F0] p-6 hover:border-[#CBD5E1] transition-colors">
                  <div className="flex flex-col md:flex-row md:items-start gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-4">
                        <h3 className="text-lg font-medium text-[#0F172A]">{account?.name || config.account_id}</h3>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${config.enabled ? 'bg-green-100 text-green-700' : 'bg-[#F1F5F9] text-[#64748B]'}`}>
                          {config.enabled ? 'Đang bật' : 'Tắt'}
                        </span>
                        {config.doc_id_create_comment && (
                          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700" title={config.doc_id_create_comment}>
                            Custom doc_id
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-4">
                        <div>
                          <p className="text-[#94A3B8]">Bình luận</p>
                          <p className="font-medium text-[#0F172A]">{config.comments.length} mẫu</p>
                        </div>
                        <div>
                          <p className="text-[#94A3B8]">Nhóm</p>
                          <p className="font-medium text-[#0F172A]">{config.group_ids.length} nhóm</p>
                        </div>
                        <div>
                          <p className="text-[#94A3B8]">Bài/lần</p>
                          <p className="font-medium text-[#0F172A]">{config.max_posts_per_run}</p>
                        </div>
                        <div>
                          <p className="text-[#94A3B8]">Chu kỳ</p>
                          <p className="font-medium text-[#0F172A]">{config.schedule_minutes} phút</p>
                        </div>
                      </div>
                      <div className="p-3 bg-[#F8FAFC] rounded-lg">
                        <p className="text-xs text-[#94A3B8] mb-2">Preview:</p>
                        <div className="space-y-1">
                          {config.comments.slice(0, 3).map((c, i) => (
                            <p key={i} className="text-sm text-[#64748B] truncate">{i + 1}. {c}</p>
                          ))}
                          {config.comments.length > 3 && (
                            <p className="text-xs text-[#94A3B8]">+{config.comments.length - 3} mẫu khác...</p>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex md:flex-col gap-2 md:min-w-[120px]">
                      <button
                        onClick={() => handleRunNow(config.id)}
                        className="h-9 px-4 rounded-lg bg-[#2563EB] text-white text-sm font-medium hover:bg-[#1D4ED8] transition-colors"
                        disabled={loading}
                      >
                        Chạy ngay
                      </button>
                      <button
                        onClick={() => handleEditConfig(config)}
                        className="h-9 px-4 rounded-lg border border-[#E2E8F0] text-[#64748B] text-sm hover:bg-[#F8FAFC] transition-colors"
                      >
                        Sửa
                      </button>
                      <button
                        onClick={() => handleViewLogs(config.id)}
                        className="h-9 px-4 rounded-lg border border-[#E2E8F0] text-[#64748B] text-sm hover:bg-[#F8FAFC] transition-colors"
                      >
                        Logs
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
                </div>
              );
            })}
          </div>
        )}

        {/* Logs Modal */}
        {showLogs && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
            <div className="bg-white rounded-xl w-full max-w-4xl max-h-[80vh] overflow-hidden">
              <div className="p-6 border-b border-[#E2E8F0]">
                <h3 className="text-lg font-semibold text-[#0F172A]">Lịch sử Auto Comment</h3>
              </div>
              <div className="overflow-auto max-h-[60vh]">
                <table className="w-full">
                  <thead className="bg-[#F8FAFC] sticky top-0">
                    <tr>
                      <th className="text-left text-xs font-medium text-[#64748B] uppercase tracking-wide px-6 py-3">Thời gian</th>
                      <th className="text-left text-xs font-medium text-[#64748B] uppercase tracking-wide px-6 py-3">Nhóm</th>
                      <th className="text-left text-xs font-medium text-[#64748B] uppercase tracking-wide px-6 py-3">Comments</th>
                      <th className="text-left text-xs font-medium text-[#64748B] uppercase tracking-wide px-6 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E2E8F0]">
                    {logs.map(log => (
                      <tr key={log.id} className={log.status === 'failed' ? 'bg-red-50' : ''}>
                        <td className="px-6 py-4 text-sm text-[#0F172A] whitespace-nowrap">{new Date(log.executed_at).toLocaleString('vi-VN')}</td>
                        <td className="px-6 py-4 text-sm text-[#0F172A]">{log.group_name}</td>
                        <td className="px-6 py-4">
                          <div className="space-y-1 max-w-[300px]">
                            {log.comments.map((c, i) => (
                              <p key={i} className="text-xs text-[#64748B] truncate">{i + 1}. {c}</p>
                            ))}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${log.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {log.status === 'success' ? 'Thành công' : 'Thất bại'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {logs.length === 0 && (
                  <div className="text-center py-12 text-[#64748B]">Chưa có lịch sử nào.</div>
                )}
              </div>
              <div className="p-6 border-t border-[#E2E8F0] flex justify-end">
                <button
                  onClick={() => setShowLogs(false)}
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
