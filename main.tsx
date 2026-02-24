import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

console.log('[startup] main.tsx loaded');

window.addEventListener('error', (event) => {
  console.error('[runtime:error]', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[runtime:unhandledrejection]', event.reason);
});

const rootElement = document.getElementById('root');

if (!rootElement) {
  console.error('[startup] #root element not found');
  throw new Error('Root element "#root" was not found in index.html');
}

console.log('[startup] mounting React app on #root');
createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);