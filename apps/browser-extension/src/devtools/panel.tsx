import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/panel.css';

// Dynamic CSS injector for DevTools panel
const injectStyles = () => {
  if (typeof document !== 'undefined' && !document.getElementById('apilens-panel-styles')) {
    const link = document.createElement('link');
    link.id = 'apilens-panel-styles';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('assets/panel.css');
    document.head.appendChild(link);
  }
};

injectStyles();

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
