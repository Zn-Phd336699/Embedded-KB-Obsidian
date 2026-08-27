---
title: "第38章 SoC启动链深度剖析"
part: "[[P4-MOC]]"
chapter: 38
tags:
  - domain/soc
  - topic/bootloader
difficulty: 4
est_minutes: 35
prerequisites:
  - "[[ch37-全志H3-OrangePiZero-NanoPiNEO实战]]"
related:
  - "[[ch39-U-Boot移植与网络开发模式]]"
  - "[[chsa-S1安全架构与SecureBoot实战]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第38章 SoC启动链深度剖析

> [!info] 导航
> ⏱ 35min | ★★★★☆ | 前置 [[ch37-全志H3-OrangePiZero-NanoPiNEO实战]] | → [[ch39-U-Boot移植与网络开发模式]]

## 🎯 学习目标
- [ ] 画出 BootROM→SPL→ATF→U-Boot→Kernel 五级启动链，说清每级职责边界与交接物
- [ ] 解释 TF-A(ATF) 驻留 EL3 的原因及 PSCI/SIP 服务的作用
- [ ] 用 earlycon 分界定位法把内核黑屏卡死定位到具体某一级
- [ ] 按 Bring-up 十步清单规划一块新板的完整点亮流程

## 38.1 五级职责表：SRAM 小世界 → DRAM 大世界

| 级 | 名称 | 核心职责 | 关键约束 |
|----|------|----------|----------|
| ① | BootROM | 芯片固化不可改；验签+加载 SPL 到 SRAM | 出厂即定，逻辑无法修改 |
| ② | SPL/TPL | SRAM 太小装不下完整 U-Boot → 先 init DRAM | 位置无关、无堆栈奢侈、printf 都没有 |
| ③ | ATF bl31 | EL3 安全监控常驻；PSCI 电源管理服务 | 运行期常驻不退出 |
| ④ | U-Boot | 加载内核+dtb；bootcmd/网络/存储 | DRAM 就绪后的开发主战场 |
| ⑤ | Linux Kernel | 解压→开 MMU→init→挂 rootfs 起用户态 | 进入 printk/earlycon 双保险世界 |

- **SRAM 阶段**（通常 ≤256KB）：代码位置无关、调试靠 JTAG 直连 + 芯片厂商 trace 工具；
- **DRAM 阶段**：有内存有串口有命令行 → 开发主战场，tftp/nfs 迭代；
- 裁剪差异：H3 可无 ATF 直接跳 U-Boot；RK3568 必须 ATF（PSCI 依赖）；Android 设备全链强制验签(AVB)。

## 38.2 ATF 到底干什么

1. **PSCI 服务**：Linux 请求「关核/睡眠/复位」时通过 SMC 指令陷入 EL3 处理——**没有 ATF，secondary CPU 起不来**；
2. **SIP 服务**：承载厂商私有功能（如 Rockchip 的 DDR 变频）——读 TF-A `services/std_svc/` 目录即懂 EL3 在忙什么；
3. **bl32 挂载**：OP-TEE 可选常驻，提供 TEE 安全世界（指纹支付类场景）。

## 38.3 earlycon：比 printk 更早的眼睛

在 MMU/driver model 就绪前直接轮询写 UART FIFO 输出。它是内核解压后黑屏卡死时的**第一诊断工具**——若 earlycon 也无输出，问题必在 U-Boot 传参或 dtb 的 chosen/stdout-path 节点。「分界定位法」的判据：最后一条输出停在哪一级，问题就藏在哪一级之后。

## 38.4 关键代码：earlycon 参数模板

```text
bootargs 加 earlycon（i.MX）：earlycon,imx_uart,0x20200000,115200
bootargs 加 earlycon（RK）  ：earlycon,8250,mmio32,0xfe660000
```

## 38.5 新板 Bring-up 十步清单（通用方法论）

1. 确认供电树各轨电压时序（示波器抓上电波形）；
2. JTAG/串口物理连通性验证；
3. 用厂商参考板的 SPL/loader 先点亮 DRAM（只改颗粒参数）；
4. 串口出 U-Boot banner；
5. eMMC/SD 驱动通 → 能 loady/tftp 加载内核；
6. 内核 + 参考板 dtb 先跑起来（不管外设对错）；
7. earlycon + console 双通道日志就位；
8. 逐个外设迁移 dts：每加一个 reboot 一次验证；
9. 根文件系统最小化启动（busybox init）；
10. 固化：从 NFS 切回本地 rootfs，制作量产镜像。

## 38.6 原理深挖：信任链的密码学构造

| 环节 | 验证对象 | 密钥/机制 |
|------|----------|-----------|
| BootROM→SPL | SPL 镜像哈希签名 | SoC 出厂熔丝(eFuse)存公钥哈希——根信任不可改 |
| SPL→U-Boot | u-boot.itb | SPL 内置公钥验签(同一密钥链) |
| U-Boot→Kernel | FIT 镜像逐组件 | U-Boot 公钥验 kernel/dtb/fdt 签名+hash |
| Kernel→rootfs | dm-verity 树哈希 | 每块校验，防运行期篡改(Android verified boot 同构) |

