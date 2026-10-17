const path = require('node:path');

const FACEBOOK_HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com']);
const TEXT = {
  commentButton: { vi: ['Bình luận'], en: ['Comment'] },
  identityButton: { vi: ['Chọn trang cá nhân', 'Chọn hồ sơ'], en: ['Choose profile', 'Choose identity'] },
  commentField: { vi: ['Viết bình luận…', 'Viết bình luận...'], en: ['Write a comment…', 'Write a comment...'] },
  postButton: { vi: ['Đăng'], en: ['Post'] },
};

function positiveInteger(value, fallback, name, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function loadConfig(env = process.env) {
  const required = ['ANDROID_DEVICE_NAME', 'FB_APP_PACKAGE', 'FB_APP_ACTIVITY'];
  for (const name of required) if (!env[name]?.trim()) throw new Error(`${name} is required`);

  const locale = env.LOCALE || 'vi';
  if (!['vi', 'en'].includes(locale)) throw new Error('LOCALE must be vi or en');

  return {
    host: env.APPIUM_HOST || '127.0.0.1',
    port: positiveInteger(env.APPIUM_PORT, 4723, 'APPIUM_PORT', 1, 65535),
    deviceName: env.ANDROID_DEVICE_NAME.trim(),
    platformVersion: env.ANDROID_PLATFORM_VERSION?.trim() || undefined,
    appPackage: env.FB_APP_PACKAGE.trim(),
    appActivity: env.FB_APP_ACTIVITY.trim(),
    locale,
    timeoutMs: positiveInteger(env.TIMEOUT_MS, 30000, 'TIMEOUT_MS', 1000),
    submit: env.SUBMIT === 'true',
    artifactDir: path.resolve(env.ARTIFACT_DIR || 'tmp/fb-android-comment'),
  };
}

function parseGroupPostUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Expected an HTTPS Facebook group post URL'); }
  const match = parsed.pathname.match(/^\/groups\/(\d+)\/(?:posts|permalink)\/(\d+)\/?$/);
  if (parsed.protocol !== 'https:' || !FACEBOOK_HOSTS.has(parsed.hostname.toLowerCase()) || !match) {
    throw new Error('Expected an HTTPS Facebook group post URL');
  }
  parsed.search = '';
  parsed.hash = '';
  return { url: parsed.toString(), groupId: match[1], postId: match[2] };
}

function parseCliArgs(args) {
  if (args.length !== 3) throw new Error('Expected exactly three quoted values: URL, nickname, and comment');
  return { url: args[0], nickname: args[1], comment: args[2] };
}

function validateInput({ url, nickname, comment }) {
  const post = parseGroupPostUrl(url);
  if (!nickname?.trim()) throw new Error('Nickname is required');
  if (!comment?.trim()) throw new Error('Comment is required');
  if (comment.length > 8000) throw new Error('Comment must not exceed 8000 characters');
  return { ...post, nickname: nickname.trim(), comment };
}

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(", \"'\", ")})`;
}

function selectorsForText(value, exact = false) {
  const literal = xpathLiteral(value);
  if (exact) return [`//*[@text=${literal} or @content-desc=${literal}]`];
  return [
    `//*[@text=${literal} or @content-desc=${literal}]`,
    `//*[contains(@text, ${literal}) or contains(@content-desc, ${literal})]`,
  ];
}

function selectorCandidates(role, locale, nickname) {
  if (role === 'nickname' || role === 'selectedNickname') {
    if (!nickname?.trim()) throw new Error('Nickname selector requires a value');
    const [selector] = selectorsForText(nickname.trim(), true);
    if (role === 'selectedNickname') {
      return [`${selector}[ancestor-or-self::*[@checked='true' or @selected='true']]`];
    }
    return [selector];
  }
  if (!TEXT[role]) throw new Error(`Unknown selector role: ${role}`);
  const alternate = locale === 'vi' ? 'en' : 'vi';
  const exact = role === 'postButton';
  return [...TEXT[role][locale], ...TEXT[role][alternate]].flatMap((text) => selectorsForText(text, exact));
}

function detectBlockingScreen(pageSource = '') {
  const source = pageSource.toLocaleLowerCase('vi');
  return ['checkpoint', 'captcha', 'security check', 'kiểm tra bảo mật', 'enter your password', 'nhập mật khẩu', 'log in to facebook', 'đăng nhập facebook'].some((term) => source.includes(term));
}

function isExpectedPackage(currentPackage, expectedPackage) {
  return currentPackage === expectedPackage;
}

function isIdentitySelectionConfirmed(selectedNicknameExists) {
  return selectedNicknameExists === true;
}

function isSubmissionConfirmed({ commentFieldExists, postedCommentVisible }) {
  return commentFieldExists === false && postedCommentVisible === true;
}

module.exports = {
  loadConfig,
  parseGroupPostUrl,
  parseCliArgs,
  validateInput,
  selectorCandidates,
  detectBlockingScreen,
  isExpectedPackage,
  isIdentitySelectionConfirmed,
  isSubmissionConfirmed,
};
