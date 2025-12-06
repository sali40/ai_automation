import { test } from '@playwright/test';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

// Environment variables with defaults
const timeout = process.env.TIMEOUT ? parseInt(process.env.TIMEOUT) : 600000;
const USER_NAME = process.env.USER_NAME;
const PASSWORD = process.env.PASSWORD;
const COURSE = process.env.COURSE;
const MODULE = process.env.MODULE;
const URL = process.env.URL || "https://amigo.amityonline.com/";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-pro";
const START_ACTIVITY = process.env.START_ACTIVITY ? parseInt(process.env.START_ACTIVITY) : 0;
const MAX_RETRIES = process.env.MAX_RETRIES ? parseInt(process.env.MAX_RETRIES) : 3;

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const quizLogs = [];

// Progress tracker
class ProgressTracker {
  constructor() {
    this.startTime = Date.now();
    this.activities = [];
  }
  
  logActivity(name, status, details = {}) {
    const entry = {
      name,
      status,
      details,
      timestamp: new Date().toISOString(),
      elapsed: Math.round((Date.now() - this.startTime) / 1000)
    };
    this.activities.push(entry);
    console.log(`[PROGRESS] ${name}: ${status} (${entry.elapsed}s elapsed)`);
  }
  
  save() {
    fs.writeFileSync('progress.json', JSON.stringify(this.activities, null, 2));
  }
}

const progress = new ProgressTracker();

// Test configuration
test.use({
  video: process.env.RECORD_VIDEO === 'false' ? 'off' : 'retain-on-failure',
  trace: process.env.RECORD_TRACE === 'false' ? 'off' : 'retain-on-failure',
  screenshot: 'only-on-failure',
  // Specific browser context for GitHub Actions
  contextOptions: {
    ignoreHTTPSErrors: true,
    // Disable GPU in GitHub Actions
    ...(process.env.CI && {
      args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
    })
  }
});

/**
 * Wait for element with timeout
 */
async function waitForElement(page, selector, options = {}) {
  const defaultOptions = {
    timeout: 30000,
    state: 'visible'
  };
  const mergedOptions = { ...defaultOptions, ...options };
  
  try {
    await page.waitForSelector(selector, mergedOptions);
    return true;
  } catch (error) {
    console.warn(`[WARN] Element ${selector} not found within ${mergedOptions.timeout}ms`);
    return false;
  }
}

/**
 * Safe click with retry logic
 */
async function safeClick(locator, page, description, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[INFO] Attempting to click ${description} (attempt ${attempt}/${retries})`);
      
      // Wait for element to be stable
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(500); // Brief wait for stability
      
      // Scroll element into view
      await locator.scrollIntoViewIfNeeded();
      
      // Try to click
      await locator.click({ timeout: 10000 });
      console.log(`[INFO] Successfully clicked ${description}`);
      return true;
    } catch (error) {
      console.error(`[ERROR] Failed to click ${description} on attempt ${attempt}: ${error.message}`);
      
      if (attempt === retries) {
        const screenshotPath = `screenshots/error-click-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`[INFO] Screenshot saved: ${screenshotPath}`);
        throw error;
      }
      
      // Wait before retry
      await page.waitForTimeout(2000 * attempt);
    }
  }
  return false;
}

/**
 * Call Gemini API with retry logic
 */
async function callGeminiWithRetry(prompt, maxRetries = MAX_RETRIES) {
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error(`[ERROR] Gemini API attempt ${attempt} failed:`, error.message);
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
    }
  }
}

/**
 * Analyze page with Gemini AI
 */
async function analyzePageWithGemini(page) {
  try {
    const htmlContent = await page.content();
    const prompt = `
You're acting like a human student navigating an online course. From this HTML, tell me what I should do next.
Return only ONE of these actions:
- start quiz
- continue quiz
- quiz already submitted
- non-quiz content
- go to next

Only return the exact keyword.

HTML: ${htmlContent.substring(0, 10000)}
    `.trim();
    
    const text = await callGeminiWithRetry(prompt);
    const cleanText = text.toLowerCase().trim();
    console.log("[INFO] Gemini suggests:", cleanText);
    return cleanText;
  } catch (error) {
    console.error("[ERROR] Gemini analysis failed:", error);
    return "go to next";
  }
}

/**
 * Append quiz logs to file
 */
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

/**
 * Select quiz answer with multiple strategies
 */
