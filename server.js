const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const app = express();

// ==========================================
// 1. Webプロキシ (Ultraviolet等) の静的配信
// ==========================================
const PROXY_DIR = path.join(__dirname, 'proxy'); 
const PROXY_ENDPOINTS = [
  'prxy', 'baremux', 'epoxy', 'libcurl', 'register-sw.mjs', 'uv'
];

app.get('/proxy', (req, res) => res.redirect('/proxy/'));
app.use('/proxy', express.static(PROXY_DIR));

app.use((req, res, next) => {
    if (res.headersSent) return next();
    const fileName = req.path.replace(/^\//, '');
    if (PROXY_ENDPOINTS.includes(fileName)) {
        const targetPath = path.join(PROXY_DIR, fileName);
        if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile()) {
            return res.sendFile(targetPath);
        }
    }
    next();
});

// ==========================================
// 2. 完全透過プロキシ (sushida.net)
// ==========================================
const TARGET_HOST = "sushida.net";

app.all('*', (req, res) => {
    const headers = { ...req.headers };
    headers.host = TARGET_HOST;
    headers.referer = `https://${TARGET_HOST}/`;
    headers.origin = `https://${TARGET_HOST}`;
    delete headers.connection;

    const proxyReq = https.request({
        hostname: TARGET_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers: headers,
        rejectUnauthorized: false
    }, (proxyRes) => {
        // ヘッダーとステータスをそのままクライアントに返す
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        // レスポンスボディを無加工でそのままパイプ
        proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
        if (!res.headersSent) res.status(502).end();
    });

    // クライアントからのリクエストをそのまま送信
    req.pipe(proxyReq);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Transparent Proxy Online on port ${PORT}`));
