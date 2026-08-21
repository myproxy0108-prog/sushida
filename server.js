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
// 2. 寿司打 偽装プロキシ
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

// ルートアクセス時は直接ゲーム画面へリダイレクト
app.get('/', (req, res) => {
    res.redirect('/play.html');
});

// ★ ボディパーサーは挟まず、ストリームを直接中継してハングアップを防止
app.all('*', (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const currentHost = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';

    // 寿司打本家向けの完全偽装リクエストヘッダー
    const outgoingHeaders = {
        ...req.headers,
        'host': TARGET_HOST,
        'origin': TARGET_ORIGIN,
        'referer': `${TARGET_ORIGIN}/play.html`,
    };
    delete outgoingHeaders['connection'];

    // HTMLのみ置換のため非圧縮で要求
    const isHtml = req.path === '/' || req.path.endsWith('.html') || (req.headers['accept'] && req.headers['accept'].includes('text/html') && !req.path.includes('.'));
    if (isHtml) {
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

        // 埋め込み制限・セキュリティヘッダーを解除
        delete headers['content-security-policy'];
        delete headers['x-frame-options'];
        delete headers['strict-transport-security'];

        // CORSを全開放（アセットの読み込みブロック対策）
        headers['access-control-allow-origin'] = '*';
        headers['access-control-allow-methods'] = 'GET, POST, OPTIONS, HEAD';
        headers['access-control-allow-headers'] = '*';

        const contentType = proxyRes.headers['content-type'] || '';

        // ★ HTMLファイルの場合のみ：リンク書き換えと偽装スクリプトを注入
        if (isHtml && contentType.includes('text/html')) {
            let body = '';
            proxyRes.setEncoding('utf-8');
            proxyRes.on('data', chunk => { body += chunk; });
            proxyRes.on('end', () => {
                // 本家のURLを自ホストに書き換え
                body = body.replace(new RegExp(`https?:\/\/${TARGET_HOST}`, 'gi'), `${protocol}://${currentHost}`);
                body = body.replace(/http:\/\/typingx0\.net\/sushida/gi, `${protocol}://${currentHost}`);
                body = body.replace(new RegExp(`\/\/${TARGET_HOST}`, 'g'), `//${currentHost}`);

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

        // ★ Unity WebGLゲーム本体（.unityweb, .wasm, .data, .js, 音声, 画像等）
        // 寿司打が返したオリジナルのContent-Type・Content-Encodingのままブラウザに直接ストリーム転送
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
        if (!res.headersSent) res.status(502).send('Proxy Connection Error');
    });

    // GET / HEAD は即座にリクエストを確定（通信詰まり・ハングアップの解消）
    if (req.method === 'GET' || req.method === 'HEAD') {
        proxyReq.end();
    } else {
        req.pipe(proxyReq);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sushida Fixed Engine Online on port ${PORT}`));
