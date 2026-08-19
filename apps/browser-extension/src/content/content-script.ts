// Content script injected into every page
const script = document.createElement('script');
script.textContent = `
  (function() {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const startTime = Date.now();
      const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && typeof args[0] === 'object' ? (args[0] as Request).url : '');
      const reqMethod = (args[1] && args[1].method) || 'GET';
      
      try {
        const response = await originalFetch.apply(this, args);
        const endTime = Date.now();
        
        window.postMessage({
          type: '__APILENS_FETCH_OBSERVE',
          payload: {
            url: reqUrl,
            method: reqMethod,
            status: response.status,
            duration: endTime - startTime
          }
        }, '*');
        
        return response;
      } catch (error) {
        window.postMessage({
          type: '__APILENS_FETCH_OBSERVE',
          payload: {
            url: reqUrl,
            method: reqMethod,
            status: 0,
            error: error instanceof Error ? error.message : String(error)
          }
        }, '*');
        throw error;
      }
    };
    
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(...args) {
      this._apilens_method = args[0];
      this._apilens_url = args[1];
      this._apilens_startTime = Date.now();
      
      this.addEventListener('load', function() {
        window.postMessage({
          type: '__APILENS_XHR_OBSERVE',
          payload: {
            url: this._apilens_url,
            method: this._apilens_method,
            status: this.status,
            duration: Date.now() - this._apilens_startTime
          }
        }, '*');
      });
      
      originalXhrOpen.apply(this, args);
    };
  })();
`;
document.documentElement.appendChild(script);
script.remove();

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || typeof event.data !== 'object') return;
  
  if (event.data.type === '__APILENS_FETCH_OBSERVE' || event.data.type === '__APILENS_XHR_OBSERVE') {
    // Send to background script if needed
    // chrome.runtime.sendMessage(...)
  }
});
