// popup.js

window.addEventListener('error', (event) => {
  console.error('[AI Autofill] Uncaught error:', event.error || event.message);
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = `Error: ${(event.error || event.message).message || event.message}`;
    statusEl.className = 'error';
  }
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[AI Autofill] Unhandled rejection:', event.reason);
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = `Error: ${event.reason?.message || event.reason || 'Promise rejected'}`;
    statusEl.className = 'error';
  }
});

const apiKeyInput = document.getElementById('apiKey');
const resumeFileInput = document.getElementById('resumeFile');
const resumePreview = document.getElementById('resumePreview');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

let extractedResumeText = '';

try {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
  }
} catch (err) {
  console.warn('[AI Autofill] Could not set pdf.js worker source:', err);
}

function showStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = type;
}

// Restore any previously saved settings when the popup opens
chrome.storage.local.get(['geminiApiKey', 'resumeText', 'resumeFileName'], (data) => {
  try {
    if (data && data.geminiApiKey) apiKeyInput.value = data.geminiApiKey;
    if (data && data.resumeText) {
      extractedResumeText = data.resumeText;
      resumePreview.style.display = 'block';
      resumePreview.textContent =
        `Loaded: ${data.resumeFileName || 'saved resume'} (${data.resumeText.length} chars)`;
    }
  } catch (err) {
    console.error('[AI Autofill] Error restoring saved settings:', err);
  }
});

/**
 * Extracts text from every page of a PDF File object using pdf.js.
 * Handles multi-page documents by iterating over numPages and
 * concatenating each page's text content in order.
 */
async function extractTextFromPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const typedArray = new Uint8Array(arrayBuffer);

  const loadingTask = pdfjsLib.getDocument({ data: typedArray });
  const pdf = await loadingTask.promise;

  let fullText = '';

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Each item is a text fragment with position info; join fragments
    // on the same page with spaces, and separate pages with newlines
    // so the resulting text is readable and preserves rough structure.
    const pageText = textContent.items.map((item) => item.str).join(' ');
    fullText += pageText + '\n\n';

    // Hyperlinks (e.g. "GitHub"/"LinkedIn" icons linking to a profile URL)
    // are stored as Link annotations, NOT as visible text, so
    // getTextContent() alone never sees them — it only reads glyphs
    // actually drawn on the page. Without this, the resume text would
    // contain the word "LinkedIn" but never the URL behind it, so the
    // AI has nothing to put in a "LinkedIn URL" form field. Pulling
    // annotations separately and appending the raw URLs fixes that.
    const annotations = await page.getAnnotations();
    const links = annotations
      .filter((a) => a.subtype === 'Link' && a.url)
      .map((a) => a.url);

    if (links.length > 0) {
      fullText += `[Links on this page: ${links.join(', ')}]\n\n`;
    }

    // Free up memory for this page's resources before moving on
    page.cleanup();
  }

  return fullText.trim();
}

resumeFileInput.addEventListener('change', async () => {
  const file = resumeFileInput.files[0];
  if (!file) return;

  if (file.type !== 'application/pdf') {
    showStatus('Please upload a PDF file.', 'error');
    return;
  }

  try {
    showStatus('Extracting text from PDF...', 'info');
    extractedResumeText = await extractTextFromPdf(file);

    resumePreview.style.display = 'block';
    resumePreview.textContent =
      `Extracted ${extractedResumeText.length} characters from "${file.name}"`;

    showStatus('PDF parsed. Click "Save" to store it.', 'success');
  } catch (err) {
    console.error('PDF extraction failed:', err);
    showStatus(`Failed to read PDF: ${err.message}`, 'error');
  }
});

saveBtn.addEventListener('click', () => {
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    showStatus('Please enter your Gemini API key.', 'error');
    return;
  }
  if (!extractedResumeText) {
    showStatus('Please upload and parse a resume PDF first.', 'error');
    return;
  }

  chrome.storage.local.set(
    {
      geminiApiKey: apiKey,
      resumeText: extractedResumeText,
      resumeFileName: resumeFileInput.files[0]?.name || 'resume.pdf',
    },
    () => {
      if (chrome.runtime.lastError) {
        showStatus(`Save failed: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      showStatus('Saved! You can now use "Fill This Page" on a job application.', 'success');
    }
  );
});

