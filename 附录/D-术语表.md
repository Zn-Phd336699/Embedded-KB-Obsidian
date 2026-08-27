---
title: "附录D 术语表"
tags:
  - domain/fundamentals
  - topic/glossary
description: "嵌入式核心术语中英对照与一句话解释，按字母序排列，≥50 条，覆盖架构/RTOS/Linux/协议射频/工程方法五大类"
created: 2025-01-15
---
# 附录D · 术语表（中英对照 · 按字母序）

> 遇到陌生词先来这里。持续把新学到的术语补充进你自己的副本——这就是知识库的生长方式。主表按英文字母序，中文主导术语单列表格。

## A~F

| 术语 | 中文对照 | 一句话解释 |
|------|----------|------------|
| AAPCS | ARM 过程调用标准 | 规定函数间参数传递寄存器与栈布局的约定，读汇编必懂 |
| A/B Slot | 双分区槽位 | 固件双分区无缝升级机制，配合状态日志实现掉电安全切换 |
| ADR | Adaptive Data Rate 自适应速率 | LoRaWAN 按链路质量动态调整扩频因子与发射功率 |
| ATF | ARM Trusted Firmware | A 核安全监控固件，运行于最高异常级 EL3 |
| Binder | （Android IPC） | Android 系统进程间通信的「血管」，跨进程调用基础设施 |
| CCCD | Client Characteristic Configuration Descriptor | BLE 订阅开关描述符，客户端写它来使能 Notify/Indicate |
| Capability | 能力（seL4 权限对象） | seL4 的权限模型——「持有钥匙才能操作」，可传递可回收 |
| CSS | Chirp Spread Spectrum 线性扩频 | LoRa 的物理层调制方式，抗多径、远距离的核心 |
| DTB/DTS/DTC | 设备树二进制/源码/编译器 | 描述硬件拓扑的三件套：源码经编译器生成二进制供内核解析 |
| Device Tree Overlay | 设备树叠加片 | 在基础 DTB 上动态叠加/修改节点，支持扩展板热插拔描述 |

## G~L

| 术语 | 中文对照 | 一句话解释 |
|------|----------|------------|
| eDRX | 扩展不连续接收 | 蜂窝物联网休眠模式之一，延长寻呼监听周期省电 |
| EL3 | Exception Level 3 | ARMv8 最高异常级，ATF 安全监控态驻留于此 |
| EPROBE_DEFER | 驱动延迟探测 | 内核错误码：依赖设备未就绪时返回它让 probe 稍后重试 |
| FSPL | Free Space Path Loss 自由空间路径损耗 | 链路预算黄金三角之一，距离翻倍损耗 +6dB |
| GATT | Generic Attribute Profile 通用属性规范 | BLE 属性数据模型：Service → Characteristic → Descriptor 层级 |
| GIC | Generic Interrupt Controller | A 核通用中断控制器，对应 M 核的 NVIC |
| HIL | Hardware-in-the-Loop 硬件在环 | 测试台架把真实硬件接入闭环仿真，量产前回归主力 |
| Jitter | 抖动 | 实际执行时刻相对理想时刻的偏差，实时性两大量化指标之一 |

## M~R

| 术语 | 中文对照 | 一句话解释 |
|------|----------|------------|
| MaxHold | 峰值保持 | 频谱仪保持最大值轨迹的功能，扫信道占用必备 |
| MISRA C | （汽车 C 编码纪律） | 汽车行业 C 语言编码规范全集，静态检查工具据此设规则 |
| MMU | Memory Management Unit 内存管理单元 | 虚拟地址→物理地址翻译硬件，Linux 运行的前提 |
| MPU | Memory Protection Unit 内存保护单元 | 无地址翻译、只做区域权限保护的简化版，RTOS 常用 |
| MTU | Maximum Transmission Unit 最大传输单元 | BLE 单包上限，有效载荷 = MTU-3；也泛指链路包大小约束 |
| NAT 超时 | NAT Timeout | 运营商网络地址转换表项老化时间，蜂窝长连接保活的下界依据 |
| NVIC | Nested Vectored Interrupt Controller | M 核嵌套向量中断控制器，抢占/子优先级的硬件载体 |
| OTAA | Over-The-Air Activation 空中激活 | LoRaWAN 入网方式：入网请求换取会话密钥，比 ABP 安全 |
| Overlay | 叠加片 | 同 Device Tree Overlay 与 overlayfs 两义，按上下文区分 |
| PMP | Physical Memory Protection | RISC-V 物理内存保护，TrustZone 在 RISC-V 的对应概念之一 |
| pstore/ramoops | 崩溃日志持久化 | 重启前把内核日志写入保留 RAM 区，下次启动取回取证 |
| PSM | Power Saving Mode 省电模式 | NB-IoT/Cat1 深度休眠模式，休眠期间完全不可达 |
| PTA | Packet Traffic Arbitration 包流量仲裁 | WiFi/BLE 共存接口，2.4GHz 双射频分时仲裁 |
| regmap | 寄存器访问抽象层 | 内核统一 SPI/I2C/内存映射寄存器访问与缓存的框架 |
| RPA | Resolvable Private Address 可解析私有地址 | BLE 定期轮换且可被已配对设备解析的隐私地址 |

