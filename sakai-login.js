const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const userDataDir = path.join(__dirname, '.browser-profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1440, height: 960 },
  });

  const page = context.pages()[0] || await context.newPage();
  const sakaiUrl = process.env.SAKAI_URL || 'https://your-sakai.example.edu/portal';
  await page.goto(sakaiUrl, { waitUntil: 'domcontentloaded' });

  console.log('\nLogin window opened.');
  console.log('Please complete your Sakai / SSO sign-in in the browser.');
  console.log('When you can see your Sakai home page, come back here and press Enter.\n');

  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', async () => {
    await context.storageState({ path: path.join(__dirname, 'storage-state.json') });
    console.log('Saved browser session to sakai-sync/storage-state.json');
    console.log('Browser profile also saved in sakai-sync/.browser-profile');
    await context.close();
    process.exit(0);
  });
})();
