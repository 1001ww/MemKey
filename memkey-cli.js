#!/usr/bin/env node
/**
 * MemKey CLI —— 零依赖命令行接口（完整 CRUD）
 *
 * 与浏览器前端共用 public/vault-crypto.js 的加密实现；本机服务（server.js）
 * 只搬运密文，主密码与明文同样不经过服务端。所有写入携带 ETag（If-Match），
 * 收到 409 立即退出并提示重新读取，绝不自动覆盖。
 *
 * 常用命令：
 *   node memkey-cli.js list
 *   node memkey-cli.js get <名称或ID> [--reveal]
 *   node memkey-cli.js add --title 名称 [--username U] [--password P | --password-stdin] [--gen] [--url U] [--notes N] [--category C] [--tags a,b] [--totp SECRET]
 *   node memkey-cli.js update <ID> [--title T] [--username U] [--password P] [--clear-totp] ...
 *   node memkey-cli.js delete <ID>
 *   node memkey-cli.js trash list | trash restore <回收站ID> | trash purge <ID|all>
 *   node memkey-cli.js health
 *   node memkey-cli.js totp <ID>
 *   node memkey-cli.js snapshots | snapshot-restore <快照ID>
 *
 * 主密码安全：默认从终端隐藏回显输入；脚本化只支持 --master-password-stdin。
 * 绝不接受命令行参数或环境变量中的主密码。
 */
'use strict';

const http = require('http');
const readline = require('readline');
const crypto = require('crypto');
const VC = require('./public/vault-crypto.js');

const PORT_DEFAULT = 8420;
const HOST = '127.0.0.1';
const HIST_MAX = 10;
const TRASH_RETENTION = 30 * 86400e3;
const STALE_MS = 180 * 86400e3;

/* ================= 参数解析 ================= */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--master-password-stdin') { flags.masterPasswordStdin = true; i++; continue; }
    if (a === '--password-stdin') { flags['password-stdin'] = true; i++; continue; }
    if (a === '--reveal') { flags.reveal = true; i++; continue; }
    if (a === '--json') { flags.json = true; i++; continue; }
    if (a === '--gen') {
      // --gen 可带可选长度（--gen 24），不带则用默认长度
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) { flags.gen = next; i += 2; }
      else { flags.gen = true; i++; }
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; i++; }
      else { flags[key] = next; i += 2; }
      continue;
    }
    positional.push(a);
    i++;
  }
  return { positional, flags };
}

function usage(code = 1) {
  process.stderr.write(`MemKey CLI —— 本地密码保险库命令行接口

用法：node memkey-cli.js <命令> [参数] [选项]

命令：
  list                          列出账号（不含密码）
  get <名称或ID> [--reveal]     查看账号详情；--reveal 显示密码（危险操作）
  add --title 名称 [字段...]     新增账号（--gen 生成随机密码；--password-stdin 从标准输入读密码）
  update <ID> [字段...]         更新账号字段（--clear-totp 清除两步验证密钥）
  delete <ID>                   移入回收站（30 天后自动清除）
  trash list                    查看回收站
  trash restore <回收站ID>      从回收站恢复
  trash purge <回收站ID|all>    永久删除
  health                        安全健康度评分
  totp <ID>                     输出当前两步验证码
  snapshots                     列出加密快照
  snapshot-restore <快照ID>     恢复快照（覆盖当前密码库）
  help                          显示本帮助

字段（add / update 通用）：--title --username --password --url --notes --category --tags a,b --totp SECRET

选项：
  --port <n>                    服务端口（默认 ${PORT_DEFAULT}，仅接受本机回环地址）
  --master-password-stdin       从标准输入第一行读取主密码（脚本化专用；与 --password-stdin
                                同用时第二行作为账号密码）
  --reveal                      显示密码明文（get）
  --json                        以 JSON 输出（list / get / health / trash list / snapshots）

安全说明：主密码默认经终端隐藏输入，绝不通过参数或环境变量传递；
所有写入使用 ETag 乐观锁，检测到并发修改（409）会拒绝保存。
`);
  process.exit(code);
}

