document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('lookupForm');
  const studentNumberInput = document.getElementById('studentNumber');
  const submitBtn = document.getElementById('submitBtn');
  const loadingIndicator = document.getElementById('loadingIndicator');
  const errorMessage = document.getElementById('errorMessage');
  const resultArea = document.getElementById('resultArea');
  const resultUsername = document.getElementById('resultUsername');
  const resultPlaintext = document.getElementById('resultPlaintext');

  let isSubmitting = false;

  // Real-time input filtering to allow digits only while preserving string & leading zeros
  studentNumberInput.addEventListener('input', () => {
    const cleaned = studentNumberInput.value.replace(/\D/g, '');
    if (studentNumberInput.value !== cleaned) {
      studentNumberInput.value = cleaned;
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

  function showResult(username, plaintext) {
    resultUsername.textContent = username;
    resultPlaintext.textContent = plaintext;
    resultArea.hidden = false;
  }

  function hideResult() {
    resultUsername.textContent = '';
    resultPlaintext.textContent = '';
    resultArea.hidden = true;
  }

  function setLoading(loading) {
    isSubmitting = loading;
    submitBtn.disabled = loading;
    studentNumberInput.disabled = loading;
    if (loadingIndicator) {
      loadingIndicator.hidden = !loading;
    }
    submitBtn.textContent = loading ? 'Processing...' : 'Submit';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // 1. Prevent duplicate submissions while processing
    if (isSubmitting) {
      return;
    }

    // 9. Clear stale results and errors when a new lookup begins
    hideError();
    hideResult();

    const inputValue = studentNumberInput.value.trim();

    // Client-side validation: must be exactly 10 digits
    if (inputValue.length !== 10 || !/^\d{10}$/.test(inputValue)) {
      showError('Please enter a valid 10-digit number.');
      studentNumberInput.focus();
      return;
    }

    // 2 & 3. Disable button & show loading indicator
    setLoading(true);

    try {
      // Connect to relative backend URL
      const response = await fetch('/api/lookup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          studentNumber: inputValue,
        }),
      });

      // 4. Parse backend response safely
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('The lookup service is temporarily unavailable. Please try again.');
      }

      // 5. Check both HTTP status and success property
      if (!response.ok || !data || data.success !== true) {
        // 7. Display clear error message on failure
        const msg = (data && typeof data.error === 'string' && data.error.trim())
          ? data.error.trim()
          : 'The lookup service is temporarily unavailable. Please try again.';
        showError(msg);
        return;
      }

      // 6 & 10. Display username and plaintext only on success, as text (not injected HTML)
      showResult(data.username, data.plaintext);
    } catch (err) {
      showError(err.message || 'The lookup service is temporarily unavailable. Please try again.');
    } finally {
      // 8. Re-enable button in a finally block
      setLoading(false);
    }
  });
});
