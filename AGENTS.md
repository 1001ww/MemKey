# MemKey 协作说明

## 代码审阅（Open Code Review）

不要用「对 empty tree / 根提交做 `ocr review --from`」来审整个仓库。那会：

1. 因 empty tree 不是 commit、或没有 merge-base 而失败；
2. 把**历史 diff**（含已修复问题）再报一遍，而不是审当前版本。

正确用法：

| 目标 | 命令 |
|---|---|
| 审当前工作区未提交改动 | `ocr review --audience agent --background-file .opencodereview/background.md` |
| 审某一提交相对其父提交 | `ocr review --audience agent --background-file .opencodereview/background.md --commit <sha>` |
| 审相对上一发布的 diff | `ocr review --audience agent --background-file .opencodereview/background.md --from vX.Y.Z --to HEAD` |
| **审当前整库现状（推荐用于「审整个仓库」）** | `ocr scan --audience agent --background-file .opencodereview/background.md` |

规则在 `.opencodereview/rule.json`。`.bat` / Markdown 默认不在 OCR 范围内。
