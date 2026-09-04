# MemKey · 本地密码保险库

![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-2F5FE8)
![Platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20macOS%20%7C%20Linux-555)
![Dependencies](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0%20%E9%9B%B6-brightgreen)

**当前版本：v1.2.6**

**纯本地的账号密码管理器** —— 零依赖 Node 服务 + 浏览器端加密，数据以密文形式保存在本机文件中，主密码永不上传。

> 调研了 1Password / Bitwarden / KeePass / LastPass 等主流密码管理器后自建的轻量方案：
> 借鉴 KeePass 的「本地文件存储」实现数据主权，采用与商业产品同级的加密参数，但没有订阅费用、没有云端账户、没有隐私顾虑。

## ✨ 功能特性

| 模块 | 说明 |
|---|---|
| 🔐 加密保险库 | AES-256-GCM 加密，PBKDF2-SHA256 600,000 轮密钥派生，**全字段加密**（含名称、网址等元数据，吸取 LastPass 元数据泄露教训） |
| 🗂 账号管理 | 增删改查 / 收藏 / 全局搜索（`/` 快捷聚焦）/ **自定义分类**（可增删改名、拖拽排序）/ **标签**（多标签，适合「项目 × 类型」双维度组织） |
| 🎲 密码生成器 | 浏览器 CSPRNG 随机源，长度 8–64、四类字符开关、排除易混淆字符、实时熵值评估 |
| 🛡 安全报告 | 弱密码检测、重复密码分组检测、侧栏角标提醒 |
| ⏱ 安全防护 | 自动锁定（1/5/10/30 分钟）、剪贴板 30 秒自动清除、弱密码保存提醒 |
| 💾 备份迁移 | 加密备份导出/导入，或直接拷贝整个文件夹到 U 盘 |
| 🖥 本地服务 | 零依赖 Node 服务，仅监听 `127.0.0.1`，支持 Windows 开机自启 |

## 🚀 快速开始

### 第一步：安装 Node.js

MemKey 唯一的环境要求是 Node.js（≥ 18，无需安装任何 npm 依赖）。

**Windows**

1. 打开官网下载页：<https://nodejs.org/en/download>
2. 选择 **LTS（长期支持版）** → Windows Installer（.msi，64 位）
3. 双击运行安装包，全部选项保持默认，一路「下一步」完成安装
4. 验证：按 `Win + R` 输入 `cmd` 回车，在黑窗口输入以下命令并回车，显示 `v18.x.x` 或更高即成功：

```bash
node -v
```

> 提示「不是内部或外部命令」？重启电脑让环境变量生效，若仍不行重新运行安装包选 Repair。

**macOS**

