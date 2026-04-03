const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const NOTION_KEY = fs.readFileSync(path.join(process.env.HOME, '.config/notion/api_key'), 'utf8').trim();
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || 'YOUR_NOTION_DATABASE_ID';
const NOTION_DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID || 'YOUR_NOTION_DATA_SOURCE_ID';
const SAKAI_URL = process.env.SAKAI_URL || 'https://your-sakai.example.edu/portal';
const STORAGE_STATE = path.join(__dirname, 'storage-state.json');
const SEEN_PATH = path.join(__dirname, 'seen-assignments.json');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
}

function normalizeDate(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/\b(?:at|due|opens?|closes?|available|until|from)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const dt = new Date(cleaned);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  return null;
}

function clip(text, max = 1900) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeCourseName(text) {
  if (!text) return 'Unknown';
  const match = text.match(/([A-Z]{3,5}\s*\d{3})/i);
  return match ? match[1].toUpperCase().replace(/\s+/, ' ') : text.trim();
}

async function notionRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchSchema() {
  return notionRequest(`https://api.notion.com/v1/data_sources/${NOTION_DATA_SOURCE_ID}`);
}

function chooseCourse(course, schema) {
  const options = schema.properties?.Course?.select?.options?.map(o => o.name) || [];
  const normalized = normalizeCourseName(course);
  if (options.includes(normalized)) return normalized;
  return options.includes('pcrf') && /pcrf/i.test(course) ? 'pcrf' : 'Unknown';
}

function chooseStatus(schema) {
  const options = schema.properties?.Status?.status?.options?.map(o => o.name) || [];
  if (options.includes('DUE DATE')) return 'DUE DATE';
  return options[0] || null;
}

