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

function logStep(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

//–– central click helper ––
async function safeClick(locator, page, description) {
  logStep(`➡️ Waiting for: ${description}`);
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  logStep(`➡️ Clicking: ${description}`);
  try {
    await locator.click();
    logStep(`✅ Clicked: ${description}`);
  } catch (err) {
    const shot = `screenshots/error-${Date.now()}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    logStep(`❌ Click failed: ${description} — ${err.message}`);
    logStep(`📷 Screenshot saved: ${shot}`);
    throw err;
  }
}

//–– close or remove the popup ––
async function closeWelcomePopup(page) {
  logStep(`🔍 Checking for welcome popup`);
  try {
    await page.waitForSelector('#welcomePopup', { timeout: 5000 });
    logStep(`🗙 Found popup – removing via DOM`);
    await page.evaluate(() => {
      document.getElementById('welcomePopup')?.remove();
    });
    logStep(`✅ Popup removed from DOM`);
  } catch {
    logStep(`ℹ️ No popup appeared`);
  }
}

//–– ask Gemini what to do next ––
async function analyzePageWithGemini(page) {
  logStep(`🤖 Sending HTML to Gemini for next-action suggestion`);
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
    const action = result.response.text().toLowerCase().trim();
    logStep(`🤖 Gemini suggests: ${action}`);
    return action;
  } catch (err) {
    logStep(`⚠️ Gemini API error: ${err.message}`);
    return 'go to next';
  }
}

//–– navigate activities & handle quizzes ––
async function navigateToNextActivity(page) {
  logStep(`▶️ Entering activity loop (start index: ${START_ACTIVITY})`);
  await closeWelcomePopup(page);

  let nextLink = page.locator('a:has-text("Next Activity")');
  let idx = 0;

  while (await nextLink.count() > 0) {
    logStep(`🔄 Activity #${idx}`);

    if (idx < START_ACTIVITY) {
      await safeClick(nextLink, page, 'Next Activity link');
      await page.waitForTimeout(2000);
      idx++;
      nextLink = page.locator('a:has-text("Next Activity")');
      continue;
    }

    if (await page.locator('text=Quiz already submitted').count() > 0) {
      logStep(`✅ Detected “Quiz already submitted”—skipping`);
      await safeClick(nextLink, page, 'Next Activity link');
      await page.waitForTimeout(2000);
      idx++;
      nextLink = page.locator('a:has-text("Next Activity")');
      continue;
    }

    if (await page.locator('text=Module Assessment').isVisible().catch(() => false)) {
      logStep(`🛑 “Module Assessment” found—exiting loop`);
      return;
    }

    const suggestion = await analyzePageWithGemini(page);
    const attemptBtn = page.getByRole('button', { name: 'Attempt quiz' });
    const continueBtn = page.getByRole('button', { name: 'Continue your attempt' });

    if ((suggestion === 'start quiz' || suggestion === 'go to next') && await attemptBtn.isVisible()) {
      await safeClick(attemptBtn, page, 'Attempt quiz button');
    } else if (suggestion === 'continue quiz' && await continueBtn.isVisible()) {
      await safeClick(continueBtn, page, 'Continue your attempt button');
    }

    const startBtn = page.getByRole('button', { name: 'Start attempt' });
    if (await startBtn.isVisible()) {
      await safeClick(startBtn, page, 'Start attempt button');
    }

    const finishBtn = page.getByRole('button', { name: 'Finish attempt' });
    if (await finishBtn.isVisible()) {
      logStep(`✍️ Answering quiz at activity #${idx}`);
      const questions = await page.locator('.que').all();

      for (let i = 0; i < questions.length; i++) {
        logStep(`❓ Processing question ${i + 1}`);
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

        let geminiResult = { question: '', options: [], answer: '' };
        try {
          const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
          const raw = (await model.generateContent(prompt)).response.text();
          const json = JSON.parse(raw.match(/{[\s\S]+}/)[0]);
          geminiResult = {
            question: json.question.trim(),
            options: json.options,
            answer: json.answer.trim().toLowerCase(),
          };
          logStep(`🔍 Gemini Q${i + 1}: answer=${geminiResult.answer}`);
        } catch (e) {
          logStep(`⚠️ Gemini parse error on Q${i + 1}: ${e.message}`);
        }

        if (geminiResult.answer) {
          const letter = geminiResult.answer;
          const optionIndex = letter.charCodeAt(0) - 97; // a→0, b→1, etc.
          const radios = block.locator('input[type="radio"]');

          if (await radios.count() > optionIndex) {
            logStep(`➡️ Checking radio #${optionIndex} (${letter})`);
            await radios.nth(optionIndex).check();
            logStep(`✅ Radio ${letter} checked`);
          } else {
            const fullText = geminiResult.options[optionIndex];
            if (fullText) {
              const lbl = block.locator('label', { hasText: fullText });
              if (await lbl.count() > 0) {
                logStep(`➡️ Falling back to clicking label: "${fullText}"`);
                await safeClick(lbl.first(), page, `label for ${letter}`);
                logStep(`✅ Clicked label for ${letter}`);
              } else {
                logStep(`❗ Could not find label text "${fullText}"`);
              }
            } else {
              logStep(`❗ No option text for letter ${letter}`);
            }
          }
        }

        quizLogs.push(geminiResult);
      }

      const beforeSnap = `screenshots/before-finish-${Date.now()}.png`;
      await page.screenshot({ path: beforeSnap, fullPage: true });
      logStep(`📷 Screenshot before finish: ${beforeSnap}`);

      await safeClick(finishBtn, page, 'Finish attempt button');
      await safeClick(
        page.getByRole('button', { name: 'Submit all and finish' }),
        page,
        'Submit all and finish'
      );
      await page.waitForSelector('text=Your attempt has been submitted', { state: 'hidden', timeout });
      logStep(`✅ Quiz submitted for activity #${idx}`);

      const afterSnap = `screenshots/quiz-submitted-${Date.now()}.png`;
      await page.screenshot({ path: afterSnap, fullPage: true });
      logStep(`📷 Screenshot after submission: ${afterSnap}`);
    }

    await safeClick(nextLink, page, 'Next Activity link');
    await page.waitForTimeout(3000);

    idx++;
    nextLink = page.locator('a:has-text("Next Activity")');
  }

  logStep(`▶️ Exiting activity loop`);
}

//–– feedback form ––
async function fillFeedbackForm(page) {
  logStep(`✉️ Filling feedback form`);
  const btn = page.getByRole('button', { name: 'Answer the questions' });
  await safeClick(btn, page, 'Answer the questions button');
  await page.waitForTimeout(2000);

  const groups = await page.getByRole('radiogroup').all();
  logStep(`📊 Found ${groups.length} feedback questions`);
  for (let i = 0; i < Math.min(groups.length, 2); i++) {
    const radios = groups[i].locator('input[type="radio"]');
    if (await radios.count() >= 6) {
      await safeClick(radios.nth(5), page, `6th radio for Q${i + 1}`);
    }
  }

  const submit = page.getByRole('button', { name: 'Submit' });
  if (await submit.count() > 0) {
    await safeClick(submit, page, 'Submit feedback button');
    logStep(`✅ Feedback submitted`);
  } else {
    logStep(`⚠️ No Submit button found for feedback`);
  }
}

//–– card fallback ––
async function tryClickCardWithFallback(page) {
  logStep(`🎴 Trying to click first card`);
  const first = page.locator('.single-card').nth(1).locator('div').first();
  async function navigated() {
    try {
      await page.waitForSelector('a:has-text("Next Activity")', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  try {
    await safeClick(first, page, 'first card');
    logStep(`✅ First card clicked`);
  } catch {
    logStep(`⚠️ First card click failed—trying second`);
  }
  if (await navigated()) return;

  const second = page.locator('.single-card').nth(2).locator('div').first();
  await safeClick(second, page, 'second card');
  logStep(`✅ Second card clicked`);
  await navigated();
}

//–– the test itself ––
test('🎓 Amity course automation with Gemini AI', async ({ page }) => {
  logStep(`🟢 Test started`);

  // delete existing log file if present
  if (fs.existsSync('quiz-log.json')) {
    logStep(`🗑️ Deleting existing quiz-log.json`);
    fs.unlinkSync('quiz-log.json');
    logStep(`✅ Deleted existing quiz-log.json`);
  }

  test.setTimeout(timeout);

  page.on('pageerror', err => {
    if (!err.message.includes('availableblockregions')) {
      logStep(`🔴 Page error: ${err.message}`);
    }
  });

  logStep(`🌐 Navigating to ${URL}`);
  await page.goto(URL);

  logStep(`🖊️ Filling in credentials`);
  await page.getByPlaceholder('Username').fill(USER_NAME);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  logStep(`📷 Screenshot of login fields`);
  await page.screenshot({ path: 'screenshots/login-fields.png', fullPage: true });

  await safeClick(page.getByRole('button', { name: 'Log in' }), page, 'Log in button');
  await closeWelcomePopup(page);

  logStep(`📚 Selecting course: ${COURSE}`);
  await safeClick(page.getByRole('link', { name: COURSE }), page, `Course "${COURSE}"`);
  await closeWelcomePopup(page);

  logStep(`📖 Selecting module: ${MODULE}`);
  await safeClick(page.getByRole('link', { name: MODULE }), page, `Module "${MODULE}"`);

  await tryClickCardWithFallback(page);
  await navigateToNextActivity(page);

  if (await page.getByRole('button', { name: 'Answer the questions' }).count() > 0) {
    await fillFeedbackForm(page);
  } else {
    logStep(`ℹ️ No feedback form detected`);
  }

  logStep(`📷 Final screenshot`);
  await page.screenshot({ path: 'screenshots/final.png', fullPage: true });

  // save all quiz logs at the end
  logStep(`💾 Saving quiz logs to quiz-log.json`);
  fs.writeFileSync('quiz-log.json', JSON.stringify(quizLogs, null, 2));
  logStep(`✅ quiz-log.json written with ${quizLogs.length} entries`);

  logStep(`🔚 Test finished`);
});
