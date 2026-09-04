/**
 * MemKey 本地密码保险库服务
 * 零依赖：仅使用 Node.js 内置模块
 * 架构：浏览器端加密（零知识），本服务只存取密文文件
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8420;
const HOST = '127.0.0.1'; // 只监听本机，局域网不可访问
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const VAULT_FILE = path.join(DATA_DIR, 'vault.enc');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buf);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 校验密文结构（只认格式，不触碰内容）
function isValidVault(obj) {
  return !!obj && typeof obj === 'object'
    && obj.kdf && typeof obj.kdf.salt === 'string'
    && typeof obj.iv === 'string' && typeof obj.data === 'string';
}

const server = http.createServer(async (req, res) => {
  // 防 DNS rebinding：Host 必须是本机
  const host = (req.headers.host || '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') return sendJSON(res, 403, { error: 'forbidden host' });

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    /* ---------- 密文文件 API ---------- */
    if (url.pathname === '/api/vault') {
      if (req.method === 'GET') {
        try {
          const raw = fs.readFileSync(VAULT_FILE, 'utf8');
          return sendJSON(res, 200, JSON.parse(raw));
        } catch {
          return sendJSON(res, 404, { exists: false });
        }
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 10 * 1024 * 1024);
        let obj;
        try { obj = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'invalid json' }); }
        if (!isValidVault(obj)) return sendJSON(res, 400, { error: 'invalid vault format' });
        fs.mkdirSync(DATA_DIR, { recursive: true });
        // 原子写入：先写临时文件再重命名，避免写一半损坏
        const tmp = VAULT_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(obj));
        fs.renameSync(tmp, VAULT_FILE);
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(VAULT_FILE); } catch {}
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }

    /* ---------- 元信息 ---------- */
    if (url.pathname === '/api/meta') {
      return sendJSON(res, 200, {
        app: 'MemKey',
        version: '1.2.5',
        vaultFile: VAULT_FILE,
        url: `http://localhost:${PORT}`,
      });
    }

    /* ---------- 静态文件 ---------- */
    let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return sendJSON(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return sendJSON(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || 'internal error' });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[MemKey] 端口 ${PORT} 已被占用，服务可能已在运行，直接打开浏览器…`);
    exec(`start http://localhost:${PORT}`);
    process.exit(0);
  }
  console.error('[MemKey] 启动失败：', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('========================================');
  console.log('  MemKey 本地密码保险库服务已启动');
  console.log(`  访问地址：http://localhost:${PORT}`);
  console.log(`  数据文件：${VAULT_FILE}`);
  console.log('  停止服务：关闭本窗口或按 Ctrl+C');
  console.log('========================================');
  if (process.argv.includes('--open')) exec(`start http://localhost:${PORT}`);
});
