import { defineConfig } from 'vite';

const startedAt = Date.now();
const STARTUP_GRACE_MS = 5000;
const silenceStartupError = (proxy) => {
    proxy.on('error', (err, _req, _res) => {
        if (Date.now() - startedAt < STARTUP_GRACE_MS) return; // silent during startup
        console.error('[proxy error]', err.message);
    });
};

export default defineConfig({
    root: '.',
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3900',
                changeOrigin: true,
                configure: silenceStartupError,
            },
            '/fapi': {
                target: 'http://localhost:3900',
                changeOrigin: true,
                configure: silenceStartupError,
            },
            '/ws': {
                target: 'ws://localhost:3900',
                ws: true,
                configure: silenceStartupError,
            },
        },
    },
    build: {
        outDir: 'dist',
    },
});
