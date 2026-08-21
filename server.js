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
// 2. プロキシ内部パスの干渉防止
// ==========================================
const UV_DYNAMIC_PATHS = [
    '/proxy', '/prxy', '/baremux', '/epoxy', '/libcurl', 
    '/register-sw.mjs', '/uv', '/~uv', '/bare'
];

app.use((req, res, next) => {
    if (UV_DYNAMIC_PATHS.some(p => req.path.startsWith(p))) {
        return res.status(404).end();
    }
    next();
});

// ==========================================
// 3. 寿司打 プロキシ処理 (sushida.net)
// ==========================================
const TARGET_HOST = "sushida.net";
const TARGET_BASE = `https://${TARGET_HOST}`;

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 512, timeout: 60000 });

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// 寿司打用の軽量インジェクション（枠のズレ防止・不要広告枠の非表示など）
const INJECT_CODE = `
<style>
  /* プレイ画面以外の不要な広告枠や邪魔な要素を非表示 */
  iframe[src*="doubleclick"], iframe[src*="google"], .adsbygoogle { display: none !important; }
</style>
<script>
  (function() {
    // 外部リンクがプロキシの外に出てしまうのを防ぐ（同一オリジンを維持）
    window.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('a').forEach(a => {
        if (a.href && a.href.includes('${TARGET_HOST}')) {
          a.href = a.href.replace('https://${TARGET_HOST}', window.location.origin);
        }
      });
    });
  })();
</script>
`;

app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const targetUrl = TARGET_BASE + req.url;
    const currentHost = req.get('host');

    const h = { ...req.headers };
    delete h.host;
    delete h.connection;
    delete h['content-length']; 
    h['Origin'] = TARGET_BASE;
    h['Referer'] = TARGET_BASE + '/';
    h['Accept-Encoding'] = 'identity'; 

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: h,
            agent: proxyAgent,
            compress: true, 
            redirect: 'manual', 
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
            timeout: 20000 
        });

        let resHeaders = {};
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            // セキュリティヘッダーや圧縮関連を解除して転送
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options', 'strict-transport-security'].includes(key)) {
                resHeaders[key] = v;
            }
        });

        // リダイレクト時のURL書き換え
        if (resHeaders['location']) {
            resHeaders['location'] = resHeaders['location'].replace(new RegExp(`https:\/\/[a-z0-9.-]*${TARGET_HOST}`, 'gi'), `https://${currentHost}`);
        }

        // Cookieのドメイン書き換え
        if (resHeaders['set-cookie']) {
            let cookies = response.headers.raw()['set-cookie'];
            resHeaders['set-cookie'] = cookies.map(cookie => {
                let clean = cookie.replace(new RegExp(`domain=\\.?[a-z0-9.-]*${TARGET_HOST};?`, 'gi'), "");
                clean = clean.replace(/SameSite=(Lax|Strict)/gi, "SameSite=None");
                if (!clean.includes("Secure")) clean += "; Secure";
                return clean;
            });
        }

        const contentType = response.headers.get("content-type") || "";

        // HTML のドメイン書き換えとスクリプト挿入
        if (contentType.includes("text/html")) {
            let text = await response.text();

            text = text.replace(new RegExp(`https:\/\/[a-z0-9.-]*${TARGET_HOST}`, 'gi'), `https://${currentHost}`);
            text = text.replace(new RegExp(`\/\/${TARGET_HOST}`, 'g'), `//${currentHost}`);

            if (text.includes('<head>')) {
                text = text.replace('<head>', '<head>' + INJECT_CODE);
            } else {
                text = INJECT_CODE + text;
            }

            res.set(resHeaders);
            res.set("Content-Type", "text/html; charset=utf-8");
            return res.status(response.status).send(text);
        }

        // CSS 内のパス書き換え
        if (contentType.includes("css")) {
            let cssText = await response.text();
            cssText = cssText.replace(new RegExp(`https:\/\/[a-z0-9.-]*${TARGET_HOST}`, 'gi'), `https://${currentHost}`);
            res.set(resHeaders);
            return res.status(response.status).send(cssText);
        }

        // JS / 画像 / 音声 / Canvasアセット等はそのままストリーミング
        res.set(resHeaders);
        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sushida Proxy Engine Online on port ${PORT}`));
