import { test } from '@playwright/test';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const timeout = 1800000;
const USER_NAME = process.env.USER_NAME;
const PASSWORD = process.env.PASSWORD;
const COURSE = process.env.COURSE;
const MODULE = process.env.MODULE;
const URL = 'https://amigo.amityonline.com/';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const START_ACTIVITY = process.env.START_ACTIVITY
  ? parseInt(process.env.START_ACTIVITY, 10)
  : 0;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const quizLogs = [];

//–– central click helper ––
async function safeClick(locator, page, description) {
  try {
    console.log(`[INFO] Clicking ${description}`);
    await locator.click();
  } catch (err) {
    const shot = `screenshots/error-${Date.now()}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    console.error(`[ERROR] ${description} failed:`, err.message);
    console.log(`[INFO] Screenshot saved: ${shot}`);
    throw err;
  }
}

//–– close or remove the popup ––
async function closeWelcomePopup(page) {
  const closeBtn = page.locator('#welcomePopup .popup-close');
  try {
    // wait up to 5s for the button
    await closeBtn.waitFor({ timeout: 5000 });
    await safeClick(closeBtn, page, "'Welcome popup close' button");
    console.log('[INFO] Popup closed via button');
  } catch {
    // fallback: just strip it from the DOM
    await page.evaluate(() => {
      const el = document.getElementById('welcomePopup');
      if (el) el.remove();
    });
    console.log('[INFO] Popup removed via DOM');
  }
}

//–– ask Gemini what to do next ––
async function analyzePageWithGemini(page) {
  const html = await page.content();
  const prompt = `
You're a human student navigating an online course.
Return exactly one of: start quiz | continue quiz | quiz already submitted | non-quiz content | go to next.
HTML:
${html}
  `.trim();

  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  try {
    const result = await model.generateContent(prompt);
    return result.response.text().toLowerCase().trim();
  } catch (err) {
    console.error('[ERROR] Gemini:', err);
    return 'go to next';
  }
}

//–– persist quiz answers ––
function appendQuizLog(newLogs) {
  let existing = [];
  try {
    if (fs.existsSync('quiz-log.json')) {
      existing = JSON.parse(fs.readFileSync('quiz-log.json', 'utf8'));
    }
  } catch {}
  fs.writeFileSync('quiz-log.json', JSON.stringify(existing.concat(newLogs), null, 2));
  console.log('[INFO] Quiz log updated');
}

//–– navigate activities & handle quizzes ––
async function navigateToNextActivity(page) {
  // remove any popup before starting
  await closeWelcomePopup(page);

  let nextLink = page.locator('a:has-text("Next Activity")');
  let idx = 0;

  while ((await nextLink.count()) > 0) {
    console.log(`[INFO] Activity #${idx}`);

    // skip early
    if (idx < START_ACTIVITY) {
      await safeClick(nextLink, page, "'Next Activity' link");
      await page.waitForTimeout(2000);
      idx++;
      nextLink = page.locator('a:has-text("Next Activity")');
      continue;
    }

    // skip if already done
    if ((await page.locator('text=Quiz already submitted').count()) > 0) {
      console.log('[INFO] Already submitted – skipping');
      await safeClick(nextLink, page, "'Next Activity' link");
      await page.waitForTimeout(2000);
      idx++;
      nextLink = page.locator('a:has-text("Next Activity")');
      continue;
    }

    // stop on module assessment
    if (await page.locator('text=Module Assessment').isVisible().catch(() => false)) {
      console.log('[INFO] Module Assessment found – stopping');
      return;
    }

    const suggestion = await analyzePageWithGemini(page);
    const attemptBtn = page.getByRole('button', { name: 'Attempt quiz' });
    const continueBtn = page.getByRole('button', { name: 'Continue your attempt' });

    if ((suggestion === 'start quiz' || suggestion === 'go to next') && (await attemptBtn.isVisible())) {
      await safeClick(attemptBtn, page, "'Attempt quiz' button");
    } else if (suggestion === 'continue quiz' && (await continueBtn.isVisible())) {
      await safeClick(continueBtn, page, "'Continue your attempt' button");
    }

    const startBtn = page.getByRole('button', { name: 'Start attempt' });
    if (await startBtn.isVisible()) {
      await safeClick(startBtn, page, "'Start attempt' button");
    }

    const finishBtn = page.getByRole('button', { name: 'Finish attempt' });
    if (await finishBtn.isVisible()) {
      console.log('[INFO] Answering quiz…');
      const questions = await page.locator('.que').all();

      for (let i = 0; i < questions.length; i++) {
        const block = questions[i];
        const txt = await block.innerText();
        const prompt = `
You are answering a multiple-choice question.
Return JSON: { question, options[], answer }.
Block:
"""
${txt}
"""
`.trim();

        let result = { question: '', options: [], answer: '' };
        try {
          const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
          const raw = (await model.generateContent(prompt)).response.text();
          const json = JSON.parse(raw.match(/{[\s\S]+}/)[0]);
          result = {
            question: json.question.trim(),
            options: json.options,
            answer: json.answer.trim().toLowerCase(),
          };
        } catch (e) {
          console.error(`[ERROR] Gemini Q${i + 1}:`, e);
        }

        if (result.answer) {
          const opt = block.locator('label').filter({
            hasText: new RegExp(`^\\s*${result.answer}[\\.:]`),
          }).first();
          if ((await opt.count()) > 0) {
            await safeClick(opt, page, `option ${result.answer} for Q${i + 1}`);
          } else {
            console.error(`[ERROR] Could not find option ${result.answer}`);
          }
        }

        quizLogs.push(result);
      }

      await page.screenshot({ path: `screenshots/before-finish-${Date.now()}.png`, fullPage: true });
      await safeClick(finishBtn, page, "'Finish attempt'");
      await safeClick(
        page.getByRole('button', { name: 'Submit all and finish' }),
        page,
        "'Submit all and finish'"
      );
      await page.waitForSelector('text=Your attempt has been submitted', { state: 'hidden', timeout });

      appendQuizLog(quizLogs);
      await page.screenshot({ path: `screenshots/quiz-submitted-${Date.now()}.png`, fullPage: true });
    }

    await safeClick(nextLink, page, "'Next Activity' link");
    await page.waitForTimeout(3000);
    idx++;
    nextLink = page.locator('a:has-text("Next Activity")');
  }
}

