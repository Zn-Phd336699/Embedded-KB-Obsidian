---
title: "第72章 A/B OTA 升级与 Recovery 体系"
part: "[[P7-MOC]]"
chapter: 72
tags:
  - domain/android
  - topic/ota
  - topic/recovery
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch71-设备适配DTB-sepolicy-vendor-blobs]]"
related:
  - "[[ch67-AOSP架构与源码编译]]"
  - "[[ch30-Bootloader-IAP-OTA固件升级体系]]"
  - "[[ch89-P3-MCUboot双分区OTA安全升级系统]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第72章 A/B OTA 升级与 Recovery 体系

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch71-设备适配DTB-sepolicy-vendor-blobs]] | → [[ch73-底层调试Perfetto-logcat-adb进阶]]

## 🎯 学习目标
- [ ] 对比传统 Recovery / A/B / Virtual A/B 三代升级架构的机制与痛点
- [ ] 讲清 Virtual A/B 的 snapshot/COW/dm-user 数据面与 merge 流程
- [ ] 制作全量/增量 OTA 包并用 update_engine_client 走通端到端升级
- [ ] 建立「任意时刻断电不砖」的回滚验证测试集

## 72.1 三代升级架构对比

| 架构 | 机制 | 痛点 |
|------|------|------|
| Recovery 传统式 | 进 recovery 小系统解包写 system 分区 | 升级期间设备不可用；断电易变砖 |
| A/B 无缝 | 双 system slot 后台下载写入，重启切换 | 分区空间翻倍 |
| **Virtual A/B（现行）** | snapshot/dm-user 动态分区按需复制 | 实现复杂度高——本章主角 |

Virtual A/B 用空间近单倍的代价获得双 slot 的安全性：未占用块引用源分区，只有改动块进 COW。

## 72.2 Virtual A/B 数据面：COW 与 dm-user

```text
核心角色：
update_engine        # 用户态引擎：下载/校验/写目标 slot
dm-snapshot/dm-user  # 内核态：写时重定向到 COW(Copy-on-Write) 空间
metadata (LP)        # 动态分区元数据，记录 slot 组与 snapshot 状态
boot_control HAL     # bootloader 询问/标记 active/successful slot

升级流：
① 后台下载 delta 包(bsdiff/puffin 二进制差量) → 校验哈希
② 写 target slot：未占用块引用源，改动块入 COW
③ merge 阶段(重启后 idle 时)：snapshot 合并回真分区
④ bootctl markBootSuccessful —— 若 N 次未确认则 bootloader 自动切回旧 slot
⑤ rollback 安全网：merge 前掉电=快照仍在可恢复；merge 中掉电=状态机续作
```

metadata(LP geometry) 是唯一事实源——手改分区表=自杀。

## 72.3 关键代码：OTA 包制作与设备端触发

```bash
# 全量包：
ota_from_target_files -v out/target/product/rk3568/*-target_files.zip ota_full.zip
# 增量包(需两个 target_files)：
ota_from_target_files --block --binary dist/two.zip old.zip ota_delta.zip
# 设备端触发：
update_engine_client --payload=http://srv/ota_delta.zip \
  --offset=0 --size=FILE_SIZE --headers="$(cat keyvals)" \
  --wait --cancel          # 观察进度与取消语义
# 监控：dumpsys update_engine 看 progress/status(UPDATE_SUCCESS→NEED_REBOOT)
```

payload.bin 是包内核心载荷；manifest.pb 描述每个分区的目标 hash——校验发生在写入时而非最后，坏块早发现。

## 72.4 bootctl HAL 升级状态机

```text
slot 四状态组合(active/successful/bootable)：
  正常运行： slot A active+successful
  开始升级： slot B active(未 successful) —— 重启必落 B
  启动成功： system_server 就绪后 markBootSuccessful(B)
  失败回滚： B 连续 N 次(通常7)未确认 → bootloader 切回 A(A 仍 successful)
watchdog 联动： bootanim 卡死也算失败——由 rescue_party(crash 计数)与 WDT 共同裁决。
```

## 72.5 失败回滚机制要点
1. merge 前掉电：快照仍在，旧 slot 完整可回滚。
2. merge 中掉电：两阶段各自断点续作，重启后状态机继续。
3. 新系统首次启动即崩溃 → 永远等不到 markBootSuccessful → 自动切回旧 slot。
4. 回滚后用户数据完整性依赖 FBE 密钥不受 slot 切换影响。

