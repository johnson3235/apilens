export type MessageType =
  | 'REQUEST_CAPTURED'
  | 'REQUEST_COMPLETED'
  | 'RULE_ADDED'
  | 'RULE_REMOVED'
  | 'RULE_UPDATED'
  | 'RULES_SYNC'
  | 'SCENARIO_ACTIVATED'
  | 'SCENARIO_DEACTIVATED'
  | 'TRACE_RECEIVED'
  | 'SESSION_STARTED'
  | 'SESSION_ENDED'
  | 'CLEAR_REQUESTS'
  | 'GET_REQUESTS'
  | 'GET_RULES'
  | 'CDP_MOCK_ENABLED'
  | 'CDP_MOCK_DISABLED';

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload: T;
  tabId?: number;
  timestamp: number;
}

export function sendMessage<T>(type: MessageType, payload: T, tabId?: number): void {
  const msg: ExtensionMessage<T> = {
    type,
    payload,
    tabId,
    timestamp: Date.now()
  };
  chrome.runtime.sendMessage(msg).catch(() => {
    // Ignore errors when no listener exists
  });
}

export function sendToBackground<T>(type: MessageType, payload: T): void {
  sendMessage(type, payload);
}

export function sendToDevTools<T>(type: MessageType, payload: T, tabId: number): void {
  const msg: ExtensionMessage<T> = {
    type,
    payload,
    tabId,
    timestamp: Date.now()
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

export function onMessage<T>(
  type: MessageType,
  callback: (payload: T, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => void
): () => void {
  const listener = (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ) => {
    if (message && message.type === type) {
      callback(message.payload as T, sender, sendResponse);
    }
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}
