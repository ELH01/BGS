import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs alongside on 3001. Proxying keeps the browser talking to a
    // single origin, so the session cookie is same-site in development too.
    proxy: {
      '/api': {
        target: process.env['API_URL'] ?? 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
});
