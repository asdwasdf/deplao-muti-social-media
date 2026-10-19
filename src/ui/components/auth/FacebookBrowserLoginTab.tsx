/**
 * FacebookBrowserLoginTab.tsx
 * Tab đăng nhập FB bằng Chromium thật (Playwright). Mở trình duyệt, user gõ
 * username/password như bình thường, app tự detect cookie và lưu account.
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { useAccountStore } from '../../store/accountStore';
import type { BrowserLoginIpcEvent } from '../../lib/ipc';

interface Props {
  onSuccess: () => void;
  proxyId?: number | null;
  onProxyChange?: (id: number | null) => void;
}

const STATUS_TEXT: Record<BrowserLoginIpcEvent['kind'], string> = {
  opening: 'Đang mở trình duyệt...',
  navigating: 'Đang tải trang đăng nhập Facebook...',
  waitingUser: 'Đang chờ bạn đăng nhập trong cửa sổ trình duyệt.',
  captchaDetected: 'Phát hiện captcha. Vui lòng giải captcha trong trình duyệt.',
  twofaRequired: 'Yêu cầu xác thực 2 bước. Vui lòng nhập mã trong trình duyệt.',
  verifying: 'Đang xác thực cookie...',
  success: 'Đăng nhập thành công!',
  error: '',
  cancelled: 'Đã huỷ đăng nhập.',
};

export default function FacebookBrowserLoginTab({ onSuccess, proxyId, onProxyChange }: Props) {
  const [headless, setHeadless] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<BrowserLoginIpcEvent['kind'] | 'idle'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string | null>(null);
  const { showNotification } = useAppStore();
  const { setAccounts } = useAccountStore();

  // Subscribe event từ main process
  useEffect(() => {
    if (!window.electronAPI?.fb?.onBrowserLoginEvent) return;
    const off = window.electronAPI.fb.onBrowserLoginEvent(({ sessionId: sid, event }) => {
      if (sessionRef.current && sid !== sessionRef.current) return; // event của session khác
      setStatusKind(event.kind);
      if (event.kind === 'error') setErrorMsg(event.message);
      if (event.kind === 'success') {
        // Gọi addAccount để xác thực và lưu cookie vào DB
        (async () => {
          try {
            const addRes = await window.electronAPI.fb.addAccount({
              cookie: event.cookie,
              proxyId: proxyId ?? null,
            });
            if (!addRes?.success) {
              showNotification(`Lưu tài khoản thất bại: ${addRes?.error}`, 'error');
              setBusy(false);
              return;
            }
            showNotification(`Đăng nhập thành công: ${addRes.name || addRes.facebookId}`, 'success');
            // Lấy danh sách account rồi đóng modal
            const res = await window.electronAPI.fb.getAccounts();
            if (res?.success && res.accounts) setAccounts(res.accounts);
            onSuccess();
          } catch (err: any) {
            showNotification(`Lỗi: ${err?.message || 'Không rõ'}`, 'error');
            setBusy(false);
          }
        })();
      }
      if (event.kind === 'cancelled' || event.kind === 'error') {
        setBusy(false);
        sessionRef.current = null;
        setSessionId(null);
      }
    });
    return off;
  }, [onSuccess, setAccounts, showNotification]);

  const start = async () => {
    if (busy) return;
    setErrorMsg('');
    setBusy(true);
    setStatusKind('opening');
    try {
      const res = await window.electronAPI.fb.startBrowserLogin({ proxyId, headless });
      if (!res?.success || !res.sessionId) {
        setErrorMsg(res?.error || 'Không thể khởi động trình duyệt.');
        setBusy(false);
        setStatusKind('idle');
        return;
      }
      sessionRef.current = res.sessionId;
      setSessionId(res.sessionId);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Lỗi không xác định.');
      setBusy(false);
      setStatusKind('idle');
    }
  };

  const cancel = async () => {
    if (!sessionRef.current) return;
    try {
      await window.electronAPI.fb.cancelBrowserLogin({ sessionId: sessionRef.current });
    } catch {}
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm text-blue-200">
        <p className="font-medium mb-1">Đăng nhập bằng trình duyệt thật</p>
        <p className="text-xs text-blue-300/80">
          Mở Chromium ngay trong ứng dụng, bạn đăng nhập FB như bình thường (kể cả 2FA, captcha). Khi xong app tự lưu tài khoản.
        </p>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
          <input
            type="checkbox"
            checked={headless}
            onChange={(e) => setHeadless(e.target.checked)}
            disabled={busy}
            className="rounded"
          />
          <span>Chạy ẩn (headless) — không hiện cửa sổ trình duyệt</span>
        </label>
        <p className="text-xs text-gray-400 mt-1 ml-6">
          Bật khi cần đăng nhập nhiều account liên tục. Khuyến nghị tắt để xử lý captcha / 2FA.
        </p>
      </div>

      {!busy ? (
        <button
          onClick={start}
          className="w-full py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-medium transition"
        >
          Mở trình duyệt đăng nhập
        </button>
      ) : (
        <div className="space-y-2">
          <div className="rounded-md border border-gray-600 bg-gray-800/60 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
              <span className="text-gray-200">{STATUS_TEXT[statusKind as BrowserLoginIpcEvent['kind']] || 'Đang xử lý...'}</span>
            </div>
            {errorMsg && statusKind === 'error' && (
              <p className="text-xs text-red-400 mt-2 break-words">{errorMsg}</p>
            )}
          </div>
          <button
            onClick={cancel}
            className="w-full py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-white text-sm transition"
          >
            Huỷ đăng nhập
          </button>
        </div>
      )}

      {errorMsg && statusKind !== 'error' && (
        <p className="text-xs text-red-400 break-words">{errorMsg}</p>
      )}
    </div>
  );
}