- 方式一（推荐）：终端执行 `brew install node@22`（需先装 [Homebrew](https://brew.sh/)）
- 方式二：官网下载 .pkg 安装包，双击安装

**Linux（Ubuntu / Debian）**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y node
```

### 第二步：启动 MemKey

**Windows（推荐）**

1. 从 [Releases](https://github.com/1001ww/MemKey/releases) 下载最新版 Source code (zip)，解压整个 `MemKey` 文件夹到任意位置
2. 打开该文件夹，双击 `启动MemKey.bat`
3. 出现「MemKey 服务正在后台启动」提示后可直接关闭提示窗口；服务会继续在后台运行，浏览器会自动打开

> 请保留文件夹内的全部文件，尤其不要单独移动 `启动MemKey.bat` 或 `memkey-launch.vbs`。若提示找不到 Node.js，按上一步安装 Node.js 后重启 Windows，再重新双击启动文件。

**macOS / Linux**

```bash
cd MemKey
node server.js
```

**使用 Git 下载（可选）**

```bash
git clone https://github.com/1001ww/MemKey.git
cd MemKey
node server.js
```

打开浏览器访问 **http://localhost:8420**，首次使用设置主密码即完成创建。

### 开机自启（Windows）

需要每次登录 Windows 后自动运行时，在 MemKey 文件夹中双击一次 `安装开机自启.bat`。之后服务会在后台静默启动，不会弹出浏览器或提示窗口；需要使用时访问 **http://localhost:8420** 即可。

- 取消开机自启：双击 `卸载开机自启.bat`
- 手动启动服务：双击 `启动MemKey.bat`，关闭其提示窗口不会停止服务
- macOS / Linux 用户可用 systemd / launchd 指向 `node /path/to/MemKey/server.js`

## 📖 日常使用

### 数据存在哪里？

所有密码加密后保存在 **`data/vault.enc`** 一个文件里。该目录已被 `.gitignore` 排除，永远不会被提交。

### 数据迁移 / 换设备

两种方式任选：

1. **整目录拷贝**：把整个 MemKey 文件夹拷到 U 盘或新电脑，`node server.js` 直接可用
2. **备份文件**：设置 → 导出加密备份 → 新设备上导入（备份文件本身也是加密的，可安全存放任何位置）

### 常用操作

| 操作 | 方式 |
|---|---|
| 新增账号 | 顶部「新增账号」按钮，密码栏可点「生成」内嵌生成 |
| 复制密码 | 列表行悬停 / 详情弹窗，复制后 30 秒自动清剪贴板 |
| 搜索 | 顶栏搜索框，按 `/` 快速聚焦 |
| 修改主密码 | 设置 → 安全 → 修改（会重新加密全库） |
| 锁定 | 侧栏「立即锁定」，或等待自动锁定 |

## 🔒 安全架构（零知识）

```
浏览器（所有加解密发生在这里）              本地服务（只搬运密文）
┌──────────────────────────┐            ┌──────────────────────┐
│ 主密码 ──PBKDF2×600k──▶ 密钥           │                      │
│ 明文数据 ──AES-256-GCM──▶ 密文 ───────▶│ data/vault.enc      │
│ 密文 ◀──解密展示─────────────          │ （不接触明文/主密码） │
└──────────────────────────┘            └──────────────────────┘
```

- **服务端永远只接触密文**：即使 `vault.enc` 被拷走，没有主密码也无法解密
- **仅监听 127.0.0.1**：局域网/外网均无法访问，并校验 Host 防范 DNS rebinding
- **原子写入**：先写临时文件再重命名，断电也不会写坏密码库
- 加密实现见 [SECURITY.md](SECURITY.md)（含威胁模型与已知限制）

## 📁 目录结构

```
MemKey/
├── server.js              # 本地服务（零依赖，静态托管 + 密文文件 API）
├── public/
│   └── index.html         # 前端界面（全部加解密逻辑在此）
├── data/
│   └── vault.enc          # 加密密码库（自动创建，已排除出 git）
├── 启动MemKey.bat         # Windows 一键后台启动
├── 安装开机自启.bat       # 安装开机自启
├── 卸载开机自启.bat       # 卸载开机自启
└── memkey-launch.vbs      # 内部后台启动器
```

## ❓ FAQ

**忘记主密码怎么办？**
没有办法找回——这是零知识架构的代价：主密码是唯一密钥来源，没有任何后门能解密数据。若确定无法想起，可在解锁页点击「忘记主密码？」，输入「重置」确认后删除本机密码库并重新创建（若之前导出过加密备份，仍可凭主密码导入恢复）。因此请把主密码抄写在安全的物理位置，并定期导出备份。

**为什么必须先启动服务？直接开 HTML 不行吗？**
`node server.js` 负责把密文落盘为真实文件（而非浏览器缓存）。不启动服务时页面会提示「无法连接本地服务」。

**如何修改端口？**
编辑 `server.js` 顶部的 `PORT` 常量（默认 8420）。

**支持哪些浏览器？**
Chrome / Edge / Firefox 现代版本（需支持 Web Crypto API，2020 年后版本均可）。

**浏览器存了缓存吗？**
解锁期间明文数据仅存在于内存中，刷新/锁定/关闭页面即清除；磁盘上只有 `data/vault.enc` 密文文件。

## 📜 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 📄 许可证

[MIT](LICENSE) © 2026 1001ww

## ⚠️ 免责声明

本工具按「个人本地使用」场景设计，未经过第三方安全审计。请自行评估风险后再存储高敏感凭据，并保持定期备份。
