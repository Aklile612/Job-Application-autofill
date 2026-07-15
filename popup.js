// popup.js
// This popup is deliberately minimal: just the "Fill This Page" action
// and a link to the full-tab settings page. Keeping it minimal means
// there's no native file dialog or long-running work that could trigger
// Chrome's "popup closes on focus loss" behavior.

const fillBtn = document.getElementById('fillBtn');
const statusEl = document.getElementById('status');
const settingsLink = document.getElementById('settingsLink');

function showStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = type;
}

settingsLink.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

fillBtn.addEventListener('click', async () => {
  showStatus('Looking for the form on this page...', 'info');
  fillBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      showStatus('No active tab found.', 'error');
      return;
    }

    const { geminiApiKey, resumeText } = await chrome.storage.local.get([
      'geminiApiKey',
      'resumeText',
    ]);
    if (!geminiApiKey || !resumeText) {
      showStatus('Save your resume and API key first (see link below).', 'error');
      return;
    }

    // Ask the content script on the active tab to start the autofill flow.
    // If content.js isn't already injected (e.g. the site isn't in
    // manifest content_scripts matches), fall back to injecting it now
    // via chrome.scripting, which only requires the activeTab permission.
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'START_AUTOFILL' });
    } catch (err) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'START_AUTOFILL' });
    }

    showStatus('Autofill started — check the page.', 'success');
  } catch (err) {
    console.error(err);
    showStatus(`Could not start autofill: ${err.message}`, 'error');
  } finally {
    fillBtn.disabled = false;
  }
});