//–– feedback form ––
async function fillFeedbackForm(page) {
  const btn = page.getByRole('button', { name: 'Answer the questions' });
  await safeClick(btn, page, '"Answer the questions"');
  await page.waitForTimeout(2000);

  const groups = await page.getByRole('radiogroup').all();
  for (let i = 0; i < Math.min(groups.length, 2); i++) {
    const radios = groups[i].locator('input[type="radio"]');
    if ((await radios.count()) >= 6) {
      await safeClick(radios.nth(5), page, `6th radio for Q${i + 1}`);
    }
  }

  const submit = page.getByRole('button', { name: 'Submit' });
  if ((await submit.count()) > 0) {
    await safeClick(submit, page, '"Submit" feedback');
  }
}

//–– card fallback ––
async function tryClickCardWithFallback(page) {
  const first = page.locator('.single-card').nth(1).locator('div').first();
  async function nav() {
    return page.waitForSelector('a:has-text("Next Activity")', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  }

  try {
    await safeClick(first, page, 'first card');
  } catch {
    console.warn('[WARN] First card fail, trying second');
  }
  if (await nav()) return;

  const second = page.locator('.single-card').nth(2).locator('div').first();
  await safeClick(second, page, 'second card');
  await nav();
}

//–– the test itself ––
test('🎓 Amity course automation with Gemini AI', async ({ page }) => {
  test.setTimeout(timeout);

  page.on('pageerror', err => {
    if (!err.message.includes('availableblockregions')) {
      console.error('[PAGE ERROR]:', err);
    }
  });

  console.log('[INFO] Go to login page');
  await page.goto(URL);

  console.log('[INFO] Fill credentials');
  await page.getByPlaceholder('Username').fill(USER_NAME);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.screenshot({ path: 'screenshots/login.png', fullPage: true });

  await safeClick(page.getByRole('button', { name: 'Log in' }), page, "'Log in'");
  // ← NEW & FORCED: dismiss or remove popup
  await closeWelcomePopup(page);

  console.log('[INFO] Enter course & module');
  await safeClick(page.getByRole('link', { name: COURSE }), page, `Course "${COURSE}"`);
  // re-check in case it reappears
  await closeWelcomePopup(page);

  await safeClick(page.getByRole('link', { name: MODULE }), page, `Module "${MODULE}"`);

  await tryClickCardWithFallback(page);
  await navigateToNextActivity(page);

  if ((await page.getByRole('button', { name: 'Answer the questions' }).count()) > 0) {
    console.log('[INFO] Feedback form found');
    await fillFeedbackForm(page);
  }

  await page.screenshot({ path: 'screenshots/final.png', fullPage: true });
  console.log('[INFO] Done.');
});
