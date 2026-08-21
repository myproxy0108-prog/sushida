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
// 2. 寿司打 ドメイン偽装インジェクション
// ==========================================
const TARGET_HOST = "sushida.net";
const TARGET_ORIGIN = `https://${TARGET_HOST}`;

// ブラウザ内部のドメイン判定・Referrerを「sushida.net」と認識させるパッチ
const SPOOF_SCRIPT = `
<script>
  (function() {
    try {
      Object.defineProperty(document, 'domain', { get: () => '${TARGET_HOST}', configurable: true });
      Object.defineProperty(document, 'referrer', { get: () => '${TARGET_ORIGIN}/', configurable: true });
    } catch(e) {}
  })();
</script>
`;

// トップアクセスは直接ゲーム画面へ
app.get('/', (req, res) => {
    res.redirect('/play.html');
});

// ==========================================
// 3. 高精度リバースプロキシ転送
// ==========================================
app.all('*', (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const currentHost = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';

    // 寿司打が要求する厳密なリクエストヘッダーを作成
    const outgoingHeaders = {
        ...req.headers,
        'host': TARGET_HOST,
        'origin': TARGET_ORIGIN,
        'referer': `${TARGET_ORIGIN}/play.html`,
        'sec-fetch-dest': req.headers['sec-fetch-dest'] || 'empty',
        'sec-fetch-mode': req.headers['sec-fetch-mode'] || 'cors',
        'sec-fetch-site': 'same-origin'
    };
    delete outgoingHeaders['connection'];

    // HTMLリクエスト時のみ置換を行うため非圧縮を要求
    const isHtmlRequest = req.path.endsWith('.html') || (!req.path.includes('.') && req.headers['accept']?.includes('text/html'));
    if (isHtmlRequest) {
        outgoingHeaders['accept-encoding'] = 'identity';
    }

    const options = {
        hostname: TARGET_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers: outgoingHeaders,
        rejectUnauthorized: false
    };

    const proxyReq = https.request(options, (proxyRes) => {
        let headers = { ...proxyRes.headers };

        // 制限ヘッダーを解除
        delete headers['content-security-policy'];
        delete headers['x-frame-options'];
        delete headers['strict-transport-security'];

        // CORS対応
        headers['access-control-allow-origin'] = '*';
        headers['access-control-allow-methods'] = 'GET, POST, OPTIONS, HEAD';
        headers['access-control-allow-headers'] = '*';

        // MIMEタイプの補正（Unity WebGL用）
        if (req.path.endsWith('.wasm') || req.path.endsWith('.wasm.unityweb')) {
            headers['content-type'] = 'application/wasm';
        } else if (req.path.endsWith('.data') || req.path.endsWith('.data.unityweb')) {
            headers['content-type'] = 'application/octet-stream';
        } else if (req.path.endsWith('.js') || req.path.endsWith('.js.unityweb')) {
            headers['content-type'] = 'application/javascript';
        } else if (req.path.endsWith('.json') || req.path.endsWith('.json.unityweb')) {
            headers['content-type'] = 'application/json';
        }

        const contentType = headers['content-type'] || '';

        // ★ HTMLの場合：偽装スクリプトを注入＆リンク置換
        if (contentType.includes('text/html')) {
            let body = '';
            proxyRes.setEncoding('utf-8');
            proxyRes.on('data', chunk => body += chunk);
            proxyRes.on('end', () => {
                // 本家URLを現在のプロキシURLに置換
                body = body.replace(new RegExp(`https?:\/\/${TARGET_HOST}`, 'gi'), `${protocol}://${currentHost}`);
                body = body.replace(/http:\/\/typingx0\.net\/sushida/gi, `${protocol}://${currentHost}`);
                body = body.replace(new RegExp(`\/\/${TARGET_HOST}`, 'g'), `//${currentHost}`);

                // 先頭に偽装スクリプトを挿入
                if (body.includes('<head>')) {
                    body = body.replace('<head>', '<head>' + SPOOF_SCRIPT);
                } else {
                    body = SPOOF_SCRIPT + body;
                }

                delete headers['content-length'];
                res.writeHead(proxyRes.statusCode, headers);
                res.end(body);
            });
            return;
        }

        // ★ ゲーム本体（WebGLバイナリ・音声・画像等）は1バイトも劣化させずパイプ転送
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) res.status(502).send('Proxy Connection Error');
    });

    req.pipe(proxyReq);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sushida Full-Spoof Proxy Engine Online on port ${PORT}`));
