---
title: "第13章 探针实战 OpenOCD-JLink-probe-rs"
part: "[[P2-MOC]]"
chapter: 13
tags:
  - domain/fundamentals
  - topic/probe
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch12-GDB深度实战]]"
related:
  - "[[ch14-日志系统设计RTT与远程回传]]"
  - "[[ch22-STM32生态与F407硬件]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第13章 探针实战：OpenOCD / J-Link / ST-Link / probe-rs

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch12-GDB深度实战]] | → [[ch14-日志系统设计RTT与远程回传]]
> SWD 两根线承载烧写、断点、日志、供电检测的全部能力——本章讲透连接序列、救砖与选型。

## 🎯 学习目标
- [ ] 理解 JTAG/SWD 协议差异、引脚定义与常见接线错误
- [ ] 独立完成 OpenOCD cfg 组合、J-Link Commander、probe-rs CLI 操作
- [ ] 说清 connect-under-reset 救砖时序与 RTT/SWO 选型依据（第14章前置）

## 13.1 接口与探针生态对照

| 接口 | 引脚 | 特点 |
|------|------|------|
| JTAG | TCK TMS TDI TDO (+TRST NRST) | 菊花链多器件；引脚多；A核常用 |
| SWD | SWCLK SWDIO (+NRST) | M核标配两线搞定；支持低功耗休眠唤醒 |
| 其他 | RISC-V 用 JTAG-DTM | ESP32 另有 USB-JTAG/Serial 外设 |

| 探针 | 价格档 | 强项 | 短板 |
|------|--------|------|------|
| ST-Link V2/V3 | ¥15~150 | STM32 官方、SWO 支持、便宜 | 非 ST 芯片功能受限（V2 克隆版） |
| J-Link BASE/EDU | ¥300~3000 | 芯片支持广、RTT 成熟、速度快 | 正版贵；EDU 禁商用 |
| DAP-Link(CMSIS-DAP) | ¥20~60 | 开源协议免驱动，probe-rs 原生支持 | 速度中等 |
| Black Magic Probe | ¥200+ | 内置 GDB Server 免 OpenOCD | 生态小众 |

## 13.2 SWD 连接序列与 connect-under-reset 原理

```text
标准连接序列：
① 主机在 SWCLK 上发 >50 个周期 SWDIO=1（line reset）
② 发 JTAG-to-SWD 切换序列 0xE79E770E(LSB先) + 再 line reset
③ 读 DP_IDR 验证链路活着 → 上电 DP/AP 电源域请求

connect-under-reset 为什么能救「睡死/引脚被抢」的芯片：
  NRST 拉低期间内核停摆但调试域仍供电 → 主机趁内核未跑用户代码
  （还没把 SWD 引脚复用成 GPIO）抢先完成握手 → halt 后再谈别的
OpenOCD 配方：
  reset_config srst_only srst_nogate connect_assert_srst
  adapter srst delay 100        # 复位保持 ms 数按板子 RC 调整
```

## 13.3 关键代码：三大探针工具实操

```bash
# OpenOCD 三段式cfg：接口 + 目标 + 板级；telnet(:4444)：reset halt /
# flash write_image erase fw.bin 0x08000000 / verify_image / reg / bp ... 2 hw
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg \
        -c "adapter serial 066BFF..." -c "transport select swd"
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg \
  -c "program build/fw.elf verify reset exit"      # 一条龙烧写(CI友好)
```

```text
# myboard.cfg —— 三段式组合，团队入库统一入口
source [find interface/stlink.cfg]
transport select swd
source [find target/stm32f4x.cfg]
adapter serial 066BFF383234...      # 多探针时锁定唯一设备
adapter speed 4000                  # 排障期降到1000再逐步升
reset_config srst_only srst_nogate
# 烧写： openocd -f myboard.cfg -c "program build/fw.elf verify reset exit"
```

```text
JLinkExe: device STM32F407VE ; si SWD ; speed 4000 ; connect
          erase / loadfile fw.bin / r / g / mem32 0x20000000,16 / q
          RTTServer / RTTClient —— ch14 日志通道
probe-rs（Rust系新贵）:
  probe-rs list                          # 枚举探针
  probe-rs download --chip STM32F407ZGTx build/fw.elf
  probe-rs gdb --chip ...                # 起 gdb server；另有 reset/read 子命令
  probe-rs rtt --chip ...                # 直接看RTT日志
优势： 无需脚本知识、错误信息人性化、RTT 控制块自动发现。
```