async function selectQuizAnswer(block, answerLetter, questionNumber, page) {
  const strategies = [
    // Strategy 1: Label with text starting with letter
    { selector: `label`, filter: { hasText: new RegExp(`^\\s*${answerLetter}[\\.:)]`) } },
    // Strategy 2: Label containing letter with period
    { selector: `label:has-text("${answerLetter}.")` },
    // Strategy 3: Label containing letter with colon
    { selector: `label:has-text("${answerLetter}:")` },
    // Strategy 4: Input radio button
    { selector: `input[type="radio"]`, nth: answerLetter.charCodeAt(0) - 97 }, // a=0, b=1, etc.
    // Strategy 5: Generic text selector
    { selector: `text=/^${answerLetter}[\\.:)]/i` }
  ];
  
  for (const strategy of strategies) {
    try {
      let element;
      if (strategy.filter) {
        element = block.locator(strategy.selector).filter(strategy.filter).first();
      } else if (strategy.nth !== undefined) {
        element = block.locator(strategy.selector).nth(strategy.nth);
      } else {
        element = block.locator(strategy.selector).first();
      }
      
      if (await element.count() > 0) {
        await element.scrollIntoViewIfNeeded();
        await element.click({ timeout: 5000 });
        console.log(`[INFO] Successfully selected answer ${answerLetter} for question ${questionNumber}`);
        return await element.innerText().catch(() => answerLetter);
      }
    } catch (error) {
      console.debug(`[DEBUG] Strategy failed: ${JSON.stringify(strategy)}`);
    }
  }
  
  console.error(`[ERROR] Could not select answer ${answerLetter} for question ${questionNumber}`);
  return null;
}

/**
 * Process quiz questions
 */
async function processQuizQuestions(page) {
  console.log("[INFO] Processing quiz questions...");
  const questionBlocks = await page.locator('.que').all();
  const sessionLogs = [];
  
  for (let i = 0; i < questionBlocks.length; i++) {
    const block = questionBlocks[i];
    const blockText = await block.innerText();
    console.log(`[INFO] Processing question ${i + 1}/${questionBlocks.length}`);
    
    const prompt = `
You are helping answer a multiple-choice quiz. Analyze the question carefully and provide reasoning before answering.

Here is one full quiz question block:
"""
${blockText}
"""

Return JSON like:
{
  "question": "the clean question text without options",
  "options": ["a. first option", "b. second option", "c. third option"],
  "reasoning": "brief explanation of why this answer is correct",
  "answer": "a"
}

Only return valid JSON, no other text.
    `.trim();
    
    let geminiResult = {
      questionNumber: i + 1,
      question: '',
      options: [],
      geminiAnswer: '',
      reasoning: '',
      selectedAnswer: null,
      timestamp: new Date().toISOString()
    };
    
    try {
      const rawResponse = await callGeminiWithRetry(prompt);
      console.log(`[DEBUG] Gemini raw response for Q${i + 1}:`, rawResponse.substring(0, 200));
      
      // Extract JSON from response
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        geminiResult.question = parsed.question?.trim() || '';
        geminiResult.options = parsed.options || [];
        geminiResult.reasoning = parsed.reasoning || '';
        geminiResult.geminiAnswer = parsed.answer?.trim().toLowerCase() || '';
        
        console.log(`[INFO] Parsed answer for Q${i + 1}: ${geminiResult.geminiAnswer}`);
      }
    } catch (err) {
      console.error(`[ERROR] Failed to process Q${i + 1}:`, err.message);
      progress.logActivity(`Question ${i + 1}`, 'failed', { error: err.message });
    }
    
    // Select the answer
    if (geminiResult.geminiAnswer) {
      geminiResult.selectedAnswer = await selectQuizAnswer(
        block,
        geminiResult.geminiAnswer,
        i + 1,
        page
      );
    }
    
    sessionLogs.push(geminiResult);
    progress.logActivity(`Question ${i + 1}`, 'answered', {
      answer: geminiResult.geminiAnswer
    });
    
    // Brief pause between questions
    await page.waitForTimeout(1000);
  }
  
  return sessionLogs;
}

/**
 * Navigate to next activity
 */
