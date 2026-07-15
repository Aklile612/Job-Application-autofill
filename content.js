// content.js
// Runs in the context of the job application page. Responsible for:
//  1. Scraping the job description text
//  2. Finding fillable form fields and figuring out their labels
//  3. Asking the background script for AI-generated answers
//  4. Injecting those answers back into the actual DOM elements

(() => {
  // Avoid double-injecting listeners if the script somehow runs twice
  if (window.__aiAutofillInjected) return;
  window.__aiAutofillInjected = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_AUTOFILL') {
      runAutofill().catch((err) => console.error('[AI Autofill] failed:', err));
      sendResponse({ started: true });
    }
    // Return true if we ever respond asynchronously elsewhere
  });

  async function runAutofill() {
    const jobDescription = scrapeJobDescription();
    const fields = scrapeFormFields();

    if (fields.length === 0) {
      console.warn('[AI Autofill] No fillable fields found on this page.');
      return;
    }

    // Ask the background service worker to call Gemini. This has to go
    // through background.js rather than fetch() here, because Gemini's
    // API does not send permissive CORS headers for arbitrary page
    // origins — the background service worker context is not subject
    // to the page's CORS restrictions the same way.
    const response = await chrome.runtime.sendMessage({
      type: 'GENERATE_ANSWERS',
      payload: { jobDescription, fields },
    });

    if (!response?.success) {
      console.error('[AI Autofill] Gemini request failed:', response?.error);
      alert(`AI Autofill failed: ${response?.error || 'Unknown error'}`);
      return;
    }

    fillFormFields(fields, response.answers);
  }

  /**
   * Scrapes the page for job description text. Different sites use
   * different containers, so we try a prioritized list of common
   * selectors before falling back to the page body.
   */
  function scrapeJobDescription() {
    const candidateSelectors = [
      // LinkedIn
      '.jobs-description__content',
      '.jobs-box__html-content',
      // Indeed
      '#jobDescriptionText',
      // Greenhouse
      '#content .job__description',
      '#app-body',
      // Lever
      '.posting-page .section-wrapper',
      // Workday
      '[data-automation-id="jobPostingDescription"]',
      // Generic fallbacks
      '[class*="job-description"]',
      '[id*="job-description"]',
      'article',
      'main',
    ];

    for (const selector of candidateSelectors) {
      const el = document.querySelector(selector);
      if (el && el.innerText && el.innerText.trim().length > 100) {
        return el.innerText.trim().slice(0, 8000); // cap length sent to the model
      }
    }

    // Last resort: use the whole visible body text, trimmed down
    return document.body.innerText.trim().slice(0, 8000);
  }

  /**
   * Finds all input/textarea/select elements that look like they belong
   * to an application form, and figures out a human-readable label for
   * each one using a cascade of strategies.
   */
  function scrapeFormFields() {
    const elements = Array.from(document.querySelectorAll('input, textarea, select'));

    const fields = [];

    elements.forEach((el, index) => {
      // Skip hidden, disabled, or non-fillable inputs
      const type = (el.type || '').toLowerCase();
      const skipTypes = ['hidden', 'submit', 'button', 'reset', 'image', 'file'];
      if (skipTypes.includes(type)) return;
      if (el.disabled || el.readOnly) return;
      if (!isElementVisible(el)) return;

      const identifier = el.name || el.id || `field_${index}`;
      // Ensure every field has a stable identifier we can map answers back to,
      // even if the page didn't give it a name/id.
      if (!el.id && !el.name) {
        el.setAttribute('data-ai-autofill-id', identifier);
      }

      const label = findLabelForElement(el);

      fields.push({
        identifier,
        label,
        tag: el.tagName.toLowerCase(),
        type: type || null,
        options:
          el.tagName.toLowerCase() === 'select'
            ? Array.from(el.options).map((o) => o.value || o.text)
            : undefined,
      });
    });

    return fields;
  }

  function isElementVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    );
  }

  /**
   * Robust label matching. Tries, in order:
   *   1. <label for="id"> pointing at this element
   *   2. A wrapping <label> that contains this element
   *   3. aria-label / aria-labelledby
   *   4. placeholder attribute
   *   5. The nearest preceding text node / heading in the DOM (fallback
   *      for sites that build custom "label-like" divs instead of
   *      semantic <label> elements — very common on Workday/Greenhouse)
   */
  function findLabelForElement(el) {
    // 1. Explicit <label for="...">
    if (el.id) {
      const explicitLabel = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (explicitLabel?.innerText.trim()) {
        return explicitLabel.innerText.trim();
      }
    }

    // 2. Wrapping <label>
    const parentLabel = el.closest('label');
    if (parentLabel?.innerText.trim()) {
      return parentLabel.innerText.trim();
    }

    // 3. ARIA attributes
    if (el.getAttribute('aria-label')) {
      return el.getAttribute('aria-label').trim();
    }
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelledEl = document.getElementById(labelledBy);
      if (labelledEl?.innerText.trim()) return labelledEl.innerText.trim();
    }

    // 4. Placeholder as a last-resort semantic hint
    if (el.placeholder) {
      return el.placeholder.trim();
    }

    // 5. Walk up a few ancestor levels looking for the nearest text
    //    that appears to precede this field (common in custom form UIs)
    let node = el;
    for (let depth = 0; depth < 4 && node; depth++) {
      node = node.parentElement;
      if (!node) break;

      const heading = node.querySelector('label, legend, [class*="label"], h1, h2, h3, h4, p');
      if (heading?.innerText.trim() && heading.innerText.trim().length < 200) {
        return heading.innerText.trim();
      }
    }

    return el.name || el.id || 'Unknown field';
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/([^\w-])/g, '\\$1');
  }

  /**
   * Writes AI-generated answers back into the actual DOM elements,
   * dispatching input/change events so frameworks like React
   * (used heavily by LinkedIn, Workday, Greenhouse) pick up the change.
   */
  function fillFormFields(fields, answers) {
    fields.forEach((field) => {
      const value = answers[field.identifier];
      if (value === undefined || value === null || value === '') return;

      const el =
        document.getElementById(field.identifier) ||
        document.querySelector(`[name="${cssEscape(field.identifier)}"]`) ||
        document.querySelector(`[data-ai-autofill-id="${cssEscape(field.identifier)}"]`);

      if (!el) return;

      setNativeValue(el, value);
    });
  }

  /**
   * Sets a value on an input/textarea/select in a way that survives
   * React/Vue's virtual DOM diffing. Directly setting `.value` alone
   * often gets silently reverted by these frameworks because they
   * track state separately from the DOM; using the native setter +
   * dispatching a real 'input' event mimics genuine user typing.
   */
  function setNativeValue(el, value) {
    const tag = el.tagName.toLowerCase();

    if (tag === 'select') {
      const matchingOption = Array.from(el.options).find(
        (o) => o.value === value || o.text === value
      );
      if (matchingOption) {
        el.value = matchingOption.value;
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = value === true || value === 'true' || value === 'yes';
      el.dispatchEvent(new Event('click', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const prototype = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
})();
