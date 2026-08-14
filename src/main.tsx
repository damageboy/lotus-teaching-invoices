import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

if (import.meta.env.VITE_LOTUS_E2E === '1') {
  void import('./e2eBridge').then(({ installE2eBridge }) => installE2eBridge());
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
