#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { remote } = require('webdriverio');
const {
  loadConfig,
  parseCliArgs,
  validateInput,
  selectorCandidates,
  detectBlockingScreen,
  isExpectedPackage,
  isIdentitySelectionConfirmed,
  isSubmissionConfirmed,
} = require('./fb-android-comment-lib');

const ENV_FILE = path.join(__dirname, '.env.fb-android');
const HELP = `Facebook Android nickname comment prototype

Setup:
  1. Install Android Studio/SDK and start an AVD with Google Play.
  2. Install Facebook from Play Store and sign in manually once.
  3. Run: npm run fb:android:driver
  4. Terminal 1: npm run fb:android:server
  5. Copy scripts/.env.fb-android.example to scripts/.env.fb-android and set device values.
  6. Terminal 2:
     npm run fb:android:comment -- "<group-post-url>" "<nickname>" "<comment>"

Dry-run is default. It fills the composer but does not press Post.
Set SUBMIT=true only after checking the dry-run screenshot.
The script stops on login, checkpoint, captcha, or security screens; it does not bypass them.
Facebook UI updates may require selector adjustment using the saved page XML.
`;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function findFirst(driver, selectors, timeoutMs, role) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const element = await driver.$(selector);
        if (await element.isExisting() && await element.isDisplayed() && await element.isEnabled()) return element;
      } catch (error) { lastError = error; }
    }
    await driver.pause(500);
  }
  throw new Error(`Could not find ${role}${lastError ? `: ${lastError.message}` : ''}`);
}

async function assertNotBlocked(driver) {
  const source = await driver.getPageSource();
  if (detectBlockingScreen(source)) throw new Error('Facebook requires login/security verification; complete it manually');
}

async function saveArtifacts(driver, dir, suffix, includeXml) {
  const saved = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${timestamp()}-${suffix}`);
    await driver.saveScreenshot(`${base}.png`);
    saved.push(`${base}.png`);
    if (includeXml) {
      fs.writeFileSync(`${base}-page.xml`, await driver.getPageSource());
      saved.push(`${base}-page.xml`);
    }
  } catch {}
  return saved;
}

async function elementExists(driver, selectors) {
  for (const selector of selectors) {
    try {
      const element = await driver.$(selector);
      if (await element.isExisting() && await element.isDisplayed()) return true;
    } catch {}
  }
  return false;
}

async function waitFor(driver, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await driver.pause(500);
  }
  return false;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  let driver;
  let config;
  try {
    if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
    config = loadConfig(process.env);
    const input = validateInput(parseCliArgs(process.argv.slice(2)));
    console.log(`Connecting to ${config.deviceName} (${config.appPackage})`);
    driver = await remote({
      hostname: config.host,
      port: config.port,
      logLevel: 'error',
      capabilities: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:deviceName': config.deviceName,
        ...(config.platformVersion ? { 'appium:platformVersion': config.platformVersion } : {}),
        'appium:appPackage': config.appPackage,
        'appium:appActivity': config.appActivity,
        'appium:noReset': true,
        'appium:newCommandTimeout': 120,
      },
    });

    if (!await driver.isAppInstalled(config.appPackage)) throw new Error(`Facebook app is not installed: ${config.appPackage}`);
    await driver.execute('mobile: deepLink', { url: input.url, package: config.appPackage });
    await driver.pause(3000);
    if (!isExpectedPackage(await driver.getCurrentPackage(), config.appPackage)) {
      throw new Error('Deep link did not open the Facebook app');
    }
    await assertNotBlocked(driver);

    const commentButton = await findFirst(driver, selectorCandidates('commentButton', config.locale), config.timeoutMs, 'comment button');
    await commentButton.click();
    await assertNotBlocked(driver);

    const identityButton = await findFirst(driver, selectorCandidates('identityButton', config.locale), config.timeoutMs, 'identity selector');
    await identityButton.click();
    await assertNotBlocked(driver);
    const nicknameSelectors = selectorCandidates('nickname', config.locale, input.nickname);
    const nickname = await findFirst(driver, nicknameSelectors, config.timeoutMs, 'requested nickname');
    await nickname.click();
    await assertNotBlocked(driver);
    const reopenIdentityButton = await findFirst(driver, selectorCandidates('identityButton', config.locale), config.timeoutMs, 'identity selector');
    await reopenIdentityButton.click();
    const selectedNickname = selectorCandidates('selectedNickname', config.locale, input.nickname);
    if (!isIdentitySelectionConfirmed(await elementExists(driver, selectedNickname))) {
      throw new Error('Could not confirm requested nickname selection');
    }
    const closeIdentityButton = await findFirst(driver, selectorCandidates('identityButton', config.locale), config.timeoutMs, 'identity selector');
    await closeIdentityButton.click();

    const fieldSelectors = selectorCandidates('commentField', config.locale);
    const field = await findFirst(driver, fieldSelectors, config.timeoutMs, 'comment field');
    await field.clearValue();
    await field.setValue(input.comment);
    const text = await field.getText();
    const value = await field.getValue().catch(() => '');
    if (String(text || value) !== input.comment) throw new Error('Comment field did not retain the exact requested text');

    if (!config.submit) {
      const artifacts = await saveArtifacts(driver, config.artifactDir, 'dry-run', false);
      if (!artifacts.length) throw new Error('Dry-run screenshot could not be saved');
      await field.clearValue();
      console.log(`DRY RUN: comment not posted. Screenshot: ${artifacts[0]}`);
      return;
    }

    const postButton = await findFirst(driver, selectorCandidates('postButton', config.locale), config.timeoutMs, 'post button');
    if (!await postButton.isEnabled()) throw new Error('Post button is disabled');
    await postButton.click();
    const postedCommentSelectors = selectorCandidates('nickname', config.locale, input.comment);
    const confirmed = await waitFor(driver, async () => isSubmissionConfirmed({
      commentFieldExists: await elementExists(driver, fieldSelectors),
      postedCommentVisible: await elementExists(driver, postedCommentSelectors),
    }), config.timeoutMs);
    if (!confirmed) throw new Error('Submission was not confirmed; do not rerun until checking Facebook manually');
    const artifacts = await saveArtifacts(driver, config.artifactDir, 'final', false);
    if (!artifacts.length) throw new Error('Submission completed but final screenshot could not be saved');
    console.log(`Submitted once and composer closed. Screenshot: ${artifacts[0]}`);
  } catch (error) {
    const artifacts = driver && config ? await saveArtifacts(driver, config.artifactDir, 'error', true) : [];
    console.error(`${error.message}${artifacts.length ? `\nArtifacts: ${artifacts.join(', ')}` : ''}`);
    process.exitCode = 1;
  } finally {
    if (driver) await driver.deleteSession().catch(() => {});
  }
}

main();
