---
title: "第68章 启动流程与Zygote"
part: "[[P7-MOC]]"
chapter: 68
tags:
  - domain/android
  - topic/bootloader
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch67-AOSP架构与源码编译]]"
related:
  - "[[ch38-SoC启动链深度剖析]]"
  - "[[ch56-启动流程深度剖析systemd提速]]"
  - "[[ch71-设备适配DTB-sepolicy-vendor-blobs]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第68章 启动流程与Zygote

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch67-AOSP架构与源码编译]] | → [[ch69-HAL演进与AIDL-HAL实战]]

## 🎯 学习目标
- [ ] 完整复述六级启动接力：BootROM→bootloader→kernel→init→Zygote→SystemServer→Launcher
- [ ] 读懂 init 的 rc 脚本三要素（action/service/trigger）与常用选项
- [ ] 解释 Zygote 预加载+COW 共享的设计动机与三条 fork 约束
- [ ] 用分层定位法排查开机卡屏问题

## 68.1 六级启动接力全景

Android 启动是一场「接力赛」，每一棒的职责边界必须清晰：

| 棒次 | 角色 | 关键动作 |
|------|------|----------|
| 1 | BootROM/ABL bootloader | AVB 验签 → 加载 boot.img |
| 2 | Kernel | 驱动初始化，挂载 system/vendor |
| 3 | init(PID 1) | 解析 *.rc、挂分区、拉起 daemon/服务 |
| 4 | app_process/Zygote | 预加载资源+常用类，fork 出一切 App |
| 5 | SystemServer | AMS/WMS/PMS… 上百个系统服务 |
| 6 | Launcher | 桌面就绪 |

Zygote 精髓：所有 App 由它 fork——只读段共享(COW)，启动快、内存省、类加载一致。Linux 侧前置链路见 [[ch38-SoC启动链深度剖析]]。

## 68.2 init rc 脚本语法速成

init 的世界只有三个要素：`on <trigger>` 定义动作序列、`service` 定义守护进程、property 触发编排执行时机。

```text
# init.rc 片段
on early-init                # 触发器阶段：mount cgroup / 设定 selinux
on post-fs-data              # /data 可写后：加载 persist 属性
on boot                      # 最后阶段
    start hwservicemanager

service gatewayd /system/bin/gatewayd --cfg /data/gw.yaml
    class main               # 分组便于 class_start/stop 批量管理
    user system group inet   # 运行身份
    capabilities NET_ADMIN
    oneshot                  # 单次执行(disabled=手动启动)
    seclabel u:r:gatewayd:s0 # SELinux 域绑定 ★缺它必被拒
    restart on crash         # 新版支持崩溃重启语义

调试：getprop | grep init.svc 看服务状态；setprop ctl.start gatewayd 手动拉起
```

## 68.3 Zygote fork 的三个约束（为什么 App 崩溃模式如此独特）

| 约束 | 原因 | 对开发的影响 |
|------|------|--------------|
| 只允单线程 fork | 复制多线程状态不安全 | zygote 预加载期禁止起线程——你的库若在静态块起线程会在 fork 后死锁 |
| COW 共享页 | 省内存核心机制 | 写热点对象会触发页复制——大数组初始化放 App 自己做而非依赖共享 |
| GC 状态一致性 | fork 时堆快照冻结 | zygote 预加载完成后必须停 GC 再 fork(源码有专门处理) |

## 68.4 关键代码：标准 vendor 服务的 rc 全套

```text
# vendor/etc/init/hw/init.myboard.rc
service mygateway /vendor/bin/mygateway --cfg /persist/gw.yaml
    class late_start
    user system  group inet net_admin
    capabilities NET_ADMIN NET_RAW
    seclabel u:r:mygateway:s0            ← ch71 配套 .te 文件
    writepid /dev/cpuset/top-app/tasks   ← 绑定 cgroup 分组

# 调试三连：
getprop | grep init.svc.mygateway     # 状态机：stopping/started/running
logcat -s init                        # init 对该服务的每次动作
dmesg | grep avc                      # 被 SELinux 拦截的现场(ch71)
```

