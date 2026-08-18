import 'temporal-polyfill/global';

// Self-hosted fonts. These used to come from fonts.googleapis.com, which is
// unreachable on the LAN / airgapped installs this app is deployed to — the
// request would hang and typography would silently fall back to system-ui.
// Weights here must cover the --font-sans / --font-mono usage in index.css.
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';

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