## 13.4 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 时好时坏连不上 | 示波器看 SWCLK 波形质量 | 杜邦线 <20cm 且共地良好；降速 1000 | 连续 10 次 connect 成功 |
| 烧写校验失败 | 查电源跌落与 WRP 位 | 探针侧独立稳压；降速重试 | verify_image 通过 |
| RTT 收不到日志 | map 定位 \_SEGGER_RTT 地址 | 手动指定控制块地址或改用 probe-rs 自动扫描 | 日志流恢复输出 |

## 13.5 实测数据表：RTT vs SWO 选型对照（F407@168MHz 实测）

| 维度 | RTT(Segger) | SWO(ITM) |
|------|-------------|----------|
| 实测吞吐 | >1MB/s（探针轮询快时） | ~2MB/s（TPIU@84MHz） |
| CPU 开销/行 | memcpy 级 ~1µs | ITM 写寄存器 ~0.3µs |
| 探针要求 | 任意 SWD 探针（probe-rs 支持） | 必须接 SWO 引脚+支持工具 |
| 掉线行为 | 缓冲满丢新数据可统计 | FIFO 满静默丢弃 |

结论：调试期首选 RTT（通用性）；量产黑匣子另走 Flash 通道，详见 [[ch14-日志系统设计RTT与远程回传]]。

## 13.6 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 探针灯亮找不到芯片 | VTref 无电平；SWDIO/SWCLK 接反；缺共地 | 万用表量 3.3V；对照丝印；补 GND |
| 芯片深度睡眠连不上 | 内核已跑走抢了 SWD 引脚 | NRST 反复复位+connect under reset（配方 13.2） |
| SWD 引脚被复用成 GPIO / 读保护 RDP | 固件自锁调试口；量产固件开了保护 | BOOT0=1 进系统 bootloader 救砖重刷；或 J-Link unlock / mass erase |
| A 核 halt 后系统卡死 | halt 时外设仍在跑超时连锁 | 调试期关看门狗；分离调试与运行配置 |

## 13.7 部署注意事项

1. 自定义板 cfg 入库统一入口，禁止口头传命令。
2. 多探针工位必须 adapter serial 锁定唯一设备防串扰。
3. 杜邦线 >20cm 时 4MHz 经常误码，降速 960kHz 先保通再优化。
4. 产线批量：ST-Link 克隆版禁商用；选 J-Link Flasher 或脚本化 probe-rs+USB hub 分位。

> [!example]- 🧪 动手实验 L13-1：一次完整的救砖演练（40 分钟）
> **步骤**：① 把 PA13/PA14 配成普通 GPIO 并烧录（模拟调试口自锁）；② 正常 connect 观察失败；③ 按 13.2 配置 connect-under-reset 成功挂上；④ 重刷正确固件恢复；⑤ 记录每步现象与耗时。**验收**：以后遇「连不上」第一反应是检查复位策略而不是怀疑硬件坏了。

## 13.8 进阶话题

- **RTT 多通道分工**：CH0 文本日志、CH1 二进制遥测（结构体直写）、CH2 下行控制命令。
- **多核 daisy-chain**：RK3588 双簇核共享 DAP 时用 `targets` 切上下文，忘切会「写 A 核落到 B 核」。
- **ADIv5 分层与社区**：DP/AP/SW-DP 协议是所有探针行为的底层依据，可解释九成怪象；probe-rs TDF 是新芯片支持通道，BMP 固件源码是 gdbserver 层最佳教材。

> [!warning]- ❓ FAQ
> **Q1：SWD 比 JTAG 少了什么？** 少菊花链多器件与部分边界扫描便利；SWD 经 DP 访问 JTAG-AP 仍可级联多核 DAP。
> **Q2：为什么烧写瞬间容易校验失败？** 大电流尖峰拉低电源致写入时序异常——独立稳压+降速是最快的两条对策。

> [!question] 📝 思考题
> 1. 用 probe-rs 实现 CI 流水线「烧写+冒烟自检+取回日志」三步脚本。
> 2. 推导 connect-under-reset 完整时序：NRST 拉低→何时发 SWJ 序列→为何能救睡死的芯片。

---
🏷️ #domain/fundamentals #topic/probe | 🔗 [[ch12-GDB深度实战]] ← **本章** → [[ch14-日志系统设计RTT与远程回传]] | 📚 [[P2-MOC]]
