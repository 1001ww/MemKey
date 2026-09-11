/**
 * MemKey 本地密码保险库服务
 * 零依赖：仅使用 Node.js 内置模块
 * 架构：浏览器端加密（零知识），本服务只存取密文文件
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 8420;
const HOST = '127.0.0.1'; // 只监听本机，局域网不可访问
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const VAULT_FILE = path.join(DATA_DIR, 'vault.enc');
const SNAP_DIR = path.join(DATA_DIR, 'snap');
const SNAP_LIMIT = 20;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SNAP_ID_RE = /^\d{8}T\d{9}Z-[a-f0-9]{8}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, code, obj, headers = {}) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = err => { if (settled) return; settled = true; reject(err); };
    req.on('data', c => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        const e = new Error('too large');
        e.statusCode = 413;
        req.removeAllListeners('data');
        req.resume();
        fail(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', fail);
  });
}

// 校验密文结构（只认格式，不触碰内容）
// v1：整库由主密码密钥加密（iv + data）
// v2：数据密钥 DK 加密整库（vault），主密码包裹 DK（wpw）；恢复码信封（rec）与提示（hint）为可选外壳字段
function isValidVault(obj) {
  if (!obj || typeof obj !== 'object'
    || !obj.kdf || typeof obj.kdf.salt !== 'string') return false;
  if (obj.vault || obj.wpw) {
    return !!(obj.wpw && typeof obj.wpw.iv === 'string' && typeof obj.wpw.data === 'string'
      && obj.vault && typeof obj.vault.iv === 'string' && typeof obj.vault.data === 'string');
  }
  return typeof obj.iv === 'string' && typeof obj.data === 'string';
}

function etagFor(raw) {
  return '"' + crypto.createHash('sha256').update(raw).digest('hex') + '"';
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
}

function writeAtomic(file, raw) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, raw);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(dir);
}

function readExistingVault() {
  try {
    const raw = fs.readFileSync(VAULT_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!isValidVault(obj)) throw new Error('invalid vault format');
    return { raw, obj, etag: etagFor(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    const e = new Error('vault read failed');
    e.statusCode = 500;
    throw e;
  }
}

function snapshotId() {
  return new Date().toISOString().replace(/[-:.]/g, '') + '-' + crypto.randomBytes(4).toString('hex');
}

// 生成路径：仅接受内部 snapshotId() 生成的 id（格式白名单），用于新建快照文件
function snapshotPath(id) {
  return (typeof id === 'string' && SNAP_ID_RE.test(id))
    ? path.join(SNAP_DIR, `${id}.enc`)
    : null;
}

// 校验外部 id（恢复接口）：id 必须匹配严格格式，且「id.enc」必须真实出现在
// readdir 的目录清单中（清单条目不可能含路径分隔符），因此不存在路径穿越可能
function snapshotFile(id) {
  if (typeof id !== 'string' || !SNAP_ID_RE.test(id)) return null;
  const name = `${id}.enc`;
  let names;
  try {
    names = fs.readdirSync(SNAP_DIR);
  } catch {
    return null;
  }
  return names.includes(name) ? path.join(SNAP_DIR, name) : null;
}

function listSnapshots() {
  try {
    return fs.readdirSync(SNAP_DIR, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.enc'))
      .map(d => {
        const id = d.name.slice(0, -4);
        if (!SNAP_ID_RE.test(id)) return null;
        const stat = fs.statSync(path.join(SNAP_DIR, d.name));
        return { id, createdAt: stat.mtimeMs, size: stat.size };
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function pruneSnapshots() {
  for (const snap of listSnapshots().slice(SNAP_LIMIT)) {
    fs.unlinkSync(snapshotFile(snap.id));
  }
}

function snapshotCurrent(current) {
  if (!current) return null;
  const file = snapshotPath(snapshotId());
  if (!file) throw new Error('snapshot id invalid');
  writeAtomic(file, current.raw);
  pruneSnapshots();
  return path.basename(file, '.enc');
}

function requireMatch(req, current) {
  const requested = req.headers['if-match'];
  return !requested || !!current && String(requested) === current.etag;
}

function conflict(res, current) {
  return sendJSON(res, 409, { error: 'vault changed' }, current ? { ETag: current.etag } : {});
}

function clearVaultAndSnapshots() {
  try { fs.unlinkSync(VAULT_FILE); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  fs.rmSync(SNAP_DIR, { recursive: true, force: true });
  fsyncDir(DATA_DIR);
}

function restoreSnapshot(snapshot, current) {
  const file = snapshotFile(snapshot.id);
  if (!file) return null;
  const raw = fs.readFileSync(file, 'utf8');
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!isValidVault(obj)) return null;
  snapshotCurrent(current);
  writeAtomic(VAULT_FILE, raw);
  return raw;
}

const server = http.createServer(async (req, res) => {
  // 防 DNS rebinding：Host 必须是本机
  const host = (req.headers.host || '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') return sendJSON(res, 403, { error: 'forbidden host' });

  try {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      return sendJSON(res, 400, { error: 'bad request' });
    }
    /* ---------- 密文快照 API ---------- */
    if (url.pathname === '/api/snapshots') {
      if (req.method === 'GET') return sendJSON(res, 200, { snapshots: listSnapshots(), limit: SNAP_LIMIT });
      return sendJSON(res, 405, { error: 'method not allowed' });
    }

    if (url.pathname === '/api/snapshot-restore') {
      if (req.method !== 'PUT') return sendJSON(res, 405, { error: 'method not allowed' });
      const snapshot = listSnapshots().find(item => item.id === url.searchParams.get('id'));
      const current = readExistingVault();
      if (!snapshot || !current) return sendJSON(res, 404, { error: 'snapshot not found' });
      if (!requireMatch(req, current)) return conflict(res, current);
      const raw = restoreSnapshot(snapshot, current);
      if (!raw) return sendJSON(res, 500, { error: 'snapshot restore failed' });
      return sendJSON(res, 200, { ok: true }, { ETag: etagFor(raw) });
    }

    /* ---------- 密文文件 API ---------- */
    if (url.pathname === '/api/vault') {
      if (req.method === 'GET') {
        const current = readExistingVault();
        if (!current) return sendJSON(res, 404, { exists: false });
        return sendJSON(res, 200, current.obj, { ETag: current.etag });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 10 * 1024 * 1024);
        let obj;
        try { obj = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'invalid json' }); }
        if (!isValidVault(obj)) return sendJSON(res, 400, { error: 'invalid vault format' });
        const current = readExistingVault();
        if (!requireMatch(req, current)) return conflict(res, current);
        const raw = JSON.stringify(obj);
        // 覆盖前先写入原始密文快照；快照失败时当前库不会被覆盖。
        snapshotCurrent(current);
        writeAtomic(VAULT_FILE, raw);
        return sendJSON(res, 200, { ok: true }, { ETag: etagFor(raw) });
      }
      if (req.method === 'DELETE') {
        const current = readExistingVault();
        if (current && !requireMatch(req, current)) return conflict(res, current);
        clearVaultAndSnapshots();
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }

    /* ---------- 元信息 ---------- */
    if (url.pathname === '/api/meta') {
      return sendJSON(res, 200, {
        app: 'MemKey',
        version: '1.5.1',
        vaultFile: VAULT_FILE,
        url: `http://localhost:${PORT}`,
      });
    }

    /* ---------- 静态文件 ---------- */
    let rawPath = url.pathname;
    try { rawPath = decodeURIComponent(rawPath); }
    catch { return sendJSON(res, 400, { error: 'bad request path' }); }
    const p = rawPath === '/' ? '/index.html' : rawPath;
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
    sendJSON(res, err.statusCode || 500, { error: err.message || 'internal error' });
  }
});

function openInBrowser(url) {
  // start 是 cmd 内建命令；用参数数组 + 无 shell 方式调用，URL 由常量构成，不经过 shell 解析
  try {
    spawn('cmd', ['/c', 'start', '', url], { shell: false, stdio: 'ignore', detached: false }).unref();
  } catch {}
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[MemKey] 端口 ${PORT} 已被占用，服务可能已在运行，直接打开浏览器…`);
    openInBrowser(`http://localhost:${PORT}`);
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
  if (process.argv.includes('--open')) openInBrowser(`http://localhost:${PORT}`);
});
