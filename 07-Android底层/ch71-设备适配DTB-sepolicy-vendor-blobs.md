---
title: "第71章 设备适配实战：DTB / sepolicy / vendor blobs"
part: "[[P7-MOC]]"
chapter: 71
tags:
  - domain/android
  - topic/bsp
  - topic/selinux
difficulty: 5
est_minutes: 45
prerequisites:
  - "[[ch70-Binder原理与实践]]"
related:
  - "[[ch40-内核适配与设备树dts语法-pinctrl-overlay]]"
  - "[[chsa-S1安全架构与SecureBoot实战]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第71章 设备适配实战：DTB / sepolicy / vendor blobs

> [!info] 导航
> ⏱ 45min | ★★★★★ | 前置 [[ch70-Binder原理与实践]] | → [[ch72-A-B-OTA升级与Recovery体系]]

## 🎯 学习目标
- [ ] 独立执行新板适配七步清单（内核→boot 链→fstab→dtbo→HAL→sepolicy→性能调校）
- [ ] 用「五步法」从 avc denied 日志出发收敛 SELinux 规则，并能处理 neverallow 冲突
- [ ] 清单化管理 vendor blobs，说明 VINTF compatibility matrix 的校验作用

## 71.1 新板适配七步清单

| 步骤 | 内容 | 关键点 |
|------|------|--------|
| ① 内核侧 | 主线/厂商内核选型 → dts（复用同 SoC 参考板起步）→ 必要驱动在 defconfig 开启 | 先点亮再优化 |
| ② boot 链 | ABL/U-Boot 支持 boot.img v4 头 + AVB2.0 校验链 | 与 [[chsa-S1安全架构与SecureBoot实战]] 互补 |
| ③ fstab | 分区 UUID/文件系统/avb flags 对齐实际 GPT | first stage init 靠它挂载 |
| ④ dtbo | 多硬件变体走 overlay 机制 | bootloader 按硬件 ID 选择索引 |
| ⑤ HAL 补齐 | 按 VINTF manifest 差集逐个移植 | 显示/Camera/Audio/Sensors 优先 |
| ⑥ sepolicy | device/<v>/sepolicy/{vendor,file_contexts,hwservice_contexts} | 最小权限原则 |
| ⑦ 性能调校 | thermal 配置、cpufreq 表、task_profiles 绑核策略 | 最后做，别提前调 |

## 71.2 DTB 注入 boot 镜像与 dtbo 选择

boot.img v4 头含独立 DTB 区段，vendor_boot 携带 dtbo 镜像；多硬件变体（不同内存/屏幕）共用一套内核时，由 bootloader 按 hardware ID 选 overlay 索引。dtbo 机制与 Linux 设备树 overlay 同源（参见 [[ch40-内核适配与设备树dts语法-pinctrl-overlay]]）。

## 71.3 关键代码：SELinux 类型强制判定流水线

```text
每次系统调用 → 内核 LSM 钩子 → AVC(Access Vector Cache) 查询：
① 进程域(scontext) × 目标标签(tcontext) × 类(class) × 权限(perm)
② 命中缓存放行；未命中查策略规则库 → allow/deny
deny 时 dmesg 打印：
avc: denied { read } for comm="x" scontext=.. tcontext=.. tclass=file
策略语言四件套：
type mydom_t, domain;                          # 定义域
type mydata_t, file_type;                      # 定义文件类型
allow mydom_t mydata_t:file { read write };    # 授权
neverallow * * :file exec;                     # 全局红线(编译期检查!)
```

neverallow 是双刃剑：「乱开权限」在编译期就失败——策略也有 CI。allow 与 neverallow 冲突时的正确做法是重新设计授权路径（收窄权限、补 type_transition 让文件落对标签），而不是删红线。

## 71.4 关键代码：audit2allow 五步法

```bash
# 目录职责 vendor/myco/sepolicy/
# ├── file_contexts      # 路径→标签: /vendor/bin/gatewayd u:object_r:gatewayd_exec:s0
# ├── hwservice_contexts # HAL接口→标签
# ├── gatewayd.te        # 域定义+规则
# └── genfs_contexts

logcat -b all | grep avc > avc.log     # ① 收集真实拒绝(avc denied 解读)
audit2allow -i avc.log                 # ② 生成草稿
# ③ 人工评审每条：收窄类与权限(read 就不给 append)，补 type_transition 落对标签
# ④ 加 neverallow 测试防回归；若与既有 neverallow 冲突则改设计而非放权
# ⑤ enforcing 复跑确认零新增 avc
```