## 68.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 服务反复重启 | getprop init.svc.\<svc\> 状态机 | 补 seclabel 或依赖声明 | 状态稳定 running |
| 属性写入不生效 | dmesg 过滤 property_service 的 avc 拒绝 | 补 property_contexts 定义 | setprop/getprop 读写一致 |
| 冷启动比热启慢一倍 | logcat 观察 dexopt 活动 | 核对产线 dexpreopt 配置 | 二次开机时间回落 |
| watchdog 周期性重启 | eventlog 的 watchdog 事件 | 排查阻塞的 binder 调用方 | 关键服务不再超时 |

## 68.6 实测数据表：启动耗时特征

| 场景 | 指标 | 说明 |
|------|------|------|
| 首次开机(冷启动) | 约为热启动 2 倍时长（典型值） | /data 首次优化(dexopt)在跑，正常现象 |
| 二次开机(热启动) | 基线时长（机型相关，典型值） | 产线预编译 dexpreopt 已就位 |
| watchdog 强制重启 | 开机后约 30s（源材料案例） | SystemServer 关键服务超时所致 |

## 68.7 排故速查表：开机卡屏分层定位

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 无 kernel log | Bootloader/DTB 不匹配 | 串口看 ABL 输出；换 dtb 二分 |
| kernel 起但无 init 日志 | 分区挂载/fstab 错误 | dmesg 尾部 VFS 信息；avc 记录 |
| 有 Zygote 无 Launcher | SystemServer 崩溃循环 | logcat -b crash；watchdog ANR 记录 |
| 桌面出但应用全崩 | Binder/SELinux 大面积拒绝 | auditd 统计 top denied 补齐规则 |
| 服务反复重启 | seclabel 缺失/依赖服务未起 | logcat 过滤 init: Service 'x' exited；补依赖声明 |

卡屏定位口诀：看 `logcat -b events` 的 boot_progress 序列 + dmesg 时间轴对齐，找到第一处停顿棒次。

## 68.8 部署注意事项
1. seclabel 必配——缺失必被 SELinux 拒绝，域定义(.te)在 ch71 vendor 化落地
2. 启动后任务用属性触发编排：`on property:sys.boot_completed=1`，比 sleep 轮询体面得多
3. writepid 绑定 cgroup(top-app) 保证前台调度权重
4. 大版本升级必查 VINTF 兼容矩阵变化——老 HAL 可能被直接拒载(vintf_enforce 兼容期评估项)
5. bootanim 卡住三大元凶：SurfaceFlinger 未就绪 / keymaster 超时 / 某 critical 服务崩溃循环

> [!example]- 🧪 动手实验 L68-1：从 rc 到自启服务的全链（60 分钟）
> **步骤**：① 写一个 native 守护(C++，logcat 心跳)；② 放入 vendor 分区并写 rc 与 seclabel 占位；③ 刷机验证自启+崩溃自动重启(onrestart/restart 语义实测)；④ 故意删 seclabel 观察 avc denied 并按提示补策略；⑤ 用 setprop ctl.stop/restart 控制生命周期。**验收**：服务「活着、死了能复活、权限最小化」三达标。

## 68.9 进阶话题
- **属性触发的编排力**：`on property:sys.boot_completed=1` 串接开机后任务序列
- **bootanim 卡顿三元凶**：SurfaceFlinger/keymaster/critical 服务崩溃循环——event log 的 boot_progress 序列逐棒排查
- **与 systemd 对照**：rc service 与 unit 文件逐字段映射（[[ch56-启动流程深度剖析systemd提速]]）
- **守护同构**：SystemServer watchdog 与嵌入式三级守护设计同构（[[ch44-综合实战RK3568多协议边缘网关]]）

> [!warning]- ❓ FAQ
> **Q1：init.svc 状态机有哪些取值？** stopping/started/running 等，`getprop \| grep init.svc` 直接查看。
> **Q2：rc 语法的权威出处？** AOSP `system/core/init/README.md`——init 语法官方圣经。
> **Q3：为什么 App 不能自己 fork 多线程进程？** 见 68.3 三约束：多线程状态复制不安全、COW 写放大、GC 快照冻结。

> [!question] 📝 思考题
> 1. Zygote fork 与普通 fork 在 ART 虚拟机上有哪些额外约束？
> 2. 设计「安全模式」：只启动核心服务跳过第三方应用的启动方案。
> 3. 把 ch56 systemd 服务模板与 rc service 逐字段对照。

---
🏷️ #domain/android #topic/bootloader | 🔗 [[ch67-AOSP架构与源码编译]] ← **本章** → [[ch69-HAL演进与AIDL-HAL实战]] | 📚 [[P7-MOC]]
