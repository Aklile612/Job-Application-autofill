// background.js
// MV3 service worker. Responsible for:
//  1. Receiving GENERATE_ANSWERS requests from content.js
//  2. Calling the Gemini API with resume + job description + field list
//  3. Returning a JSON map of {fieldIdentifier: answer} back to content.js
//
// This call is made here rather than in content.js so it isn't subject
// to the page's own CORS/CSP restrictions, and so the API key never
// touches the page's JS context.

// Model names as of mid-2026. gemini-1.5-flash and gemini-pro have been
// retired — if you get a 404 "model not found" error again in the future,
// check https://ai.google.dev/gemini-api/docs/models for current names,
// or call https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY
// to list every model your key currently has access to.
const GEMINI_MODEL = 'gemini-2.5-flash'; // alt: 'gemini-3.5-flash' for the newer model
const GEMINI_ENDPOINT = (model, apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_ANSWERS') {
    handleGenerateAnswers(message.payload)
      .then((answers) => sendResponse({ success: true, answers }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }
});

async function handleGenerateAnswers({ jobDescription, fields }) {
  const { geminiApiKey, resumeText } = await chrome.storage.local.get([
    'geminiApiKey',
    'resumeText',
  ]);

  if (!geminiApiKey) throw new Error('No Gemini API key saved. Open the extension popup and save one.');
  if (!resumeText) throw new Error('No resume saved. Upload a PDF resume in the extension popup first.');

  const prompt = buildPrompt({ resumeText, jobDescription, fields });

  const rawText = await callGeminiWithRetry(prompt, geminiApiKey);

  return parseAnswersJson(rawText);
}

/**
 * Calls the Gemini API, automatically retrying on transient errors
 * (503 "model overloaded", 429 rate limit) with exponential backoff.
 * These are temporary server-side conditions, not bugs in the request,
 * so a short wait-and-retry usually succeeds without any user action.
 */
async function callGeminiWithRetry(prompt, apiKey, maxRetries = 4) {
  const retryableStatuses = [429, 503];
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(GEMINI_ENDPOINT(GEMINI_MODEL, apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          // Ask Gemini to guarantee valid JSON output directly, instead of
          // relying purely on prompt instructions (Gemini 1.5+ supports this).
          responseMimeType: 'application/json',
        },
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Gemini returned no usable content.');
      return rawText;
    }

    const errBody = await response.text();
    lastError = new Error(`Gemini API error (${response.status}): ${errBody.slice(0, 300)}`);

    const shouldRetry = retryableStatuses.includes(response.status) && attempt < maxRetries;
    if (!shouldRetry) throw lastError;

    // Exponential backoff with jitter: ~1s, 2s, 4s, 8s (+/- randomness)
    const delayMs = Math.round(1000 * 2 ** attempt * (0.75 + Math.random() * 0.5));
    console.warn(
      `[AI Autofill] Gemini ${response.status}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError;
}

/**
 * Crucial prompt engineering: instructs Gemini to act as an application
 * assistant and return ONLY a flat JSON object whose keys exactly match
 * each field's `identifier` (the name/id we scraped from the DOM), and
 * whose values are the text/selection to put in that field.
 */
function buildPrompt({ resumeText, jobDescription, fields }) {
  const fieldDescriptions = fields
    .map((f) => {
      const optionsNote = f.options?.length ? ` | available options: ${JSON.stringify(f.options)}` : '';
      return `- identifier: "${f.identifier}" | label: "${f.label}" | type: ${f.tag}/${f.type || 'text'}${optionsNote}`;
    })
    .join('\n');

  return `You are an assistant that fills out job application forms on behalf of a candidate, using their resume as the source of truth.

RESUME TEXT:
"""
${resumeText}
"""

JOB DESCRIPTION:
"""
${jobDescription}
"""

FORM FIELDS TO FILL:
${fieldDescriptions}

INSTRUCTIONS:
1. For each form field listed above, generate an appropriate answer based strictly on the resume content and, where relevant, tailored to the job description (e.g. a short "why are you interested in this role" answer).
2. If a field has "available options" listed (a <select> dropdown), you MUST choose one of those exact option values — do not invent a new one.
3. If you cannot confidently determine an answer for a field from the resume (e.g. a salary expectation not mentioned anywhere), return an empty string "" for that field rather than guessing or inventing false information.
4. Keep free-text answers concise and professional (1-3 sentences), except for fields that are clearly asking for a single fact (name, email, phone, years of experience, etc.), which should just contain that fact.
5. Never fabricate credentials, dates, or experience that are not present in the resume.
6. The resume text may include lines like "[Links on this page: https://...]" — these are hyperlink URLs extracted from icons/buttons in the PDF (e.g. GitHub, LinkedIn, portfolio links) that don't otherwise appear as visible text. Match each URL to the correct field by its domain (e.g. a linkedin.com URL goes in a LinkedIn field, github.com in a GitHub field) and use the bare URL as the answer for that field.

OUTPUT FORMAT:
Return ONLY a single valid JSON object, with no markdown code fences, no explanation, and no extra text before or after it. The JSON keys MUST exactly match the "identifier" values given above. Example shape:

{
  "first_name": "Jane",
  "email": "jane@example.com",
  "why_interested": "Because of my background in..."
}`;
}

function parseAnswersJson(rawText) {
  // Even with responseMimeType: 'application/json', be defensive in case
  // the model wraps the JSON in markdown fences or adds stray whitespace.
  const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Gemini's JSON response: ${err.message}`);
  }
}
