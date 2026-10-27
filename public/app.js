document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('lookupForm');
  const studentNumberInput = document.getElementById('studentNumber');
  const submitBtn = document.getElementById('submitBtn');
  const loadingIndicator = document.getElementById('loadingIndicator');
  const errorMessage = document.getElementById('errorMessage');
  const resultArea = document.getElementById('resultArea');
  const resultUsername = document.getElementById('resultUsername');
  const resultPassword = document.getElementById('resultPassword');
  const copyUsernameBtn = document.getElementById('copyUsernameBtn');
  const copyPasswordBtn = document.getElementById('copyPasswordBtn');
  const copyFeedback = document.getElementById('copyFeedback');

  let isSubmitting = false;
  let feedbackTimer = null;
  let progressTimer = null;
  let activeAbortController = null;
  let hasPrewarmed = false;

  // Proactive background pre-warming to eliminate serverless cold starts
  function triggerPrewarm() {
    if (hasPrewarmed) return;
    hasPrewarmed = true;
    try {
      fetch('/api/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warmup: true }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // non-blocking
    }
  }

  // Pre-warm on focus or after typing 3 digits
  studentNumberInput?.addEventListener('focus', triggerPrewarm, { once: true });

  // Real-time input filtering to allow digits only while preserving string & leading zeros
  studentNumberInput.addEventListener('input', () => {
    const cleaned = studentNumberInput.value.replace(/\D/g, '');
    if (studentNumberInput.value !== cleaned) {
      studentNumberInput.value = cleaned;
    }
    if (cleaned.length >= 3) {
      triggerPrewarm();
    }
    if (!errorMessage.hidden) {
      hideError();
    }
  });

  function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.hidden = false;
  }

  function hideError() {
    errorMessage.textContent = '';
    errorMessage.hidden = true;
  }

  function showResult(username, password) {
    resultUsername.textContent = username;
    resultPassword.textContent = password;
    resultArea.hidden = false;
    hideCopyFeedback();
  }

  function hideResult() {
    resultUsername.textContent = '';
    resultPassword.textContent = '';
    resultArea.hidden = true;
    hideCopyFeedback();
  }

  function startProgressFeedback() {
    if (progressTimer) clearInterval(progressTimer);
    if (!loadingIndicator) return;
    const labelSpan = loadingIndicator.querySelector('span:not(.spinner)') || loadingIndicator.lastElementChild;
    if (labelSpan) labelSpan.textContent = 'Contacting student directory...';

    let elapsedSeconds = 0;
    progressTimer = setInterval(() => {
      elapsedSeconds++;
      if (!labelSpan) return;
      if (elapsedSeconds === 2) {
        labelSpan.textContent = 'Verifying student records...';
      } else if (elapsedSeconds === 5) {
        labelSpan.textContent = 'Resolving credentials provider...';
      } else if (elapsedSeconds === 9) {
        labelSpan.textContent = 'Securing response payload...';
      }
    }, 1000);
  }

  function stopProgressFeedback() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (loadingIndicator) {
      const labelSpan = loadingIndicator.querySelector('span:not(.spinner)') || loadingIndicator.lastElementChild;
      if (labelSpan) labelSpan.textContent = 'Processing...';
    }
  }

  function setLoading(loading) {
    isSubmitting = loading;
    submitBtn.disabled = loading;
    studentNumberInput.disabled = loading;
    form.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (loadingIndicator) {
      loadingIndicator.hidden = !loading;
    }
    submitBtn.textContent = loading ? 'Processing...' : 'Submit';

    if (loading) {
      startProgressFeedback();
    } else {
      stopProgressFeedback();
    }
  }

  function showCopyFeedback(msg, isError) {
    if (!copyFeedback) return;
    if (feedbackTimer) clearTimeout(feedbackTimer);

    copyFeedback.textContent = msg;
    copyFeedback.className = isError ? 'copy-feedback error' : 'copy-feedback';
    copyFeedback.hidden = false;

    feedbackTimer = setTimeout(() => {
      copyFeedback.textContent = '';
      copyFeedback.hidden = true;
    }, 2500);
  }

  function hideCopyFeedback() {
    if (!copyFeedback) return;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    copyFeedback.textContent = '';
    copyFeedback.hidden = true;
  }

  async function copyToClipboard(text, successMessage, buttonElement) {
    if (!text) return;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers or non-secure contexts
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        textarea.setAttribute('readonly', '');
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!successful) {
          throw new Error('Clipboard write failed');
        }
      }

      showCopyFeedback(successMessage, false);

      if (buttonElement) {
        buttonElement.classList.add('copied');
        setTimeout(() => {
          buttonElement.classList.remove('copied');
        }, 1500);
      }
    } catch (err) {
      showCopyFeedback('Unable to copy to clipboard.', true);
    }
  }

  // Copy Username handler
  if (copyUsernameBtn) {
    copyUsernameBtn.addEventListener('click', () => {
      const username = resultUsername.textContent;
      copyToClipboard(username, 'Username copied!', copyUsernameBtn);
    });
  }

  // Copy Password handler
  if (copyPasswordBtn) {
    copyPasswordBtn.addEventListener('click', () => {
      const password = resultPassword.textContent;
      copyToClipboard(password, 'Password copied!', copyPasswordBtn);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // 1. Prevent duplicate submissions while processing
    if (isSubmitting) {
      return;
    }

    // Clear stale results and errors when a new lookup begins
    hideError();
    hideResult();

    const inputValue = studentNumberInput.value.trim();

    // Client-side validation: must be exactly 10 digits
    if (inputValue.length !== 10 || !/^\d{10}$/.test(inputValue)) {
      showError('Please enter a valid 10-digit number.');
      studentNumberInput.focus();
      return;
    }

    // Cancel any previous pending request if exists
    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = new AbortController();

    // Disable button & show loading indicator
    setLoading(true);

    try {
      const response = await fetch('/api/lookup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          studentNumber: inputValue,
        }),
        signal: activeAbortController.signal,
      });

      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('The lookup service is temporarily unavailable. Please try again.');
      }

      if (!response.ok || !data || data.success !== true) {
        const msg = (data && typeof data.error === 'string' && data.error.trim())
          ? data.error.trim()
          : 'The lookup service is temporarily unavailable. Please try again.';
        showError(msg);
        return;
      }

      // Display username and password safely as text
      showResult(data.username, data.password || data.plaintext);
    } catch (err) {
      if (err.name === 'AbortError') return;
      showError(err.message || 'The lookup service is temporarily unavailable. Please try again.');
    } finally {
      setLoading(false);
    }
  });
});
