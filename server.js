const express = require('express');
const fetch = require('node-fetch');
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
// 2. 寿司打 (sushida.net) 完全透過プロキシ
// ==========================================
const TARGET_HOST = "sushida.net";
const TARGET_BASE = `https://${TARGET_HOST}`;

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 512, timeout: 60000 });

// リクエストボディを受け取る（POST等の場合）
app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const targetUrl = TARGET_BASE + req.url;

    // リクエストヘッダーを調整（sushida.netからのブロックを回避）
    const h = { ...req.headers };
    delete h.host;
    delete h.connection;
    delete h['content-length'];
    h['Origin'] = TARGET_BASE;
    h['Referer'] = TARGET_BASE + '/';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: h,
            agent: proxyAgent,
            redirect: 'follow', // リダイレクトも自動で追従して結果をそのまま返す
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
            timeout: 30000 
        });

        // レスポンスヘッダーの転送（埋め込み制限ヘッダーのみ解除）
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['x-frame-options', 'content-security-policy', 'strict-transport-security'].includes(key)) {
                res.setHeader(k, v);
            }
        });

        // ゲーム素材（音声・スプライト等）の読み込みエラー防止
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
        res.setHeader('Access-Control-Allow-Headers', '*');

        res.status(response.status);

        // ★ HTML・JS・音声・画像・バイナリを一切加工せずそのままクライアントへ流す
        response.body.pipe(res);
        response.body.on('error', () => {
            if (!res.headersSent) res.end();
        });

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Proxy Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sushida Pass-through Proxy Online on port ${PORT}`));