const navigateToNextActivity = async (page) => {
  let nextActivityLink = page.locator('a:has-text("Next Activity")');
  let activityIndex = 0;
  
  while (await nextActivityLink.count() > 0) {
    console.log(`[INFO] Processing activity index ${activityIndex}`);
    progress.logActivity(`Activity ${activityIndex}`, 'started');
    
    // Skip activities before START_ACTIVITY
    if (activityIndex < START_ACTIVITY) {
      console.log(`[INFO] Skipping activity ${activityIndex} (start set to ${START_ACTIVITY})`);
      await safeClick(nextActivityLink, page, "'Next Activity' link");
      await page.waitForTimeout(2000);
      activityIndex++;
      nextActivityLink = page.locator('a:has-text("Next Activity")');
      continue;
    }
    
    // Check for module assessment
    const moduleAssessmentVisible = await page
      .locator('text=/Module Assessment/i')
      .first()
      .isVisible()
      .catch(() => false);
    
    if (moduleAssessmentVisible) {
      console.log("[INFO] Found 'Module Assessment'. Stopping automation.");
      progress.logActivity('Module Assessment', 'found - stopping');
      break;
    }
    
    // Check if already submitted
    const alreadySubmitted = await page
      .locator('text=/already submitted|already attempted/i')
      .count() > 0;
    
    if (alreadySubmitted) {
      console.log("[INFO] Activity already submitted. Moving to next.");
      progress.logActivity(`Activity ${activityIndex}`, 'already submitted');
      await safeClick(nextActivityLink, page, "'Next Activity' link");
      await page.waitForTimeout(2000);
      activityIndex++;
      nextActivityLink = page.locator('a:has-text("Next Activity")');
      continue;
    }
    
    // Analyze page and take action
    const suggestion = await analyzePageWithGemini(page);
    
    // Handle different quiz states
    const attemptBtn = page.getByRole('button', { name: 'Attempt quiz' });
    const continueBtn = page.getByRole('button', { name: 'Continue your attempt' });
    const startBtn = page.getByRole('button', { name: 'Start attempt' });
    const finishBtn = page.getByRole('button', { name: 'Finish attempt' });
    
    // Start or continue quiz
    if (await attemptBtn.isVisible()) {
      await safeClick(attemptBtn, page, "'Attempt quiz' button");
      await page.waitForTimeout(2000);
    } else if (await continueBtn.isVisible()) {
      await safeClick(continueBtn, page, "'Continue your attempt' button");
      await page.waitForTimeout(2000);
    }
    
    if (await startBtn.isVisible()) {
      await safeClick(startBtn, page, "'Start attempt' button");
      await page.waitForTimeout(3000);
    }
    
    // Process quiz if finish button is visible
    if (await finishBtn.isVisible()) {
      const quizResults = await processQuizQuestions(page);
      quizLogs.push(...quizResults);
      
      // Take screenshot before finishing
      const beforeFinishPath = `screenshots/before-finish-${Date.now()}.png`;
      await page.screenshot({ path: beforeFinishPath, fullPage: true });
      console.log(`[INFO] Screenshot saved: ${beforeFinishPath}`);
      
      // Finish the quiz
      await safeClick(finishBtn, page, "'Finish attempt' button");
      await page.waitForTimeout(2000);
      
      // Submit the quiz
      const submitBtn1 = page.getByRole('button', { name: 'Submit all and finish' });
      if (await submitBtn1.isVisible()) {
        await safeClick(submitBtn1, page, "'Submit all and finish' button");
        await page.waitForTimeout(2000);
      }
      
      // Confirm submission in modal
      const modalSubmitBtn = page.getByLabel('Submit all your answers and')
        .getByRole('button', { name: 'Submit all and finish' });
      if (await modalSubmitBtn.isVisible()) {
        await safeClick(modalSubmitBtn, page, "'Submit all and finish' modal button");
      }
      
      // Wait for submission confirmation
      const submitted = await waitForElement(
        page,
        'text=/submitted|completed successfully/i',
        { timeout: 15000, state: 'visible' }
      );
      
      if (submitted) {
        console.log("[INFO] Quiz submission confirmed");
        progress.logActivity(`Activity ${activityIndex}`, 'quiz submitted');
        appendQuizLog(quizLogs);
        
        // Screenshot after submission
        const afterSubmitPath = `screenshots/quiz-submitted-${Date.now()}.png`;
        await page.screenshot({ path: afterSubmitPath, fullPage: true });
        console.log(`[INFO] Screenshot saved: ${afterSubmitPath}`);
      } else {
        console.warn("[WARN] Could not confirm quiz submission");
      }
    }
    
    // Move to next activity
    await safeClick(nextActivityLink, page, "'Next Activity' link");
    console.log("[INFO] Waiting before next cycle...");
    await page.waitForTimeout(3000);
    
    activityIndex++;
    nextActivityLink = page.locator('a:has-text("Next Activity")');
  }
  
  console.log(`[INFO] Completed processing ${activityIndex} activities`);
  progress.logActivity('Navigation', 'completed', { totalActivities: activityIndex });
};

/**
 * Try to click course card with fallback
 */