规则编写心法（最小权限）：

```text
type gatewayd, domain;
type gatewayd_exec, exec_type, vendor_file_type, file_type;
init_daemon_domain(gatewayd)
allow gatewayd sensor_device:chr_file r_file_perms;   # 只给需要的
```

错误姿势是直接把 audit2allow 输出全部塞进去——权限爆炸。永远不要带着全局 permissive 出厂！

## 71.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 服务功能被静默拦截 | logcat grep avc denied | 收窄后新增 allow 规则 | enforcing 下零新增 avc |
| 新进程跑在错误域 | ps -Z 看域标签 | file_contexts/seapp_contexts 标签 | 进程域与 .te 设计一致 |
| HAL 接口找不到 | lshal 列表比对 | hwservice_contexts 补登记 | hwservicemanager 注册成功 |

## 71.6 实测数据表（收敛工作量典型值）

| 场景 | 首轮收集 avc 条数 | 收敛到零新增耗时 |
|------|-------------------|------------------|
| 单个新 vendor 守护进程 | 数十~数百条（典型值） | 半天~1 天（典型值） |
| 全板首次 enforcing 点亮 | 上千条（典型值） | 数天迭代（典型值） |

## 71.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 开机卡 "Sending intent 'android.intent.action.LOCKED_BOOT'" | Credential 加密区挂载失败(fstab) | dmesg dm-crypt 相关行；keymaster HAL 就绪性 |
| 相机黑屏 | camera provider 未注册/media_profiles 不符 | dumpsys media.camera；lshal 找 ICameraProvider |
| 随机 reboot 报 kernel panic in vendor | blob 与内核 ABI 不匹配 | pstore 日志符号化；锁定 blob 与内核配对版本 |
| GMS 认证失败 CTS | VINTF 缺口/权限模型不符 | vts-tradefed 分项跑；compatibility_matrix 对照补齐 |

## 71.8 部署注意事项

1. 全局 permissive 只用于开发期取证，出厂镜像必须全域 enforcing。
2. vendor 属性必须带前缀 ro.vendor./persist.vendor. 并登记 property_contexts。
3. blob 与内核版本配对锁定升级——ABI 不匹配会随机 panic。
4. WiFi/BT 固件放 /vendor/firmware 时核查 license 再分发条款。
5. DRM/媒体组件属高风险区，版本兼容性测试矩阵必须覆盖。

> [!example]- 🧪 动手实验 L71-1：把一个 permissive 服务「驯化」到 enforcing（90 分钟）
> **步骤**：① 新服务先以 permissive 域跑全功能收集 avc；② 按五步法产出最小策略；③ 切 enforcing 回归测试；④ 故意注入一次越权访问验证拦截与日志；⑤ 输出策略 diff 供评审。
> **验收**：enforcing 下功能全绿且 avc 归零——这就是可发布状态。

## 71.9 进阶话题
- **Treble 分层策略边界**：vendor 进程只能访问 vendor_file/public 类型——跨层直引 system 私有类型编译期即报错。
- **属性空间隔离**：vendor 属性前缀强制 + property_contexts 登记构成双保险。
- **seapp_contexts 决定进程域**：domain 由 uid/fspath/seinfo 三元组映射——App 数据共享的边界本质是这条映射表。
- **VINTF 兼容矩阵**：device manifest 与 framework compatibility matrix 求差集即 HAL 移植工作清单。

> [!warning]- ❓ FAQ
> **Q1：为什么 file_contexts 错标签比缺 allow 更隐蔽？** A1：缺 allow 会立刻打 avc denied 日志指向明确；错标签让进程落在非预期域，拒绝发生在间接路径上，表象远离根因。
> **Q2：某 WiFi blob 无法获取源码怎么办？** A2：评估开源驱动替代、固件文件替换两条路；均不可行时锁定内核版本并纳入兼容矩阵管理。

> [!question] 📝 思考题
> 1. 设计「一板三变体」（不同内存/屏幕）的 dtbo 索引与 bootloader 传参方案。
> 2. 为什么 file_contexts 错标签比缺 allow 更隐蔽？举一个具体例子。
> 3. 评估某 WiFi blob 无法获取源码时的替代路径（开源驱动/固件替换）。

---
🏷️ #domain/android #topic/bsp #topic/selinux | 🔗 [[ch70-Binder原理与实践]] ← **本章** → [[ch72-A-B-OTA升级与Recovery体系]] | 📚 [[P7-MOC]]
