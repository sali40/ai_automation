import { test } from '@playwright/test';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();



const timeout = 600000;

const USER_NAME = process.env.USER_NAME;
const PASSWORD = process.env.PASSWORD;
const COURSE = process.env.COURSE;
const MODULE = process.env.MODULE;
const URL = "https://amigo.amityonline.com/";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;

// Optional: provide an environment variable START_ACTIVITY (zero-based index) to start processing from a certain activity.
const START_ACTIVITY = process.env.START_ACTIVITY ? parseInt(process.env.START_ACTIVITY) : 0;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const quizLogs = [];

/**
 * A helper function to safely click on a locator.
 * In case of any error, a full-page screenshot is taken and the error is logged.
 */
test.use({
  video: 'on'
});

async function safeClick(locator, page, description) {
  try {
    console.log(`[INFO] Attempting to click ${description}`);
    await locator.click();
    console.log(`[INFO] Successfully clicked ${description}`);
  } catch (error) {
    const screenshotPath = `screenshots/error-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.error(`[ERROR] Failed to click ${description}: ${error.message}`);
    console.log(`[INFO] Screenshot taken: ${screenshotPath}`);
    throw error;
  }
}

async function analyzePageWithGemini(page) {
  const htmlContent = await page.content();
  const prompt = `
You're acting like a human student navigating an online course.
From this HTML, tell me what I should do next. Return only ONE of these actions:
- start quiz
- continue quiz
- quiz already submitted
- non-quiz content
- go to next
Only return the exact keyword.
HTML:
${htmlContent}
  `.trim();

  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().toLowerCase().trim();
    console.log("[INFO] Gemini suggests:", text);
    return text;
  } catch (error) {
    console.error("[ERROR] Gemini API error:", error);
    return "go to next";
  }
}

function appendQuizLog(newLogs) {
  let existingLogs = [];
  try {
    if (fs.existsSync('quiz-log.json')) {
      const fileContent = fs.readFileSync('quiz-log.json', 'utf8');
      existingLogs = JSON.parse(fileContent);
    }
  } catch (err) {
    console.error("[ERROR] Reading quiz-log.json:", err);
  }
  const combinedLogs = existingLogs.concat(newLogs);
  fs.writeFileSync('quiz-log.json', JSON.stringify(combinedLogs, null, 2));
  console.log("[INFO] Saved quiz answers to quiz-log.json");
}

const navigateToNextActivity = async (page) => {
  let nextActivityLink = page.locator('a:has-text("Next Activity")');
  let activityIndex = 0;

  while (await nextActivityLink.count() > 0) {
    console.log(`[INFO] At activity index ${activityIndex}`);

    // If you haven't reached the desired starting activity, skip it.
    if (activityIndex < START_ACTIVITY) {
      console.log(`[INFO] Skipping activity ${activityIndex} (start activity set to ${START_ACTIVITY}).`);
      await safeClick(nextActivityLink, page, "'Next Activity' link");
      await page.waitForTimeout(2000);
      activityIndex++;
      nextActivityLink = page.locator('a:has-text("Next Activity")');
      continue;
    }

    // Check if quiz/activity is already attempted (using an indicative text)
    if (await page.locator('text=Quiz already submitted').count() > 0) {
      console.log("[INFO] Quiz already submitted detected. Skipping this activity.");
      await safeClick(nextActivityLink, page, "'Next Activity' link");
      await page.waitForTimeout(2000);
      activityIndex++;
      nextActivityLink = page.locator('a:has-text("Next Activity")');
      continue;
    }

    // If the page indicates a module assessment, we stop the automation.
    const containsModuleAssessment = await page
      .locator('text=Module Assessment')
      .first()
      .isVisible()
      .catch(() => false);
    if (containsModuleAssessment) {
      console.log("[INFO] Found 'Module Assessment'. Stopping automation.");
      return;
    }

    const suggestion = await analyzePageWithGemini(page);
    const continueBtn = page.getByRole('button', { name: 'Continue your attempt' });
    const attemptBtn = page.getByRole('button', { name: 'Attempt quiz' });

    if ((suggestion === 'start quiz' || suggestion === 'go to next') && await attemptBtn.isVisible()) {
      await safeClick(attemptBtn, page, "'Attempt quiz' button");
    } else if (suggestion === 'continue quiz' || (await continueBtn.count() > 0 && await continueBtn.isVisible())) {
      try {
        await safeClick(continueBtn, page, "'Continue your attempt' button");
      } catch (e) {
        console.log("[WARN] Error clicking 'Continue your attempt':", e.message);
      }
    }

    const startBtn = page.getByRole('button', { name: 'Start attempt' });
    if (await startBtn.isVisible()) {
      await safeClick(startBtn, page, "'Start attempt' button");
    }

    const finishBtn = page.getByRole('button', { name: 'Finish attempt' });
    if (await finishBtn.isVisible()) {
      console.log("[INFO] Processing quiz questions...");

      // Process each quiz question block
      const questionBlocks = await page.locator('.que').all();
      for (let i = 0; i < questionBlocks.length; i++) {
        const block = questionBlocks[i];
        const blockText = await block.innerText();
        console.log(`[INFO] Processing question block ${i + 1}`);

        const prompt = `
You are helping answer a multiple-choice quiz. there should be enough reasoning questions before answering the question
Here is one full quiz question block copied from a web page. It includes the question and its options.
Return the following:
- The clean question text (without options)
- A list of options (e.g. a., b., c. ...)
- The correct answer letter only (e.g. "a", "b", "c", etc.)
Here is the block:
"""
${blockText}
"""
Return JSON like:
{
  "question": "....",
  "options": ["a. ...", "b. ..."],
  "answer": "b"
}
        `.trim();

        let geminiResult = {
          question: '',
          options: [],
          geminiAnswer: '',
          selectedAnswer: null,
          selectedIndex: null
        };

        try {
          const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
          const result = await model.generateContent(prompt);
          const rawResponse = result.response.text();
          console.log(`[INFO] Gemini response for question ${i + 1}:`, rawResponse);
          const match = rawResponse.match(/{[\s\S]+}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            geminiResult.question = parsed.question?.trim() || '';
            geminiResult.options = parsed.options || [];
            geminiResult.geminiAnswer = parsed.answer?.trim().toLowerCase() || '';
            console.log(`[INFO] Parsed Gemini result for question ${i + 1}:`, geminiResult);
          }
        } catch (err) {
          console.error(`[ERROR] Gemini failed on Q${i + 1}:`, err.message);
        }

        // Click the answer option based on Gemini's answer
        if (geminiResult.geminiAnswer) {
          const answerLetter = geminiResult.geminiAnswer;
          let optionElement = block.locator('label').filter({
            hasText: new RegExp(`^\\s*${answerLetter}[\\.:]`)
          }).first();
          if (await optionElement.count() > 0) {
            await safeClick(optionElement, page, `option ${answerLetter} (label) for question ${i + 1}`);
            geminiResult.selectedAnswer = await optionElement.innerText();
          } else {
            // Fallback: try a more general text locator matching answer letter followed by a period.
            optionElement = block.locator(`text=${answerLetter}.`);
            if (await optionElement.count() > 0) {
              await safeClick(optionElement.first(), page, `option ${answerLetter} (fallback) for question ${i + 1}`);
              geminiResult.selectedAnswer = await optionElement.first().innerText();
            } else {
              console.error(`[ERROR] No clickable option found for answer letter: ${answerLetter} in question ${i + 1}`);
            }
          }
          // Determine the selected index among all options (if available)
          const allOptions = await block.locator('label').allTextContents();
          geminiResult.selectedIndex = allOptions.findIndex(opt =>
            opt.toLowerCase().trim().startsWith(answerLetter)
          );
          console.log(`[INFO] Clicked option: ${geminiResult.selectedAnswer} for question ${i + 1}`);
        }
        quizLogs.push(geminiResult);
      }

      const beforeFinishTimestamp = Date.now();
      const beforeFinishPath = `screenshots/before-finish-${beforeFinishTimestamp}.png`;
      await page.screenshot({ path: beforeFinishPath, fullPage: true });
      console.log(`[INFO] Screenshot before finishing quiz saved to ${beforeFinishPath}`);

      await safeClick(finishBtn, page, "'Finish attempt' button");

      const submitBtn1 = page.getByRole('button', { name: 'Submit all and finish' });
      await safeClick(submitBtn1, page, "'Submit all and finish' button (first occurrence)");

      const submitBtn2 = page.getByLabel('Submit all your answers and')
                           .getByRole('button', { name: 'Submit all and finish' });
      await safeClick(submitBtn2, page, "'Submit all and finish' button (second occurrence)");

      try {
        await page.waitForSelector('text=Your attempt has been submitted', { state: 'hidden', timeout });
        console.log("[INFO] Quiz submission confirmed.");
      } catch (error) {
        const waitScreenshot = `screenshots/error-wait-${Date.now()}.png`;
        await page.screenshot({ path: waitScreenshot, fullPage: true });
        console.error("[ERROR] Waiting for submission confirmation failed:", error.message);
        console.log(`[INFO] Screenshot taken: ${waitScreenshot}`);
        throw error;
      }

      appendQuizLog(quizLogs);

      const quizTimestamp = Date.now();
      const screenshotPath = `screenshots/quiz-submitted-${quizTimestamp}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[INFO] Screenshot after quiz submission saved to ${screenshotPath}`);
    }

    await safeClick(nextActivityLink, page, "'Next Activity' link");
    console.log("[INFO] Waiting 3 seconds before next cycle.");
    await page.waitForTimeout(3000);
    activityIndex++;
    nextActivityLink = page.locator('a:has-text("Next Activity")');
  }
};

async function tryClickCardWithFallback(page) {
  const firstCard = page.locator('.single-card').nth(1).locator('div').first();
  async function didNavigate() {
    try {
      await page.waitForSelector('a:has-text("Next Activity")', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  try {
    await safeClick(firstCard, page, "first card");
  } catch (error) {
    console.error("[WARN] First card click failed, trying second card:", error.message);
  }
  if (await didNavigate()) return;
  const secondCard = page.locator('.single-card').nth(2).locator('div').first();
  await safeClick(secondCard, page, "second card");
  await didNavigate();
}

test('🎓 Amity course automation with Gemini AI', async ({ page }) => {
  test.setTimeout(timeout);

  page.on('pageerror', (err) => {
    if (!err.message.includes("availableblockregions")) {
      console.error("[PAGE ERROR]:", err);
    }
  });

  console.log("[INFO] Navigating to URL:", URL);
  await page.goto(URL);
  await page.screenshot({ path: 'screenshots/initial.png', fullPage: true });
  console.log("[INFO] Filling in username and password.");
  await page.getByPlaceholder('Username').fill(USER_NAME);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.screenshot({ path: 'screenshots/login.png', fullPage: true });
  await safeClick(page.getByRole('button', { name: 'Log in' }), page, "'Log in' button");
  await safeClick(page.getByRole('link', { name: COURSE }), page, `Course link "${COURSE}"`);
  await safeClick(page.getByRole('link', { name: MODULE }), page, `Module link "${MODULE}"`);

  await tryClickCardWithFallback(page);
  await navigateToNextActivity(page);

  await page.screenshot({ path: 'screenshots/final.png', fullPage: true });
  console.log("[INFO] Automation finished.");
});
