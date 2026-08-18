import 'temporal-polyfill/global';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// One-time cleanup: the built-in AI chat was removed — drop its orphaned
// persisted store from localStorage.
localStorage.removeItem('conduit-ai-chat');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
