# Camoufox — Facebook Browser Automation Stack (WIP)

> Trạng thái: **Đang làm dở (WIP)**. Chưa có code production nào được commit.
> Tài liệu này ghi lại kết quả khảo sát + thiết kế + trạng thái từng bước.

---

## 1. Mục tiêu

Tích hợp [Camoufox](https://github.com/daijro/camoufox) (Firefox anti-detect) vào Deplao
để thay thế/augment luồng Facebook browser-based hiện tại (đang dùng Playwright Chromium +
`--disable-blink-features=AutomationControlled` — cách này đã lộ, Facebook detect được).

**Yêu cầu tách biệt (từ user):** Facebook phải là **một luồng riêng**, không dính vào
luồng chung của Zalo/Telegram, không sửa đụng pipeline hiện tại.

---

## 2. Vì sao chọn Camoufox

| Tiêu chí | Chromium + stealth flags (hiện tại) | Camoufox |
|---|---|---|
| Lớp chống detect | JS injection (`navigator.webdriver = undefined`) | ~40 patch C++ ở tầng browser |
| `navigator.webdriver` | Cần hack thủ công | Mặc định không lộ |
| WebGL / Canvas / Audio | Giả lập JS, dễ bị phát hiện qua lỗi khớp | Spoof native, khớp cả phép đo thực |
| Protocol | CDP (binding thấy được trong page) | Juggler (Playwright protocol, isolated world) |
| UA | Giả `Chrome/140` cứng | Firefox 156 thật, coherent fingerprint |
| Human cursor | Không | Có (replay 2356 movement thật) |
| GeoIP (TZ/locale khớp IP) | Không | Có, tự map IP → timezone/locale/WebRTC |

Camoufox trả về **Playwright `Browser` chuẩn** → không phải viết lại logic page.

---

## 3. Kết quả khảo sát (đã verify chạy thật trên Windows)

### 3.1 Cài đặt & chạy (đã test OK)

```bash
npm install camoufox@0.5.8 playwright-core@1.62.1
npx camoufox fetch
```

`npx camoufox fetch` tải **1.31 GB** binary + 52.6 MB GeoIP + uBlock addon.
Sau khi fetch: tổng **2.8 GB** trong `%LOCALAPPDATA%\camoufox\`.

Cấu trúc cache:

```
%LOCALAPPDATA%\camoufox\camoufox\Cache\
├── browsers\official\156.0.1-beta.36-096fd483\
│   ├── camoufox.exe          (1.2 MB launcher)
│   ├── browser\omni.ja       (77 MB)
│   └── fonts\                (2.1 GB)  ← phần nặng nhất
├── geoip\                    (116 MB)
├── addons\                   (17 MB)
├── fpgen\
└── config.json
```

**Vấn đề đóng gói:** `fonts/` = 2.1 GB. Không thể ship trong Electron installer
(hiện tại đã có Chromium ~150MB). → phải **download-on-demand lúc runtime**, không bundle.

### 3.2 Fingerprint verification (đã test)

```js
const browser = await Camoufox({ headless: true, humanize: true });
const ctx = await NewContext(browser, { os: "windows", locale: "vi-VN" });
```

Kết quả thực tế trên máy dev:

```json
{
  "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0",
  "webdriver": false,
  "uaData": null,
  "tz": "Asia/Ho_Chi_Minh",
  "lang": "vi-VN"
}
```

→ `navigator.webdriver` = `false` (không cần hack), UA là Firefox thật,
timezone tự khớp `Asia/Ho_Chi_Minh` (theo geoip IP hiện tại).

### 3.3 Hai chế độ launch — cả hai đã verify

**A. In-process** (đơn giản, dùng cho 1 task):

```js
import { Camoufox, NewContext } from "camoufox";
const browser = await Camoufox({ headless: true });
const ctx = await NewContext(browser, { os: "windows" });
```

**B. Server mode** (phù hợp service dài hạn — 1 browser, nhiều context):

```js
import { launchServer } from "camoufox";
import { firefox } from "playwright-core";
const server = await launchServer({ headless: true });
const browser = await firefox.connect(server.wsEndpoint());
```

→ `ws://[::1]:62639/...`. Đã verify: `firefox.connect()` → `page.goto()` → `page.title()` OK.

**Lưu ý:** `launchServer` **không** hỗ trợ persistent context (đã đọc source
`dist/server.js:37` — chủ động throw). Muốn persistent thì phải dùng in-process mode.

### 3.4 Persistent context - **HOAT DONG (sau khi sua path)**

Lan test dau dung POSIX path `/tmp/camo-udd-test` -> **FAIL**:

```
Error: argument --profile requires a path
```

Lenh launch sinh ra: `camoufox.exe -no-remote -headless -profile /tmp/camo-udd-test ...`

Nguyen nhan: tren **Windows** path phai la Windows path that.
Test lai voi Windows path that -> **PASS**:

```
TITLE: Example Domain
OK persistent, udd exists: true
```

=> Dung duoc persistent profile dir tren Windows. Van nen dung `storageState()`
(da verify) cho phan luu cookie gon - profile dir de giu localStorage/IndexedDB.

### 3.5 Ràng buộc phiên bản (quan trọng)

```
camoufox@0.5.8  →  peerDependencies: { "playwright-core": "<1.63" }
repo hiện tại   →  playwright 1.64.0 → playwright-core 1.64.0
```

→ **Xung đột phiên bản.** Không thể dùng `playwright-core` của repo.
Phải cài **nested vendor** riêng. Đã verify hoạt động:

```
vendor/
├── package.json  { "dependencies": { "camoufox": "0.5.8", "playwright-core": "1.62.1" } }
└── node_modules/  (26 packages, ~7s install)
```

Cài trong `vendor/` riêng → **không đụng** `playwright` của app, không đụng
`playwright-browsers/` đang bundle.

---

## 4. Kiến trúc đề xuất — Facebook là một luồng RIÊNG

Ràng buộc từ user: *"tách biệt ra nhé đừng để nó dính luồng với nhau để facebook ra 1 luồng riêng luôn"*.

### 4.1 Nguyên tắc

| Không được | Được |
|---|---|
| Sửa `BrowserLoginService` / `BrowserDebugService` hiện có | Tạo service mới, cạnh tranh song song |
| Thêm nhánh `if (channel === 'facebook')` vào code chung | Không chạm file chung |
| Dùng lại `playwright-browsers/` (Chromium) | `camoufox` dùng Firefox riêng |
| Đụng `fb_accounts` schema cũ | Bảng riêng, tiền tố `fbc_` |
| Sửa `EventBroadcaster` | Broadcast qua kênh riêng `fbc:*` |

### 4.2 Cây thư mục đề xuất

```
vendor/
└── camoufox/                    ← package.json riêng, playwright-core 1.62.1
    └── node_modules/

src/services/facebook/browser/   ← slice MỚI, hoàn toàn độc lập
├── CamoufoxRuntime.ts            ← quản lý browser server + context pool
├── CamoufoxLauncher.ts           ← build launch options từ config
├── CamoufoxProfileStore.ts       ← lưu/đọc storageState per account
├── CamoufoxBrowserPath.ts        ← resolve binary path (dev/prod)
├── tasks/
│   ├── LoginTask.ts
│   ├── PostTask.ts
│   └── ScanTask.ts
└── types.ts

src/services/database/             ← migration thêm bảng mới, KHÔNG sửa bảng cũ
└── FacebookCamoufoxSchema.ts
```

### 4.3 Bảng DB mới (tách riêng)

```sql
-- Profile browser riêng cho luồng camoufox
CREATE TABLE IF NOT EXISTS fbc_profiles (
  id                TEXT PRIMARY KEY,
  fb_account_id     TEXT,             -- tham chiếu logic, KHÔNG FK cứng
  storage_state     TEXT NOT NULL,    -- JSON, encrypt qua safeStorage
  fingerprint_seed  TEXT,             -- seed tái tạo cùng identity
  os                TEXT DEFAULT 'windows',
  locale            TEXT DEFAULT 'vi-VN',
  proxy_id          INTEGER,
  last_used_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Log từng lần chạy task (audit + debug)
CREATE TABLE IF NOT EXISTS fbc_runs (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL,
  task          TEXT NOT NULL,        -- 'login' | 'post' | 'scan'
  status        TEXT NOT NULL,        -- 'ok' | 'error' | 'checkpoint'
  detail        TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
```

`fbc_checkpoint` — nếu Facebook bắt checkpoint (2FA, verify device, captcha) →
ghi vào `fbc_runs.status='checkpoint'` + UI hiện prompt user can thiệp.

### 4.4 IPC riêng (channel namespace mới)

File mới: `electron/ipc/facebookCamoufoxIpc.ts`
Namespace: `fbc:` (không dùng `fb:`)

```
fbc:runtimeStatus     → camoufox đã cài chưa, version binary
fbc:installBrowser    → tải binary (2.8GB) + progress
fbc:openProfile       → mở browser để user login thủ công
fbc:closeProfile
fbc:listProfiles
fbc:runTask           → chạy 1 task (post/scan/...)
fbc:getRuns           → log
```

### 4.5 Định vị trong các layer hiện có

| Layer | Vị trí | Loại |
|---|---|---|
| Service | `src/services/facebook/browser/*` | **mới, riêng** |
| DB | `src/services/database/FacebookCamoufoxSchema.ts` | **mới, riêng** |
| IPC | `electron/ipc/facebookCamoufoxIpc.ts` | **mới, riêng** |
| Preload | `electron/preload.ts` → `fbc: {...}` | thêm 1 block mới |
| Renderer types | `src/ui/lib/ipc.ts` | thêm 1 block mới |
| Renderer UI | `src/ui/features/facebook/camoufox/*` | **mới, riêng** |
| REST (boss→employee) | `src/services/http/handlers/facebookCamoufoxHandler.ts` | **mới, riêng** |

→ **Không sửa** `facebookIpc.ts`, `BrowserLoginService.ts`, `BrowserDebugService.ts`,
`EventBroadcaster.ts`, `channelConfig.ts`.

---

## 5. Tính năng camoufox mở khóa (so với Chromium hiện tại)

Từ README Camoufox, các option khả dụng:

| Option | Ý nghĩa |
|---|---|
| `headless: true \| false \| "virtual" \| "virtual-gpu"` | `virtual` = có display ảo, headless nhưng render thật |
| `os` | `"windows" \| "macos" \| "linux"` — chọn identity |
| `screen` | range kích thước màn hình |
| `proxy` | http/socks5 (khớp với proxy trong DB hiện có) |
| `geoip: true` | tự suy ra timezone/locale/WebRTC từ IP proxy |
| `locale` | ghi đè locale (repo đang dùng `vi-VN`) |
| `canvasNoise` | thêm noise vào canvas (default `true` nếu OS ≠ host) |
| `fingerprintPreset` | dùng device thật đã ghi nhận thay vì fpgen |
| `humanize: boolean \| number` | humanized cursor, số = cap thời gian di chuyển (giây) |
| `mainWorldEval` | chạy `page.evaluate` trong page context thật |
| `addons` / `excludeAddons` | mặc định có uBlock; tắt bằng `excludeAddons: ["ublock-origin"]` |
| `blockImages` / `blockWebrtc` / `blockWebgl` | giảm footprint, tránh rò rỉ |

`NewContext(browser, { os })` → mỗi context một identity khác nhau
→ chạy nhiều account song song mà không trùng fingerprint.

---

## 6. Vấn đề còn mở

| # | Vấn đề | Trạng thái |
|---|---|---|
| 1 | ~~Persistent context fail trên Windows path~~ | **Đã resolve** — lỗi chỉ do POSIX path; Windows path thật chạy OK |
| 2 | 2.8 GB binary — không bundle được | Cần `fbc:installBrowser` tải runtime + progress UI |
| 3 | `playwright-core <1.63` conflict | Đã giải bằng `vendor/` nested install |
| 4 | Vendor dir phải được `npm ci` cài | Cần script riêng (`scripts/install-camoufox.js`) + CI update |
| 5 | Electron packaging: camoufox là ESM-only | `tsconfig.electron` là CommonJS → cần dynamic `import()` |
| 6 | Facebook checkpoint detection | Chưa có — cần heuristic (URL `/checkpoint/`, title match) |
| 7 | Prod binary path | `INSTALL_DIR` = `%LOCALAPPDATA%\camoufox\...` — cần copy vào `resources/` hoặc giữ nguyên localAppData |

---

## 7. Trạng thái checklist

- [x] Khảo sát repo: xác định seam tách luồng Facebook
- [x] Cài & test Camoufox thật trên Windows (launch OK, fingerprint OK)
- [x] Xác nhận 2 chế độ: in-process + server mode
- [x] Xác nhận `storageState()` hoạt động
- [x] Xác định xung đột phiên bản `playwright-core`
- [x] Test nested vendor install — OK
- [x] Viết tài liệu thiết kế
- [x] Verify persistent context với Windows path thật → **OK**
- [ ] Viết `vendor/camoufox/package.json` + script cài
- [ ] `src/services/facebook/browser/CamoufoxRuntime.ts`
- [ ] `src/services/facebook/browser/CamoufoxProfileStore.ts`
- [ ] Schema `fbc_profiles` / `fbc_runs`
- [ ] `electron/ipc/facebookCamoufoxIpc.ts` + preload + `src/ui/lib/ipc.ts`
- [ ] UI cài browser (progress) + quản lý profile
- [ ] Task đầu tiên: login bằng camoufox, lưu `storageState`
- [ ] CI: cài vendor deps

---

## 8. Ghi chú ToS

Camoufox là công cụ **chống bot-detection**. Dùng nó để tự động hoá hành vi trên Facebook
vi phạm Điều khoản Dịch vụ của Meta và có nguy cơ ban account vĩnh viễn.
Chỉ dùng cho tài khoản/nội dung thuộc sở hữu của chính bạn.
Với tài khoản doanh nghiệp → ưu tiên Meta Business Suite + Graph API (chính thức, miễn phí).