## 72.6 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 卡 0% 不动 | dumpsys update_engine 看 status | snapshot 空间/metadata 版本 | lpdump 查动态分区余量充足 |
| 无限回滚循环 | boot_reason + 首启日志第一异常点 | 修复新 slot 启动失败根因 | markBootSuccessful 达成 |
| merge 期整机卡顿 | IO 监控 + 用户活跃时段对照 | merge 触发条件(idle+maintenance window) | 活跃期无合并风暴 |

## 72.7 实测数据表（发布前必过的测试矩阵）

| 场景 | 通过标准 |
|------|----------|
| 正常升级成功率 | ≥99%（100 台抽样） |
| 升级中掉电 ×10 次 | 要么完成要么干净回滚，无中间砖 |
| 磁盘满/网络中断注入 | 引擎正确报错且不污染当前 slot |
| 连续版本链式增量 | 连续 5 个版本升级成功 |
| 回滚后用户数据 | FBE 密钥不受影响、数据完整 |

## 72.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| update_engine 卡 0% | snapshot 空间不足/metadata 版本不符 | logcat UpdateAttempter；lpdump 查动态分区余量 |
| 重启后无限回滚 | 新 slot 从未 mark successful(首次启动崩溃) | 查 boot_reason 与新系统启动日志第一异常点 |
| merge 阶段 IO 风暴卡顿 | 合并时机在用户活跃期 | 调整 merge 触发条件(idle+maintenance window) |
| delta 包应用报 hash mismatch | 基线版本与预期不符(用户已手动改) | source fingerprint 校验前置；降级为全量兜底 |

## 72.9 部署注意事项
1. delta 只对特定源版本有效——服务端必须维护设备版本分布并做降级为全量的兜底策略。
2. system/vendor/product 多分区必须同批原子切换——metadata 的 group 概念保证一致性。
3. 升级窗口选 idle + maintenance window，避免 merge 在用户活跃期引发 IO 风暴。
4. 处理用户拒绝升级场景：夜间自动窗口须有明确授权开关与静默重试上限。
5. 出厂前跑完 72.7 全部测试矩阵项，缺一不放行。

> [!example]- 🧪 动手实验 L72-1：三次断电的完美回滚验证（80 分钟）
> **步骤**：① 在 Cuttlefish 或真机制作全量 OTA 包；② 正常升级一次走通全流程并记录各阶段时长；③ 分别在「下载中/写入中/merge 中」三点强制断电；④ 每次重启后核对当前 slot、系统可用性、用户数据完好；⑤ 输出三场景的状态机轨迹图。
> **验收**：「任意时刻断电不砖」从口号变成你亲手验证过的事实。

## 72.10 进阶话题
- **增量包基线管理**：服务端按设备版本分布下发 delta，失配时全量兜底。
- **payload 元数据头**：manifest.pb 分区级 hash 让校验前置到写入时。
- **多分区原子切换**：group 保证 system/vendor/product 一致性。
- **Linux 世界对照**：RAUC 的 bundle/signing 机制与本节同构，嵌入式 Linux 可直接借用。

> [!warning]- ❓ FAQ
> **Q1：Virtual A/B 相比传统 A/B 省多少空间？** A1：传统 A/B 需要整套双份动态分区；Virtual A/B 只需约等于改动块的 COW 空间——推导见思考题 1。
> **Q2：merge 中掉电会变砖吗？** A2：不会。snapshot/merge 两阶段各自断点续作，metadata 是唯一事实源。
> **Q3：与 MCU 端 OTA 什么关系？** A3：slot 状态机思想与 [[ch30-Bootloader-IAP-OTA固件升级体系]]/[[ch89-P3-MCUboot双分区OTA安全升级系统]] 三方对照是面试高频题。

> [!question] 📝 思考题
> 1. 推导 Virtual A/B 相比传统 A/B 的存储节省公式。
> 2. 设计「夜间自动升级窗口」策略并处理用户拒绝场景。
> 3. 把 ch30 MCUboot 思想与本节做一张概念映射表。

---
🏷️ #domain/android #topic/ota #topic/recovery | 🔗 [[ch71-设备适配DTB-sepolicy-vendor-blobs]] ← **本章** → [[ch73-底层调试Perfetto-logcat-adb进阶]] | 📚 [[P7-MOC]]
