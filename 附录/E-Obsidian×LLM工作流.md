---
title: "附录E Obsidian×LLM工作流"
tags:
  - topic/workflow
  - topic/knowledge-management
description: "本 Vault 使用说明：标签体系、Dataview 查询、AI 辅助复习法（SDD 回顾）、Anki 导出卡片约定与安全合规边界"
created: 2025-01-15
---
# 附录E · Obsidian × LLM 工作流（本 Vault 使用说明）

> 把调试经验从大脑和聊天记录中解放出来——**Obsidian 做唯一事实源，LLM 做加工引擎**，让每一行排障日志都变成可检索、可关联、可复习的结构化知识。

## 核心纪律：AI 起草 → 人审核 → 入库

永远不要让 AI 直接写最终笔记。这条纪律是防止幻觉污染知识库的生命线：

1. **起草**：LLM 从对话记录 / 串口日志 / 芯片手册中提取结构化草稿
2. **审核**：人对照原始证据修正，信息不足处标 `[TODO]` 而非编造
3. **入库**：确认后移入对应目录并 commit（Obsidian Git 自动备份）

## 本 Vault 标签体系

| 标签类别 | 示例 | 用途 |
|----------|------|------|
| 领域标签 `domain/*` | #domain/mcu #domain/linux #domain/rtos | 章节笔记的领域归属，每篇一个主领域 |
| 主题标签 `topic/*` | #topic/dma #topic/i2c #topic/bootloader | 细粒度主题，可与领域标签组合检索 |
| 附录固定对 | #appendix #reference | 五个附录文件底部统一携带（见各页页脚） |
| 排故卡片 | #troubleshooting #rs485 #timing | 根因类别自由组合，同一卡片可多贴 |
| 流转状态 | frontmatter `status: resolved/open` | Dataview 按 status 过滤待办排故 |

## 排故卡片工作流（价值密度最高）

**步骤① 现场快速捕获**到 Inbox（手机/终端复制粘贴原始现象即可）；**步骤②** 选中文本交给 LLM 按下述模板结构化提取；**步骤③** 审核修正后移入 `02-Troubleshooting/` 并 commit；**步骤④** 补双链关联。

```markdown
---
tags: [troubleshooting, rs485, timing]
status: resolved
severity: medium
date: 2025-03-14
product: XYZ v2.1
---
（笔记标题=现象一句话，例：RS485 方向切换过早导致 CRC 错误）

## 现象
3 号从站偶发 CRC 错误，其他站正常。

## 环境
STM32F407 + SP3485 收发器；115200-8N1

## 取证过程
1. 换线无效 → 排除物理层
2. 降波特率频率降低但仍有 → 排除带宽问题
3. 示波器测 DE 引脚：最后一位结束后仅 0.3µs 即拉低（规格要求 TC 后 ≥5µs）

## 根因
固件在 TC 回调之外切了方向，最后 1~2 bit 被截断 → 从站收到不完整帧 → CRC 错。

## 修复方案
DE 切换逻辑移入 TC 中断回调（方法见 [[ch28-串口工程化IDLE-DMA-RS485]]）

## 关联
- 相关章节：[[ch28-串口工程化IDLE-DMA-RS485]] [[ch75-UART-RS485与Modbus-RTU实战libmodbus]]
- 类似案例：（补 wiki-link）
```

Prompt 要点：「你是资深嵌入式工程师。将以下调试笔记转为结构化排故卡片。**信息不足标 [TODO] 不编造**。」芯片手册摘要化同理四步：分块投喂 → 首轮提取寄存器速查表 → **交叉验证防幻觉**（把实测数据喂回去让 AI 自查不一致）→ 入库并标注来源与验证状态（如 `基于 RM0090 Rev19 §29.3.12 / ✅ 已实测`）。

## Dataview 用法

安装 Dataview 插件后，任意笔记中嵌入查询块。周度图谱更新（每周五 15 分钟）四动作：

```dataview
TABLE status, severity, date
FROM "02-Troubleshooting"
WHERE date >= date(today) - dur(7 days)
```

1. 运行上方查询列出本周新增排故卡片
2. 让 LLM 做关联分析：「分析这 N 条记录的共同根因模式？建议新增标签？值得写成博客的故事？」
3. 打开 Graph View 检查孤岛节点——无任何链接的笔记需要补双链或归档
4. Obsidian Git 自动 commit+push（建议定时 30min）

月度「园丁」Prompt（节选）：「以下是所有排故笔记标题和标签列表。请分析：哪些高度相关但没有互链？哪些标签使用 <2 次应合并？标签体系有什么结构性缺口？」

## AI 辅助复习法（SDD 回顾）

把 SDD（Spec-Driven Development 规格驱动开发，见 [[ch09a-AI辅助开发实践]]）迁移到复习：**不要让 AI 猜你想学什么，先把「学会」的标准写成规格**。

1. **写规格**：对每个主题写下验收标准——「能盲讲 HardFault 五步取证」「能手推 RMS 充分条件公式」
2. **按规格出题**：让 LLM 只针对规格生成追问链，答不上即暴露差距
3. **对照验收**：答案逐条比对评分关键词（素材直接用 [[A-面试题库]] 的答题要点表）
4. **季度差距分析**：把笔记目录投喂 LLM——「假设面试高级嵌入式系统工程师，哪些话题空白？已有话题深度够吗？未来三个月最值得补的 3 个主题及理由」

## Anki 导出卡片约定

从排故记录批量生成 SRS 闪卡的统一格式：

| 字段 | 内容约定 |
|------|----------|
| Front | 症状描述（**不含根因**，保留悬念） |
| Back | 根因 + 修复方案一句话 + 相关寄存器/命令 |
| 格式 | CSV，一行一卡；LLM Prompt：「为每条排故记录生成一张闪卡 CSV」 |

导入 Anki 通勤复习——这是「写过的排障经验不再遗忘」的最后闭环。

## 安全与合规边界

| 场景 | 能否发云端 LLM | 替代方案 |
|------|----------------|----------|
| 公开开发板(STM32/ESP32)通用问题 | ✅ 完全可以 | - |
| 公司产品型号+固件 Bug 日志 | ⚠️ 脱敏后可以（去型号/客户名） | 本地 Ollama(qwen2.5-coder:7b) |
| 客户 NDA 项目代码片段 | ❌ 绝对禁止 | 本地模型或纯人工分析 |
| 加密密钥/证书/密码/源 IP | ❌ 永远不要出现在任何 prompt 中 | 密管系统(Vault/HSM) |

团队纪律：在项目 Wiki 上公示本表的定制版，让每个人都知道红线在哪里。

## 快速启动 Checklist

- [ ] 安装 Obsidian + 创建 Vault（目录：00-Inbox / 01-ChipNotes / 02-Troubleshooting / 06-Templates …）
- [ ] 安装核心插件：Copilot、Smart Connections、Text Generator、Dataview、Templater、Obsidian Git、Excalidraw
- [ ] 配置 Copilot 后端：公开内容走云端 API，敏感内容走本地 Ollama（混合 ★推荐）
- [ ] 导入排故模板（上面 markdown 模板存为 Templater 模板）
- [ ] 写第一条真实排故笔记并用 LLM 格式化 → 审核入库 → 补双链
- [ ] 启用 Obsidian Git 自动备份，打开 Graph View 欣赏你的知识网络

---
🏷️ #appendix #reference | 📚 [[附录-MOC]]
