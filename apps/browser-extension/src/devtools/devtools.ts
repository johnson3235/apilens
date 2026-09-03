/**
 * DevTools entry point. Its only job is to register the panel; all of the
 * product lives in `panel.tsx`.
 */
chrome.devtools.panels.create('ApiLens', 'icons/icon48.png', 'devtools/panel.html', () => {
  if (chrome.runtime.lastError) {
    console.error('ApiLens could not register its DevTools panel:', chrome.runtime.lastError.message);
  }
});
