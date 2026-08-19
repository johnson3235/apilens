import { useState, useEffect } from 'react';
import { CapturedRequest } from '@apilens/shared-types/request';

export function useRequests() {
  const [requests, setRequests] = useState<CapturedRequest[]>([]);

  useEffect(() => {
    // Basic polling or mock data for dev
    const handleMessage = (msg: any) => {
      if (msg.type === 'REQUEST_CAPTURED') {
        setRequests(prev => [...prev, msg.payload].slice(-1000));
      }
      if (msg.type === 'REQUEST_COMPLETED') {
        setRequests(prev => prev.map(r => r.id === msg.payload.id ? msg.payload : r));
      }
    };
    
    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(handleMessage);
      chrome.runtime.sendMessage({ type: 'GET_REQUESTS' }, (response) => {
        if (response) setRequests(response);
      });
    }

    return () => {
      if (chrome && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.removeListener(handleMessage);
      }
    };
  }, []);

  const clearRequests = () => {
    setRequests([]);
    if (chrome && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'CLEAR_REQUESTS' });
    }
  };

  return { requests, clearRequests, requestCount: requests.length };
}
