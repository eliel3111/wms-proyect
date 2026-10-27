import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthProvider.tsx";
import './index.css'
import App from './App.tsx'

import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";


ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />     
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
