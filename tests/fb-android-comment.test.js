const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadConfig,
  parseGroupPostUrl,
  validateInput,
  selectorCandidates,
  detectBlockingScreen,
  isExpectedPackage,
  isSubmissionConfirmed,
  isIdentitySelectionConfirmed,
  parseCliArgs,
} = require('../scripts/fb-android-comment-lib');

const validEnv = {
  ANDROID_DEVICE_NAME: 'emulator-5554',
  FB_APP_PACKAGE: 'com.facebook.katana',
  FB_APP_ACTIVITY: 'com.facebook.katana.activity.FbMainTabActivity',
};

test('accepts Facebook group posts and permalink URLs', () => {
  assert.deepEqual(parseGroupPostUrl('https://www.facebook.com/groups/123/posts/456/?x=1'), {
    url: 'https://www.facebook.com/groups/123/posts/456/', groupId: '123', postId: '456',
  });
  assert.equal(parseGroupPostUrl('https://m.facebook.com/groups/123/permalink/789').postId, '789');
});

test('rejects deceptive domains and non-group URLs', () => {
  assert.throws(() => parseGroupPostUrl('https://facebook.com.evil/groups/1/posts/2'), /Facebook group post URL/);
  assert.throws(() => parseGroupPostUrl('https://facebook.com/user/posts/2'), /Facebook group post URL/);
  assert.throws(() => parseGroupPostUrl('http://facebook.com/groups/1/posts/2'), /Facebook group post URL/);
});

test('only exact true enables submit', () => {
  assert.equal(loadConfig({ ...validEnv, SUBMIT: 'true' }).submit, true);
  for (const value of [undefined, 'TRUE', '1', 'yes', 'false']) {
    assert.equal(loadConfig({ ...validEnv, SUBMIT: value }).submit, false);
  }
});

test('validates required config and numeric ranges', () => {
  assert.throws(() => loadConfig({}), /ANDROID_DEVICE_NAME/);
  assert.throws(() => loadConfig({ ...validEnv, APPIUM_PORT: 'nope' }), /APPIUM_PORT/);
  assert.throws(() => loadConfig({ ...validEnv, APPIUM_PORT: '65536' }), /APPIUM_PORT/);
  assert.throws(() => loadConfig({ ...validEnv, TIMEOUT_MS: '500' }), /TIMEOUT_MS/);
});

test('requires exactly three quoted CLI values', () => {
  assert.deepEqual(parseCliArgs(['url', 'Alias', 'Comment']), { url: 'url', nickname: 'Alias', comment: 'Comment' });
  assert.throws(() => parseCliArgs(['url', 'My', 'Alias', 'Comment']), /exactly three/);
  assert.throws(() => parseCliArgs(['url', 'Alias']), /exactly three/);
});

test('validates nickname and comment boundaries', () => {
  const url = 'https://facebook.com/groups/1/posts/2';
  assert.throws(() => validateInput({ url, nickname: '', comment: 'ok' }), /nickname/i);
  assert.throws(() => validateInput({ url, nickname: 'Alias', comment: ' ' }), /comment/i);
  assert.throws(() => validateInput({ url, nickname: 'Alias', comment: 'x'.repeat(8001) }), /8000/);
  assert.equal(validateInput({ url, nickname: 'Alias', comment: 'Xin chào' }).comment, 'Xin chào');
});

test('uses exact injection-safe selectors for nickname and post button', () => {
  const selectors = selectorCandidates('nickname', 'vi', `A\\\"'); textContains('Victim`);
  assert.ok(selectors.every((value) => value.startsWith('//')));
  assert.ok(selectors.every((value) => !value.includes('new UiSelector')));
  assert.ok(selectorCandidates('postButton', 'vi').every((value) => !value.includes('textContains')));
});

test('uses valid XPath selectors with locale fallback for non-destructive controls', () => {
  const selectors = selectorCandidates('commentButton', 'vi');
  assert.ok(selectors.every((value) => value.startsWith('//')));
  assert.ok(selectors.some((value) => value.includes('Comment')));
});

test('detects blocking screens in Vietnamese and English', () => {
  for (const source of ['Kiểm tra bảo mật', 'Security check', 'Enter your password', 'captcha', 'checkpoint', 'Log in to Facebook', 'Đăng nhập Facebook']) {
    assert.equal(detectBlockingScreen(source), true, source);
  }
  assert.equal(detectBlockingScreen('Bình luận · Chia sẻ'), false);
});

test('requires Facebook package after deep link', () => {
  assert.equal(isExpectedPackage('com.facebook.katana', 'com.facebook.katana'), true);
  assert.equal(isExpectedPackage('com.android.chrome', 'com.facebook.katana'), false);
});

test('builds exact selected-state selector for nickname confirmation', () => {
  const [selector] = selectorCandidates('selectedNickname', 'vi', 'Alias');
  assert.match(selector, /@checked='true' or @selected='true'/);
  assert.match(selector, /@text='Alias' or @content-desc='Alias'/);
});

test('confirms identity selection only from selected nickname state', () => {
  assert.equal(isIdentitySelectionConfirmed(true), true);
  assert.equal(isIdentitySelectionConfirmed(false), false);
});

test('confirms submission only after composer closes and exact comment appears', () => {
  assert.equal(isSubmissionConfirmed({ commentFieldExists: false, postedCommentVisible: true }), true);
  assert.equal(isSubmissionConfirmed({ commentFieldExists: true, postedCommentVisible: true }), false);
  assert.equal(isSubmissionConfirmed({ commentFieldExists: false, postedCommentVisible: false }), false);
});
