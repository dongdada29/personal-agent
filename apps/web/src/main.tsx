import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AuthGate } from './AuthGate';
import { consumePairingFragment } from './auth-session';
import './styles.css';

// Clear fragments before rendering or making the first session request.
const fragment = { ticket: consumePairingFragment(window.location, window.history) };

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#2563eb',
          borderRadius: 10,
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
          colorText: '#17243e',
        },
      }}
    >
      <AuthGate fragment={fragment} />
    </ConfigProvider>
  </React.StrictMode>,
);
