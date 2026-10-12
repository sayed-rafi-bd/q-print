import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { CapabilitiesProvider } from './capabilities';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <CapabilitiesProvider>
      <App />
    </CapabilitiesProvider>
  </React.StrictMode>,
);