设计要点：**每一级的公钥由上一级保护**；任何一环跳过=整链作废。FIT 签名工程细节见 [[chsa-S1安全架构与SecureBoot实战]]。

## 38.7 平台差异总表：三家启动链一句话对照

| 平台 | DDR 初始化载体 | 安全固件 | 镜像打包工具 |
|------|----------------|----------|--------------|
| NXP i.MX | DCD 表内嵌 U-Boot 头 | HAB(AHAB) | mkimage_imx8 / imx-mkimage |
| Rockchip | 独立 TPL 固件 | rkbin bl31 | mkimage + trust 合包 |
| Allwinner | SPL 自带(sunxi 思路) | 可选 bl31(社区版常用) | mkimage(eGON 头) |

## 38.8 实测数据表：i.MX6ULL 冷启动耗时分解（168MHz/eMMC）

| 阶段 | 耗时 | 可优化性 |
|------|------|----------|
| BootROM+SPL(含 DDR 训练) | ~180ms | DDR 参数微调空间小 |
| U-Boot 到 bootz | ~350ms | 裁命令/关倒计时 → ~120ms |
| 内核解压+initcalls | ~900ms | 裁驱动+initcall 排序收益大 |
| 用户态到 shell | BusyBox ~400ms / systemd 2.8s | 参见 ch56 提速清单 |

全链 BusyBox 极限约 1.8s——「秒开」产品线的硬指标就是这样逐级分解出来的。

## 38.9 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| ROM 之后完全无声 | SPL 未被识别(偏移/签名头错) | hexdump 卡首 512B 查 eGON/imx 头；换已知好 SPL 对比 |
| SPL 打印 DRAM size 后死 | DDR 训练参数不稳 | 降频复测通过则调参；热风枪补焊查虚焊 |
| U-Boot 正常内核即死 | bootargs 错误/console 设备不对/dtb 不匹配 | earlycon 分界定位；printk.always_kmsg_dump 抓最后遗言 |
| secondary core 起不来 | 缺 ATF/PSCI 未启用/holding pen 地址错 | dmesg \| grep -i psci；核对 dts cpu-enable-method |

## 38.10 部署注意事项

1. SPL 尺寸红线：SRAM 通常 ≤256KB 且要留栈——往 SPL 里塞网络支持是大忌，一切等 DRAM 起来再说；
2. 量产镜像必须走完整验签链：跳过任一环等于整链作废；
3. bootROM 的 USB 下载模式是产线入口：uuu/mfgtool/rkdeveloptool 本质都是借 ROM 的最后一口气重建世界；
4. kernel printk 时间戳从 local timer 起，与 SPL/U-Boot 裸打印时间不对齐——跨级耗时分析用 GPIO 翻转+逻辑分析仪统一时基。

> [!example]- 🧪 动手实验 L38-1：earlycon 分界定位法实战（35 分钟）
> **步骤**：① 正常系统记录完整启动日志为基线；② 故意把 root= 改成不存在的设备制造卡死；③ 加 earlycon 重启，观察最后一条输出停在哪一级；④ 分别再制造 dtb 损坏/驱动缺失两种死法并对比分界点；⑤ 整理成「症状→卡死级别」速查卡。
> **验收**：三种人为故障都能在 2 分钟内说出卡在哪一级火箭。

## 38.11 进阶话题

- bl31 常驻服务清单：PSCI(cpu_on/off/suspend)+SMC 架构服务+厂商 SIP——EL3 运行期不退出的全部理由；
- 启动耗时分解仪表：各级时间戳打点位置选择（ROM 出口/SPL 出口/U-Boot banner/bootz/第一行 printk）；
- FIT 签名失败攻击推演：「替换镜像」靠哈希拦截，「替换密钥」靠密钥链逐级保护拦截；
- 扩展阅读：LWN「How the ARM64 Linux kernel boots」系列；TF-A `docs/getting_started/porting-guide.rst`；U-Boot `doc/develop/spl.rst`。

> [!warning]- ❓ FAQ
> **Q1：H3 为什么可以没有 ATF？**
> 社区方案里 H3 的多核使能不依赖 PSCI，SPL 可直接引导 U-Boot；RK3568 这类必须 bl31 提供 PSCI 的平台砍不掉。
> **Q2：earlycon 和 console= 有何区别？**
> earlycon 在 MMU/驱动模型就绪前轮询写 FIFO，不需要任何驱动框架；console= 是 tty 驱动接管后的标准通道，两者并存构成双保险。

> [!question] 📝 思考题
> 1. 为什么 SPL 必须位置无关（PIE）？链接脚本要满足什么约束？
> 2. 设计一个「启动耗时分解仪表」：各级时间戳从哪里打点最合适？
> 3. 推导 FIT 镜像签名验证失败的两种攻击场景及其防护差异。

---
🏷️ #domain/soc #topic/bootloader | 🔗 [[ch37-全志H3-OrangePiZero-NanoPiNEO实战]] ← **本章** → [[ch39-U-Boot移植与网络开发模式]] | 📚 [[P4-MOC]]