async function tryClickCardWithFallback(page) {
  console.log("[INFO] Attempting to click course card");
  
  // Wait for cards to load
  await waitForElement(page, '.single-card', { timeout: 10000 });
  
  // Function to check if navigation succeeded
  async function didNavigate() {
    try {
      await page.waitForSelector('a:has-text("Next Activity")', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  
  // Try different card selectors
  const cardSelectors = [
    '.single-card:nth-child(2) > div:first-child',
    '.single-card:nth-of-type(2)',
    '.single-card >> nth=1',
    'div.single-card:has-text("Unit")',
    'div.single-card'
  ];
  
  for (const selector of cardSelectors) {
    try {
      const card = page.locator(selector).first();
      if (await card.count() > 0) {
        await safeClick(card, page, `course card (${selector})`);
        if (await didNavigate()) {
          console.log("[INFO] Successfully navigated via course card");
          return;
        }
      }
    } catch (error) {
      console.debug(`[DEBUG] Card selector failed: ${selector}`);
    }
  }
  
  console.warn("[WARN] Could not click course card, attempting to proceed anyway");
}

/**
 * Main test
 */
test('🎓 Amity course automation with Gemini AI', async ({ page, context }) => {
  test.setTimeout(timeout);
  
  // Set up error handlers
  page.on('pageerror', (err) => {
    // Ignore known harmless errors
    const ignoredErrors = ['availableblockregions', 'style', 'gtag'];
    const shouldIgnore = ignoredErrors.some(ignored => 
      err.message.toLowerCase().includes(ignored)
    );
    
    if (!shouldIgnore) {
      console.error("[PAGE ERROR]:", err.message.substring(0, 200));
    }
  });
  
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
      console.debug("[CONSOLE ERROR]:", msg.text().substring(0, 200));
    }
  });
  
  try {
    // Navigate to URL with extended timeout for GitHub Actions
    console.log(`[INFO] Navigating to URL: ${URL.substring(0, 30)}***`);
    await page.goto(URL, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });
    
    // Wait for page to stabilize
    await page.waitForTimeout(3000);
    
    // Take initial screenshot
    await page.screenshot({ path: 'screenshots/initial.png', fullPage: true });
    
    // Handle login
    console.log(`[INFO] Logging in as user: ${USER_NAME ? USER_NAME.substring(0, 3) + '***' : 'N/A'}`);
    
    // Wait for login form to be ready
    await waitForElement(page, 'input[placeholder="Username"]', { timeout: 20000 });
    await page.getByPlaceholder('Username').fill(USER_NAME);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    
    await page.screenshot({ path: 'screenshots/login-filled.png', fullPage: true });
    
    // Click login button
    const loginBtn = page.getByRole('button', { name: 'Log in' });
    await safeClick(loginBtn, page, "'Log in' button");
    
    // Wait for navigation after login
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    progress.logActivity('Login', 'completed');
    
    // Handle welcome popup if present
    try {
      const popupCloseBtn = page.locator('#popupCloseBtn');
      await popupCloseBtn.waitFor({ timeout: 3000, state: 'visible' });
      await popupCloseBtn.click();
      console.log('[INFO] Closed welcome overlay');
    } catch {
      console.log('[INFO] No welcome overlay to close');
    }
    
    // Navigate to course
    console.log(`[INFO] Navigating to course: ${COURSE}`);
    await waitForElement(page, `text="${COURSE}"`, { timeout: 20000 });
    const courseLink = page.getByRole('link', { name: COURSE });
    await safeClick(courseLink, page, `Course link "${COURSE}"`);
    progress.logActivity('Course Navigation', 'completed');
    
    // Wait for course page to load
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    
    // Navigate to module
    console.log(`[INFO] Navigating to module: ${MODULE}`);
    await waitForElement(page, `text="${MODULE}"`, { timeout: 20000 });
    const moduleLink = page.getByRole('link', { name: MODULE });
    await safeClick(moduleLink, page, `Module link "${MODULE}"`);
    progress.logActivity('Module Navigation', 'completed');
    
    // Wait for module page to load
    await page.waitForTimeout(3000);
    
    // Click course card
    await tryClickCardWithFallback(page);
    
    // Start navigating activities
    await navigateToNextActivity(page);
    
    // Save progress
    progress.save();
    
    // Final screenshot
    await page.screenshot({ path: 'screenshots/final.png', fullPage: true });
    console.log("[INFO] Automation completed successfully");
    
  } catch (error) {
    console.error("[ERROR] Test failed:", error);
    progress.logActivity('Test', 'failed', { error: error.message });
    progress.save();
    
    // Error screenshot
    await page.screenshot({ 
      path: `screenshots/error-final-${Date.now()}.png`, 
      fullPage: true 
    });
    
    throw error;
  }
});