/* ================= HTTP（固定回环：host 恒为 127.0.0.1，端口经 1-65535 校验，仅本机用户可指定，不构成 SSRF） ================= */
function apiRequest(method, port, pathname, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST,
      port,
      method,
      path: pathname,
      headers: { Host: `localhost:${port}`, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ================= 主密码输入（隐藏回显） ================= */
function askHidden(prompt) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      process.stderr.write('错误：非终端环境请使用 --master-password-stdin\n');
      process.exit(1);
    }
    process.stderr.write(prompt);
    const sink = new (require('stream').Writable)({ write(chunk, enc2, cb) { cb(); } });
    const rl = readline.createInterface({ input: process.stdin, output: sink, terminal: true });
    rl.question('', answer => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}
let stdinLines = null;
// 标准输入按行共享消费：--master-password-stdin 与 --password-stdin 同用时，
// 第一行是主密码，第二行是账号密码
async function nextStdinLine() {
  if (stdinLines === null) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    stdinLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    if (stdinLines.length && stdinLines[stdinLines.length - 1] === '') stdinLines.pop();
  }
  return stdinLines.shift();
}
async function getMasterPassword(flags) {
  if (flags.masterPasswordStdin) {
    const line = (await nextStdinLine()) || '';
    if (!line) { process.stderr.write('错误：标准输入未提供主密码\n'); process.exit(1); }
    return line;
  }
  return askHidden('主密码: ');
}

/* ================= 解锁（与浏览器一致的 v1/v2 规则） ================= */
async function unlockVault(blob, password) {
  const pwBits = await VC.deriveMasterBits(password, VC.unb64(blob.kdf.salt), blob.kdf.iterations);
  const kpw = await VC.masterKeyFromBits(pwBits);
  let vault = null, dkBits;
  if (blob.vault && blob.wpw) {
    const wrap = await VC.decryptJSON(kpw, blob.wpw); // 失败即主密码错误
    dkBits = VC.unb64(wrap.dk);
  } else {
    vault = await VC.decryptJSON(kpw, blob);
    dkBits = new Uint8Array(crypto.getRandomValues(new Uint8Array(32)));
  }
  const dk = await VC.masterKeyFromBits(dkBits);
  if (!vault) vault = await VC.decryptJSON(dk, blob.vault);
  return { vault, dkBits, kpw, pwBits };
}

// 写库前统一外壳：v1 首次写入升级 v2，保留 rec / hint
async function sealBlob(origBlob, vault, dkBits, kpw) {
  const payload = await VC.encryptJSON(await VC.masterKeyFromBits(dkBits), vault);
  if (origBlob.vault && origBlob.wpw) {
    return Object.assign({}, origBlob, { vault: payload });
  }
  // 保留原外壳的迭代数与盐：包裹新 wpw 的 kpw 就是用这套参数派生的，
  // 若此处改写迭代数，重写后的信封将永远无法解开
  const kdf = { name: 'PBKDF2-SHA256', iterations: origBlob.kdf.iterations, salt: origBlob.kdf.salt };
  const wpw = await VC.encryptJSON(kpw, { dk: VC.b64(dkBits) });
  return Object.assign({ v: 2, kdf, wpw, vault: payload }, { rec: origBlob.rec, hint: origBlob.hint });
}