## S~Z

| 术语 | 中文对照 | 一句话解释 |
|------|----------|------------|
| S11 | 反射系数 | 射频端口反射与入射功率之比，NanoVNA 校准后的核心测量项 |
| SBOM | Software Bill of Materials 软件物料清单 | 产品全部软件组件及版本的清单，合规审计基础 |
| SF | Spreading Factor 扩频因子 | LoRa 每符号比特数，SF 越高越远越慢 |
| SIL | Software-in-the-Loop 软件在环 | 纯 PC 环境跑控制逻辑的仿真测试层级，先于 HIL |
| SMC | Secure Monitor Call 安全监控调用 | 非安全世界陷入 EL3 的指令入口 |
| squashfs | 只读压缩文件系统 | Linux rootfs 只读镜像标准格式，配 overlayfs 获得写视图 |
| sysroot | 目标根目录视图 | 交叉编译时「假装在目标板上」的头文件+库目录集合 |
| TAU | Tracking Area Update 跟踪区更新 | 蜂窝物联网空闲态周期性注册流程，决定唤醒节奏 |
| TLB | Translation Lookaside Buffer 翻译后备缓冲 | MMU 的地址翻译缓存，切换进程需刷新 |
| Toolchain Triple | 工具链三元组 | arch-vendor-os-libc 四段命名，如 aarch64-linux-gnu |
| Tickless | 免 tick 休眠 | RTOS 停掉周期 tick、用低功耗定时器定时唤醒的省电机制 |
| Treble | （Android 架构解耦革命） | 把厂商实现与 Android 框架用 HAL 接口隔离，可独立升级 |
| TrustZone | 安全世界 | ARM 硬件安全域划分：安全/非安全世界物理隔离 |
| UIO/VFIO | 用户态 IO 框架两兄弟 | 把设备寄存器/中断映射到用户态；VFIO 带 IOMMU 保护用于 DPDK 等 |
| VINTF | Vendor Interface 接口矩阵 | Android 框架与厂商实现的接口兼容性清单（manifest+matrix） |
| WCET | Worst-Case Execution Time 最坏执行时间 | 实时性两大量化指标之一，调度可行性分析的输入 |
| XIP | eXecute In Place 原地执行 | 代码不搬运到 RAM、直接从 Flash 取指执行 |
| Zygote | 孵化器 | Android Java 世界所有进程的共同父进程，fork 出应用进程 |

## 中文主导术语

| 术语 | 英文对照 | 一句话解释 |
|------|----------|------------|
| 黑匣子 | Black Box (pstore 三层级) | 崩溃现场持久化的工程统称：FRAM 黑匣子 / pstore / ramoops 逐级降级 |
| 优先级继承 | Priority Inheritance | 持锁低优任务临时继承等待者最高优先级，修复优先级翻转 |
| 优先级天花板 | Priority Ceiling | 拿锁即升至该锁预设天花板优先级，阻塞时间上界确定 |
| 链路预算 | Link Budget | 发射功率−路径损耗+增益 ≥ 灵敏度+余量的无线可行性计算 |
| 灵敏度 | Sensitivity | 接收机可解调的最低信号强度，链路预算右端门槛 |
| 驻波比 | VSWR 电压驻波比 | 天线端口匹配程度的度量，过大说明反射严重需查匹配 |

## 维护约定

- 新术语**首现章节内联解释**，稳定后收编进本表并保持字母序
- 解释控制在**一句话**，细节交给正文章节的 wiki-link
- 每季度用 LLM 做一次孤岛/重复检查（方法见 [[E-Obsidian×LLM工作流]]）

---
🏷️ #appendix #reference | 📚 [[附录-MOC]]
