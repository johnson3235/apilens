export interface MockResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: any;
  delayMs?: number;
  shouldBlock?: boolean;
  errorReason?: string;
}

export async function attachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    console.error(`Failed to attach debugger to tab ${tabId}:`, error);
    throw error;
  }
}

export async function detachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    console.error(`Failed to detach debugger from tab ${tabId}:`, error);
  }
}

export async function enableFetchInterception(tabId: number, patterns: Array<{urlPattern: string}>): Promise<void> {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: patterns.map(p => ({
        urlPattern: p.urlPattern,
        requestStage: 'Request'
      }))
    });
  } catch (error) {
    console.error(`Failed to enable Fetch interception for tab ${tabId}:`, error);
    throw error;
  }
}

export async function disableFetchInterception(tabId: number): Promise<void> {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable');
  } catch (error) {
    console.error(`Failed to disable Fetch interception for tab ${tabId}:`, error);
  }
}

export async function fulfillRequest(tabId: number, requestId: string, response: MockResponse): Promise<void> {
  try {
    const headers = response.headers ? 
      Object.entries(response.headers).map(([name, value]) => ({ name, value })) : [];
    
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: response.statusCode,
      responseHeaders: headers,
      body: response.body ? btoa(typeof response.body === 'string' ? response.body : JSON.stringify(response.body)) : undefined
    });
  } catch (error) {
    console.error(`Failed to fulfill request ${requestId}:`, error);
  }
}

export async function failRequest(tabId: number, requestId: string, errorReason: string): Promise<void> {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', {
      requestId,
      errorReason
    });
  } catch (error) {
    console.error(`Failed to fail request ${requestId}:`, error);
  }
}

export async function continueRequest(tabId: number, requestId: string): Promise<void> {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', {
      requestId
    });
  } catch (error) {
    console.error(`Failed to continue request ${requestId}:`, error);
  }
}