async function notionFindExisting({ name, course, when, schema }) {
  const normalizedCourse = chooseCourse(course, schema);
  const filter = {
    and: [
      { property: 'Name', title: { equals: clip(name, 180) } },
      { property: 'Course', select: { equals: normalizedCourse } }
    ]
  };

  if (when) {
    filter.and.push({ property: 'When', date: { equals: when } });
  }

  const result = await notionRequest(`https://api.notion.com/v1/data_sources/${NOTION_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({ page_size: 10, filter })
  });

  return (result.results || [])[0] || null;
}

async function notionCreate({ name, course, when, url, notes, schema }) {
  const status = chooseStatus(schema);
  const properties = {
    Name: { title: [{ text: { content: clip(name, 180) } }] },
    Course: { select: { name: chooseCourse(course, schema) } },
    When: when ? { date: { start: when } } : { date: null }
  };

  if (status) properties.Status = { status: { name: status } };
  if (schema.properties?.Notes?.type === 'rich_text') {
    properties.Notes = {
      rich_text: [{
        text: {
          content: clip(`Imported from Sakai\n${url}${notes ? `\n\n${notes}` : ''}`)
        }
      }]
    };
  }

  return notionRequest('https://api.notion.com/v1/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties
    })
  });
}

async function ensureLoggedIn(page) {
  await page.goto(SAKAI_URL, { waitUntil: 'networkidle', timeout: 45000 });
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/Log in|Sign in with Microsoft|verification code|two-step|authenticate/i.test(bodyText)) {
    throw new Error('Sakai session expired or needs verification. Run `cd sakai-sync && npm run login` again to refresh the browser session.');
  }
}

async function extractPinnedCourses(page) {
  const courses = await page.evaluate(() => {
    const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
    const anchors = Array.from(document.querySelectorAll('a[href*="/portal/site/"]'));
    const out = [];

    for (const a of anchors) {
      const text = normalize(a.textContent);
      const href = a.href;
      if (!href || !text) continue;
      if (!/^[A-Z]{3,5}\s*\d{3}/i.test(text)) continue;

      const style = window.getComputedStyle(a);
      const visible = style && style.visibility !== 'hidden' && style.display !== 'none';
      const rect = a.getBoundingClientRect();
      if (!visible || (rect.width === 0 && rect.height === 0)) continue;

      out.push({ raw: text, href });
    }

    const dedupe = new Map();
    for (const item of out) dedupe.set(item.href, item);
    return [...dedupe.values()];
  });

  return courses.map(item => ({
    raw: item.raw,
    href: item.href,
    course: normalizeCourseName(item.raw)
  }));
}

async function openCourse(page, course) {
  await page.goto(course.href, { waitUntil: 'networkidle', timeout: 45000 });
}

async function openTool(page, label) {
  const siteMatch = page.url().match(/\/portal\/site\/([^/]+)/i);
  if (!siteMatch) {
    throw new Error(`Could not determine current Sakai site while opening ${label}`);
  }
  const siteId = siteMatch[1];

  const locator = page.locator(`a.btn.btn-nav[href*="/portal/site/${siteId}/tool/"]`).filter({
    has: page.locator('span.me-2', { hasText: new RegExp(`^${label}$`, 'i') })
  }).first();

  await locator.waitFor({ timeout: 15000 });
  const href = await locator.getAttribute('href');
  if (!href || !/\/portal\/site\//i.test(href)) {
    throw new Error(`Could not find clickable nav link for ${label} in site ${siteId}`);
  }
  await page.goto(href, { waitUntil: 'networkidle', timeout: 45000 });
}

async function extractRowsFromCurrentTool(page, toolName, course) {
  const rows = await page.evaluate(({ toolName, course }) => {
    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
    const tables = Array.from(document.querySelectorAll('table'));
    const items = [];

    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th')).map(th => clean(th.textContent));
      const trs = Array.from(table.querySelectorAll('tr'));
      if (!headers.length || trs.length < 2) continue;

      if (toolName === 'Assignments' && headers.includes('Assignment Title') && headers.includes('Due Date')) {
        for (const tr of trs.slice(1)) {
          const cells = Array.from(tr.querySelectorAll('th,td')).map(td => clean(td.textContent));
          if (cells.length < 5) continue;
          const [title, status, grade, openDate, dueDate] = cells;
          if (!title || /^assignment title$/i.test(title)) continue;
          const dueMs = dueDate ? Date.parse(dueDate) : NaN;
          if (!Number.isNaN(dueMs) && dueMs < Date.now()) continue;
          const href = tr.querySelector('a[href]')?.href || null;
          items.push({
            title,
            detail: `Status: ${status || 'Unknown'} | Open Date: ${openDate || 'Unknown'} | Due Date: ${dueDate || 'Unknown'} | Grade: ${grade || 'N/A'}`,
            tool: toolName,
            course,
            href,
            when: dueDate || null
          });
        }
      }

      if (toolName === 'Tests & Quizzes' && headers.includes('Title') && headers.includes('Submitted')) {
        for (const tr of trs.slice(1)) {
          const cells = Array.from(tr.querySelectorAll('th,td')).map(td => clean(td.textContent));
          if (cells.length < 7) continue;
          const [title, statistics, recordedScore, feedbackAvailable, individualScore, time, submitted] = cells;
          if (!title || /^title$/i.test(title)) continue;
          if (submitted) continue;
          const href = tr.querySelector('a[href]')?.href || null;
          items.push({
            title,
            detail: `Statistics: ${statistics || 'N/A'} | Recorded Score: ${recordedScore || 'N/A'} | Feedback Available: ${feedbackAvailable || 'N/A'} | Individual Score: ${individualScore || 'N/A'} | Time: ${time || 'N/A'} | Submitted: Not submitted`,
            tool: toolName,
            course,
            href,
            when: null
          });
        }
      }
    }

    return { items };
  }, { toolName, course });

  const dedupe = new Map();
  for (const item of rows.items) {
    const key = item.href || `${item.title}::${item.course}::${item.tool}`;
    dedupe.set(key, {
      name: item.title,
      course: item.course,
      tool: item.tool,
      detailText: item.detail,
      href: item.href,
      when: item.when
    });
  }

  return [...dedupe.values()].filter(item => item.name && item.name.trim());
}

function parseWhen(detailText) {
  const patterns = [
    /Due(?:\s*Date)?\s*[:\-]?\s*([^|]+)/i,
    /Available\s*Until\s*[:\-]?\s*([^|]+)/i,
    /Accept\s*Until\s*[:\-]?\s*([^|]+)/i,
    /Deadline\s*[:\-]?\s*([^|]+)/i,
    /Close\s*Date\s*[:\-]?\s*([^|]+)/i
  ];
  for (const pattern of patterns) {
    const match = detailText.match(pattern);
    if (match) {
      const parsed = normalizeDate(match[1].trim());
      if (parsed) return parsed;
    }
  }
  return null;
}

(async () => {
  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error('Missing sakai-sync/storage-state.json. Run `cd sakai-sync && npm run login` once and finish the Loyola sign-in flow.');
  }

  const schema = await fetchSchema();
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({ storageState: STORAGE_STATE, userAgent: USER_AGENT });
  const page = await context.newPage();
  const seen = loadSeen();

  await ensureLoggedIn(page);
  const pinnedCourses = await extractPinnedCourses(page);
  const collected = [];
  const errors = [];

  for (const course of pinnedCourses) {
    try {
      await ensureLoggedIn(page);
      await openCourse(page, course);

      for (const toolName of ['Assignments']) {
        try {
          await openTool(page, toolName);
          const rows = await extractRowsFromCurrentTool(page, toolName, course.course);
          collected.push(...rows);
        } catch (err) {
          errors.push({ item: `${course.course} / ${toolName}`, error: err.message });
        }
      }

      await page.goto(SAKAI_URL, { waitUntil: 'networkidle' });
    } catch (err) {
      errors.push({ item: `${course.course}`, error: err.message });
      await page.goto(SAKAI_URL, { waitUntil: 'networkidle' }).catch(() => {});
    }
  }

  const dedupe = new Map();
  for (const item of collected) {
    const hrefish = item.href || `${item.course}::${item.tool}::${item.name}`;
    dedupe.set(hrefish, item);
  }
  const assignments = [...dedupe.values()];

  let created = 0;
  let skipped = 0;
  for (const item of assignments) {
    const key = item.href || `${item.course}::${item.tool}::${item.name}`;
    if (seen[key]) {
      skipped++;
      continue;
    }

    try {
      const when = normalizeDate(item.when) || item.when || parseWhen(item.detailText);
      const existing = await notionFindExisting({
        name: item.name,
        course: item.course,
        when,
        schema
      });
      if (existing) {
        seen[key] = {
          name: item.name,
          url: item.href || null,
          course: item.course,
          tool: item.tool,
          when,
          existingPageId: existing.id,
          createdAt: new Date().toISOString()
        };
        skipped++;
        continue;
      }

      await notionCreate({
        name: item.name,
        course: item.course,
        when,
        url: item.href || SAKAI_URL,
        notes: `${item.tool}\n${item.detailText}`,
        schema
      });
      seen[key] = {
        name: item.name,
        url: item.href || null,
        course: item.course,
        tool: item.tool,
        when,
        createdAt: new Date().toISOString()
      };
      created++;
    } catch (err) {
      errors.push({ item: `${item.course} / ${item.name}`, error: err.message });
    }
  }

  saveSeen(seen);
  const summary = {
    pinnedCourses: pinnedCourses.map(c => c.course),
    found: assignments.length,
    created,
    skipped,
    errors
  };
  console.log(JSON.stringify(summary, null, 2));

  await context.close();
  await browser.close();
  if (errors.length) process.exitCode = 1;
})();
