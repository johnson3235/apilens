import React from 'react';
import { createRoot } from 'react-dom/client';
import PopupApp from './PopupApp';

// Import CSS for bundler
import './popup.css';

// Dynamic CSS injector to guarantee styles in Chrome/Edge Extension Popup
const injectStyles = () => {
  if (typeof document !== 'undefined' && !document.getElementById('vois-theme-styles')) {
    const link = document.createElement('link');
    link.id = 'vois-theme-styles';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('assets/popup.css');
    document.head.appendChild(link);
  }
};

injectStyles();

const container = document.getElementById('popup-root');
if (container) {
  const root = createRoot(container);
  root.render(<PopupApp />);
}
