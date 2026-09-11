# MemKey 业务与安全背景（OCR）

MemKey 是纯本地账号密码保险库：零 npm 依赖的 Node HTTP 服务 + 自包含浏览器前端。

当前发布版本见 `server.js` 的 `/api/meta.version` 与 README「当前版本」。

## 整库审阅怎么跑

`ocr review` 只看 Git diff。工作区干净时什么都不审；对 empty tree / 根提交做 `--from` 会失败或把**历史 diff**（含已修复缺陷）再报一遍。

- **审当前整库 / 某个已发布版本的现状**：`ocr scan --audience agent --background-file .opencodereview/background.md`
- **审相对上一版本的改动**：`ocr review --audience agent --background-file .opencodereview/background.md --from <上一 tag> --to HEAD`

规则文件：`.opencodereview/rule.json`。`.bat` / Markdown 默认不在 OCR 扫描范围内。

## 架构约束（必须遵守）

- 服务只监听 `127.0.0.1:8420`，不得对外网或局域网开放。
- 零知识：所有加解密在浏览器 `crypto.subtle` 完成；`server.js` 只存取密文 JSON 外壳，禁止解密、禁止记录明文。
- Host 头必须是 `localhost` / `127.0.0.1`，防 DNS rebinding。
- 静态文件必须限制在 `public/` 内，禁止路径穿越。
- 密文文件 `data/vault.enc` 原子写入（tmp + fsync + rename）；该目录 gitignore。
- 前端零第三方请求、零 CDN、零埋点；`public/index.html` 自包含全部逻辑。

## 密码库格式

- v2 信封：随机 256-bit 数据密钥 DK 加密整库；主密码经 PBKDF2-SHA256 600,000 轮包裹 DK（`wpw`）；可选恢复码信封 `rec` 与明文提示 `hint`。
- v1（`iv`+`data` 整库加密）解锁时自动迁移到 v2。
- 加密范围：名称、用户名、密码、历史、网址、备注、分类、标签、TOTP 密钥全部加密。明文仅 KDF 参数、IV、可选 hint。
- 恢复码：31 字符表（A–Z 去掉 I/L/O，加 2–9）× 20 位 ≈ 99 bit；PBKDF2 100,000 轮包裹 DK；仅生成时完整显示一次。
- 主密码提示是故意明文，不要当泄露报。

## 产品功能

账号 CRUD、收藏、搜索、自定义分类、多标签、TOTP（Base32/otpauth，SHA-1/6/30）、密码历史（每账号最多 10 条）、密码生成器（字符/EFF 短语）、弱密码与重复检测、自动锁定、剪贴板 30 秒清除、加密备份导入导出、Windows 中文启动脚本与开机自启。

## 审阅重点

优先找：密钥/密文处理错误、恢复码与解锁路径绕过、XSS（密码库字段会进 DOM）、路径穿越、Host 校验绕过、竞态导致保险库损坏、TOTP/Base32 校验缺陷、历史密码未加密或未限制、主密码/DK 残留内存以外的持久化。

不要把下列设计决策当新漏洞：明文 `hint`、恢复码 100k 轮、仅绑定回环、零依赖无测试框架。