/* ================= 业务辅助 ================= */
function normalizeVault(vault) {
  vault.entries ??= [];
  vault.trash ??= [];
  vault.tags ??= [];
  vault.categories ??= [];
  vault.settings ??= { autoLock: 5 };
  const now = Date.now();
  vault.entries.forEach(e => { e.passwordChangedAt ??= e.updatedAt || e.createdAt || now; });
  return vault;
}
function purgeExpiredTrash(vault, now = Date.now()) {
  const before = vault.trash.length;
  vault.trash = vault.trash.filter(item => now - item.deletedAt < TRASH_RETENTION);
  return vault.trash.length !== before;
}
function findEntry(vault, key) {
  return vault.entries.find(e => e.id === key)
    || vault.entries.find(e => e.title === key)
    || vault.entries.find(e => (e.title || '').toLowerCase() === String(key).toLowerCase());
}
function genPassword(len = 20) {
  const pool = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*()-_=+';
  const out = [];
  const rnd = new Uint32Array(len);
  crypto.getRandomValues(rnd);
  for (let i = 0; i < len; i++) out.push(pool[rnd[i] % pool.length]);
  return out.join('');
}
function maskField(v) { return v ? '******' : ''; }
function printEntry(e, { reveal = false } = {}) {
  const lines = [
    `ID       ${e.id}`,
    `名称     ${e.title}`,
    `用户名   ${e.username || '—'}`,
    `密码     ${reveal ? e.password : maskField(e.password)}`,
    `网址     ${e.url || '—'}`,
    `分类     ${e.category || 'other'}`,
    `标签     ${(e.tags || []).join(', ') || '—'}`,
    `TOTP     ${e.totpSecret ? '已绑定' + (reveal ? `（${e.totpSecret}）` : '') : '—'}`,
    `备注     ${e.notes || '—'}`,
    `改密于   ${e.passwordChangedAt ? new Date(e.passwordChangedAt).toLocaleString('zh-CN') : '—'}`,
    `更新于   ${e.updatedAt ? new Date(e.updatedAt).toLocaleString('zh-CN') : '—'}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

/* ================= 健康度（与前端同口径） ================= */
function passwordStrengthBits(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  let bits = pw.length * Math.log2(pool || 1);
  if (/(.)\1{2,}/.test(pw)) bits *= .85;
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|zxcv)/i.test(pw)) bits *= 0.7;
  if (/(password|admin|letmein|iloveyou|111111|123456|abc123)/i.test(pw)) bits = Math.min(bits, 22);
  if (/^[a-zA-Z]+$/.test(pw)) bits *= .9;
  return bits;
}
function healthReport(vault) {
  const now = Date.now();
  const es = vault.entries;
  // 与前端 analyze() 同口径：分值不足或长度不足 10 位都算弱密码
  const weak = es.filter(e => !e.password || passwordStrengthBits(e.password) < 45 || e.password.length < 10);
  const byPw = {};
  es.forEach(e => { if (e.password) (byPw[e.password] ||= []).push(e); });
  const reusedGroups = Object.values(byPw).filter(a => a.length > 1);
  const reusedCount = reusedGroups.reduce((s, a) => s + a.length, 0);
  const stale = es.filter(e => e.password && (e.passwordChangedAt || 0) && now - e.passwordChangedAt >= STALE_MS);
  const noTotp = es.filter(e => e.password && !e.totpSecret);
  let score = 100;
  const reasons = [];
  if (weak.length) { const n = Math.min(40, weak.length * 8); score -= n; reasons.push(`弱密码 ${weak.length} 个（-${n}）`); }
  if (reusedCount) { const n = Math.min(30, reusedCount * 6); score -= n; reasons.push(`重复使用 ${reusedCount} 个（-${n}）`); }
  if (stale.length) { const n = Math.min(20, stale.length * 4); score -= n; reasons.push(`超过 180 天未改密 ${stale.length} 个（-${n}）`); }
  score = Math.max(0, score);
  const grade = score >= 90 ? '优秀' : score >= 70 ? '良好' : score >= 50 ? '一般' : '需改进';
  return { score, grade, reasons, weak, reusedGroups, reusedCount, stale, noTotp };
}

/* ================= 写库（ETag 乐观锁） ================= */
class ConflictError extends Error {}
async function saveVault(port, etag, blob) {
  const r = await apiRequest('PUT', port, '/api/vault', {
    body: JSON.stringify(blob),
    headers: etag ? { 'If-Match': etag } : {},
  });
  if (r.status === 409) {
    const err = new ConflictError('密码库已在其他窗口或进程中被修改（ETag 冲突）。\n请重新执行命令读取最新数据后再试；CLI 绝不自动覆盖。');
    throw err;
  }
  if (r.status !== 200) throw new Error(`保存失败：HTTP ${r.status} ${r.text || ''}`);
  return r.headers.etag;
}

/* ================= 主流程 ================= */
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const port = flags.port ? Number(flags.port) : PORT_DEFAULT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) { process.stderr.write('错误：--port 必须是 1-65535 的整数\n'); process.exit(1); }
  const cmd = positional[0] || 'help';
  const sub = positional[1];
  // trash 的 <ID> 落在第三个位置（trash <action> <ID>），其余命令在第二个位置
  const arg = cmd === 'trash' ? positional[2] : positional[1];

  // 读库 + 解锁（除 help / snapshots 外都需要）
  let etag = null, blob = null, vault = null, dkBits = null, kpw = null;
  if (cmd !== 'help' && cmd !== 'snapshots') {
    const r = await apiRequest('GET', port, '/api/vault');
    if (r.status === 404) { process.stderr.write('本机还没有密码库。请先在浏览器中创建（http://localhost:' + port + '）。\n'); process.exit(1); }
    if (r.status !== 200) { process.stderr.write(`读取密码库失败：HTTP ${r.status}\n`); process.exit(1); }
    blob = r.json;
    etag = r.headers.etag;
    const password = await getMasterPassword(flags);
    try {
      ({ vault, dkBits, kpw } = await unlockVault(blob, password));
    } catch {
      process.stderr.write('主密码不正确，或密码库文件已损坏。\n');
      process.exit(1);
    }
    normalizeVault(vault);
  }

  const persistAndExit = async (msg) => {
    purgeExpiredTrash(vault);
    const nextBlob = await sealBlob(blob, vault, dkBits, kpw);
    await saveVault(port, etag, nextBlob);
    if (msg) process.stdout.write(msg + '\n');
    process.exit(0);
  };

  switch (cmd) {
    case 'help':
      usage(0);
      break;

    case 'list': {
      if (flags.json) { process.stdout.write(JSON.stringify(vault.entries.map(({ password, totpSecret, history, ...rest }) => { rest.hasTotp = !!totpSecret; return rest; }), null, 2) + '\n'); break; }
      if (!vault.entries.length) { process.stdout.write('（暂无账号）\n'); break; }
      vault.entries.forEach((e, i) => {
        process.stdout.write(`${String(i + 1).padStart(3)}. ${e.title}${e.username ? '  [' + e.username + ']' : ''}${e.favorite ? ' ★' : ''}${e.totpSecret ? ' [TOTP]' : ''}\n    id=${e.id}\n`);
      });
      process.stdout.write(`共 ${vault.entries.length} 条。查看密码：get <名称或ID> --reveal\n`);
      break;
    }

    case 'get': {
      const e = arg && findEntry(vault, arg);
      if (!e) { process.stderr.write(`未找到账号：${arg || ''}\n`); process.exit(1); }
      if (flags.json) { process.stdout.write(JSON.stringify({ ...e, password: flags.reveal ? e.password : undefined, totpSecret: flags.reveal ? e.totpSecret : undefined }, null, 2) + '\n'); break; }
      printEntry(e, { reveal: !!flags.reveal });
      break;
    }

    case 'add': {
      if (!flags.title) { process.stderr.write('错误：add 需要 --title\n'); process.exit(1); }
      let password = flags.password || '';
      if (flags['password-stdin']) password = (await nextStdinLine()) || '';
      if (flags.gen) password = genPassword(typeof flags.gen === 'string' && Number(flags.gen) >= 8 ? Number(flags.gen) : 20);
      if (flags.totp && !VC.decodeBase32(VC.normalizeTotpInput(flags.totp))) {
        process.stderr.write('错误：TOTP 密钥不是合法的 Base32 或 otpauth 链接\n');
        process.exit(1);
      }
      const now = Date.now();
      vault.entries.push({
        id: crypto.randomUUID(),
        title: String(flags.title).slice(0, 80),
        username: String(flags.username || '').slice(0, 120),
        password,
        url: String(flags.url || '').slice(0, 300),
        notes: String(flags.notes || '').slice(0, 10000),
        category: String(flags.category || 'other'),
        favorite: false,
        tags: String(flags.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 20),
        totpSecret: flags.totp ? VC.normalizeTotpInput(flags.totp) : '',
        createdAt: now,
        updatedAt: now,
        passwordChangedAt: now,
        history: [],
      });
      await persistAndExit('已新增：' + flags.title);
      break;
    }

    case 'update': {
      const e = arg && findEntry(vault, arg);
      if (!e) { process.stderr.write(`未找到账号：${arg || ''}\n`); process.exit(1); }
      const now = Date.now();
      const fields = ['title', 'username', 'password', 'url', 'notes', 'category'];
      let changed = false;
      for (const f of fields) {
        if (flags[f] !== undefined) {
          if (f === 'password' && e.password && flags.password && flags.password !== e.password) {
            e.history ??= [];
            e.history.unshift({ password: e.password, changedAt: e.passwordChangedAt || e.updatedAt || now });
            if (e.history.length > HIST_MAX) e.history.length = HIST_MAX;
            e.passwordChangedAt = now;
          }
          e[f] = f === 'title' ? String(flags[f]).slice(0, 80) : String(flags[f]);
          changed = true;
        }
      }
      if (flags.tags !== undefined) { e.tags = String(flags.tags).split(',').map(t => t.trim()).filter(Boolean); changed = true; }
      if (flags.totp !== undefined) {
        const sec = VC.normalizeTotpInput(flags.totp);
        if (sec && !VC.decodeBase32(sec)) { process.stderr.write('错误：TOTP 密钥不是合法的 Base32 或 otpauth 链接\n'); process.exit(1); }
        e.totpSecret = sec; changed = true;
      }
      if (flags['clear-totp']) { e.totpSecret = ''; changed = true; }
      if (!changed) { process.stderr.write('错误：update 未提供任何要修改的字段\n'); process.exit(1); }
      e.updatedAt = now;
      await persistAndExit('已更新：' + e.title);
      break;
    }

    case 'delete': {
      const idx = vault.entries.findIndex(e => e.id === arg || e.title === arg);
      if (idx < 0) { process.stderr.write(`未找到账号：${arg || ''}\n`); process.exit(1); }
      const [entry] = vault.entries.splice(idx, 1);
      vault.trash.unshift({ id: crypto.randomUUID(), deletedAt: Date.now(), entry });
      await persistAndExit('已移入回收站：' + entry.title + '（30 天内可恢复）');
      break;
    }

    case 'trash': {
      const action = sub || 'list';
      if (action === 'list') {
        if (flags.json) { process.stdout.write(JSON.stringify(vault.trash.map(({ entry, ...rest }) => ({ ...rest, title: entry.title, username: entry.username })), null, 2) + '\n'); break; }
        if (!vault.trash.length) { process.stdout.write('（回收站为空）\n'); break; }
        vault.trash.forEach(item => process.stdout.write(`${item.id}  ${item.entry.title}  删除于 ${new Date(item.deletedAt).toLocaleString('zh-CN')}\n`));
        break;
      }
      if (action === 'restore') {
        const idx = vault.trash.findIndex(item => item.id === arg);
        if (idx < 0) { process.stderr.write(`回收站中未找到：${arg || ''}\n`); process.exit(1); }
        const [item] = vault.trash.splice(idx, 1);
        if (vault.entries.some(e => e.id === item.entry.id)) item.entry.id = crypto.randomUUID();
        vault.entries.push(item.entry);
        await persistAndExit('已恢复：' + item.entry.title);
        break;
      }
      if (action === 'purge') {
        if (arg === 'all') {
          const n = vault.trash.length;
          vault.trash = [];
          await persistAndExit(`已清空回收站（${n} 条）`);
        }
        const idx = vault.trash.findIndex(item => item.id === arg);
        if (idx < 0) { process.stderr.write(`回收站中未找到：${arg || ''}\n`); process.exit(1); }
        const [item] = vault.trash.splice(idx, 1);
        await persistAndExit('已永久删除：' + item.entry.title);
        break;
      }
      process.stderr.write(`未知的 trash 子命令：${action}\n`); process.exit(1);
      break;
    }

    case 'health': {
      const rep = healthReport(vault);
      if (flags.json) {
        process.stdout.write(JSON.stringify({
          score: rep.score, grade: rep.grade, reasons: rep.reasons,
          weak: rep.weak.map(e => e.title), reusedCount: rep.reusedCount,
          reusedGroups: rep.reusedGroups.map(g => g.map(e => e.title)),
          stale: rep.stale.map(e => ({ title: e.title, passwordChangedAt: e.passwordChangedAt })),
          totpSuggestions: rep.noTotp.map(e => e.title),
        }, null, 2) + '\n');
        break;
      }
      process.stdout.write(`健康度评分：${rep.score} / 100（${rep.grade}）\n`);
      if (rep.reasons.length) process.stdout.write('扣分项：\n' + rep.reasons.map(r => '  - ' + r).join('\n') + '\n');
      else process.stdout.write('没有需要扣分的风险项。\n');
      if (rep.noTotp.length) process.stdout.write(`建议绑定两步验证（不计入评分）：${rep.noTotp.map(e => e.title).join('、')}\n`);
      break;
    }

    case 'totp': {
      const e = arg && findEntry(vault, arg);
      if (!e) { process.stderr.write(`未找到账号：${arg || ''}\n`); process.exit(1); }
      if (!e.totpSecret) { process.stderr.write('该账号未绑定两步验证\n'); process.exit(1); }
      const code = await VC.totpCode(e.totpSecret);
      if (!code) { process.stderr.write('TOTP 密钥无效\n'); process.exit(1); }
      process.stdout.write(`${e.title}  ${code}（${30 - Math.floor(Date.now() / 1000) % 30}s 后刷新）\n`);
      break;
    }

    case 'snapshots': {
      const r = await apiRequest('GET', port, '/api/snapshots');
      if (r.status !== 200) { process.stderr.write(`读取快照列表失败：HTTP ${r.status}\n`); process.exit(1); }
      const snaps = r.json.snapshots || [];
      if (flags.json) { process.stdout.write(JSON.stringify(r.json, null, 2) + '\n'); break; }
      if (!snaps.length) { process.stdout.write('（还没有快照）\n'); break; }
      snaps.forEach(s => process.stdout.write(`${s.id}  ${new Date(s.createdAt).toLocaleString('zh-CN')}  ${(s.size / 1024).toFixed(1)} KB\n`));
      process.stdout.write(`最多保留 ${r.json.limit} 份。恢复：snapshot-restore <快照ID>\n`);
      break;
    }

    case 'snapshot-restore': {
      if (!arg) { process.stderr.write('错误：snapshot-restore 需要 <快照ID>\n'); process.exit(1); }
      const r = await apiRequest('PUT', port, '/api/snapshot-restore?id=' + encodeURIComponent(arg), { headers: etag ? { 'If-Match': etag } : {} });
      if (r.status === 404) { process.stderr.write('快照不存在或当前没有密码库\n'); process.exit(1); }
      if (r.status === 409) { process.stderr.write('密码库已被修改（ETag 冲突），请重新执行后再试。\n'); process.exit(2); }
      if (r.status !== 200) { process.stderr.write(`恢复失败：HTTP ${r.status}\n`); process.exit(1); }
      process.stdout.write('快照已恢复（恢复前当前库已另行备份为快照）。请重新解锁。\n');
      break;
    }

    default:
      process.stderr.write(`未知命令：${cmd}\n\n`);
      usage(1);
  }
}

main().catch(err => {
  if (err instanceof ConflictError) { process.stderr.write(err.message + '\n'); process.exit(2); }
  process.stderr.write('执行失败：' + (err && err.message || err) + '\n');
  process.exit(1);
});
