---
title: "第Z2章 ZYNQ7020 架构全景"
part: "[[P13-MOC]]"
chapter: "Z2"
tags:
  - domain/fpga
  - topic/soc
  - topic/bootloader
difficulty: 3
est_minutes: 30
prerequisites:
  - "[[chz1-Z1导学与异构价值]]"
related:
  - "[[chz3-Z3-PL快速入门Verilog-Vivado七步流程]]"
  - "[[ch38-SoC启动链深度剖析]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第Z2章 ZYNQ7020 架构全景

> [!info] 导航
> ⏱ 30min | ★★★☆☆ | 前置 [[chz1-Z1导学与异构价值]] | → [[chz3-Z3-PL快速入门Verilog-Vivado七步流程]]

## 🎯 学习目标
- [ ] 画出 ZYNQ7020 的 PS/PL 资源分布与 AXI 互联拓扑
- [ ] 复述启动链 BootROM→FSBL→bitstream→U-Boot→Kernel 全流程与 BOOT.BIN 三段式
- [ ] 按场景为自定义 IP 选对 AXI 接口（M_AXI_GP/S_AXI_HP/S_AXI_ACP）

## Z2.1 芯片定位与资源全景
本章基准器件 **xc7z020clg400-2**（正点原子领航者核心板）。PS 与 PL 不是两颗芯片的拼接，而是同一块硅片上共享电源、时钟与总线的异构体——读懂架构图是所有后续开发的前提。

**PS 资源速查：**
| 资源 | 规格 | 备注 |
|------|------|------|
| APU | 双核 Cortex-A9 @767MHz + NEON/FPU | 512KB 共享 L2 + SCU 缓存一致 |
| DDR 控制器 | 支持 DDR3/LPDDR2，16/32bit | 板载 1GB DDR3 32bit |
| IOP 外设 | UART×2 SPI×2 I2C×2 CAN×2 SDIO×2 GEM×2 USB×2 | 经 MIO(54pin) 或 EMIO 由 PL 引出 |
| OCM | 256KB 零等待片上 RAM | FSBL 运行舞台 / 实时热代码 |
| SLCR | 系统级控制寄存器(@0xF8000000) | MIO 复用、PLL、时钟使能总开关 |

**PL 资源速查：**
| 资源 | 规格 | 备注 |
|------|------|------|
| 系统逻辑单元 | 85K（官方口径） | 由 LUT+FF 组合折算 |
| LUT / FF | 53,200 / 106,400 | 7 系列 6 输入 LUT |
| BRAM | 140 块 ×36Kb | 按 32Kb 双口有效位宽口径合计 560KB |
| DSP48E1 | 220 | 乘累加加速器，FIR/滤波主力 |
| CMT | 4 × (MMCM+PLL) | PL 内时钟综合与去抖 |
| XADC | 双通道 12bit @1MSPS | 片内电压温度监测 + 外部模拟输入 |

## Z2.2 AXI 互联五通道选型表
| 通道 | 方向 | 位宽 | 典型用途 | 本库使用点 |
|------|------|------|----------|------------|
| **M_AXI_GP0/1** | PS → PL | 32bit | CPU 读写 PL 寄存器(AXI-Lite) | ★ 所有自定义 IP 的控制口(Z4) |
| **S_AXI_HP0~3** | PL ↔ DDR | 64bit | 高带宽成批数据搬运 | ★ Z5 DMA 数据流 |
| S_AXI_ACP | PL ↔ L2 Cache | 64bit | 缓存一致性小数据交互 | 了解即可 |
| S_AXI_GP0/1 | PL ↔ PS 内存 | 32/64bit | 通用存储映射(少用) | - |
| 辅助信号组 | 双向 | - | FCLK_CLK0~3 / RESET / IRQ_F2P×16 | 时钟/复位/中断路由 |

记忆口诀：**GP 是配置面（寄存器），HP 是数据面（大流量），ACP 是一致性面（免刷 Cache）**。M/S 前缀站在 PS 视角：PS 当主机叫 M_AXI，PS 当从机叫 S_AXI。

## Z2.3 时钟树、复位与中断桥
| 信号组 | 方向 | 说明 |
|--------|------|------|
| FCLK_CLK0~3 | PS → PL | PS 三路 PLL(ARM/DDR/IO)派生的可配时钟，PCW 中设定频率 |
| FCLK_RESET0_N | PS → PL | PL 复位，随比特流加载释放 |
| IRQ_F2P×16 | PL → PS | PL 自定义中断进 GIC 共享中断区（另有 P2F 反向组） |
| CMT(MMCM/PLL)×4 | PL 内部 | 从 FCLK 再派生多路时钟，供不同逻辑域 |

要点：PL 自己不产生根时钟，一切以 FCLK 为源头；跨时钟域信号必须同步处理。

## Z2.4 启动镜像 BOOT.BIN 与启动链
```text
① BootROM(固化)： 上电后从 QSPI/NAND/SD/JTAG 选一加载 FSBL 到 OCM
② FSBL(First Stage Boot Loader)：
   - 初始化 DDR(ps7_init 函数)
   - 加载 PL 比特流到 PL 区(可选)
   - 加载 U-Boot 到 DDR 并跳转
③ U-Boot： 加载 kernel+dtb → bootz
④ Kernel → init → 用户态
⑤ PL 比特流加载时机：
   方式A： FSBL 中 xilfpga 加载(最常见)
   方式B： Linux 用户态 fpga manager 框架加载
   方式C： BootROM 直接从 QSPI 联合加载 BOOT.BIN
```
**BOOT.BIN = [FSBL.elf][bitstream][u-boot.elf]** 三段式镜像，由 bootgen 打包：
```text
// design_1.bif —— bootgen 打包描述文件
all:
{
    [bootloader] fsbl.elf
    design_1_wrapper.bit
    u-boot.elf
}
// 命令：bootgen -image design_1.bif -o i BOOT.BIN -w
```

## Z2.5 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| PL 逻辑偶发错乱 | ILA 同抓两个时钟域 | 统一时钟域或加两级同步器 | 错误率归零 |
| FCLK 与 PL 内时钟不一致 | Vivado Clock Report 对照 PCW 设置 | 改 PCW FCLK 或 PL 侧 MMCM 分频 | 两处频率一致且锁定 |

## Z2.6 实测数据表（典型值）
| 通道 | 理论量级(典型值) | 工程可用口径(典型值) |
|------|------------------|----------------------|
| M_AXI_GP(32bit) | 数百 MB/s | 寄存器单拍访问为主，批量仅 KB 级 |
| S_AXI_HP(64bit) | GB/s 级 | 数百 MB/s；Z5 口径 2KB/12µs ≈ 170MB/s 含开销 |

## Z2.7 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 上电无串口输出 | BOOT 模式跳线错/镜像未烧写 | 切 JTAG 模式用 XSDB 验证芯片活性 |
| FSBL 卡死在 DDR 初始化 | ps7_init 与板载 DDR 颗粒不匹配 | 重新生成 XSA；对照原理图核对 DDR 型号 |
| Linux 后 PL 外设不可见 | 设备树缺 PL 节点/fpga-region 未配 | cat /proc/device-tree；检查 compatible |

## Z2.8 部署注意事项
1. BOOT.BIN 必须三段齐全由 bootgen 打包；只烧 bitstream 上电不会跑系统。
2. BOOT 模式跳线（QSPI/SD/JTAG）要与烧写方式一致，「忘切跳线」是头号现场事故。
3. PL 比特流首选 FSBL 内 xilfpga 加载；Linux 运行期换 PL 用 fpga manager + 设备树 fpga-region。
4. ps7_init 与硬件版图强相关：PCW 改动后必须重导出 XSA 并重建 FSBL。
5. SLCR 基址 0xF8000000 是全局开关重地，裸机误写可能导致外设整体失能。

> [!example]- 🧪 动手实验 LZ2-1：GPIO 打点画启动瀑布图（45 分钟）
> **步骤**：① 在 FSBL/U-Boot/内核各阶段入口翻转独立 GPIO（方法同 [[ch38-SoC启动链深度剖析]]）；② 逻辑分析仪一次抓全链；③ 标注每段耗时并计算可压缩空间。
> **验收**：产出一张带实测数据的启动瀑布图，各段耗时可复现。

## Z2.9 进阶话题
- 安全启动：加密/认证比特流，BootROM 校验链延伸到 FSBL。
- OCM 地址重映射：把 256KB 切到高端地址给实时代码腾位置。
- ACP 一致性粒度：以 cache 行为单位交互，适合小数据免维护共享。

> [!warning]- ❓ FAQ
> **Q1：PS 和 PL 谁先"醒来"？**
> A1：PS 先。BootROM→FSBL 决定何时向 PL 送比特流；PL 没有独立引导能力，回答了 Z1 思考题第 3 问。
> **Q2：FCLK 只有 4 路不够用怎么办？**
> A2：在 PL 内用 CMT(MMCM/PLL) 从任一路 FCLK 倍频/分频派生更多时钟域。
> **Q3：为什么大流量搬运不走 GP 口？**
> A3：GP 是 32bit 配置面、面向寄存器访问；成批数据走 HP 口 64bit 直连 DDR 才能吃满带宽。

> [!question] 📝 思考题
> 1. 画出 M_AXI_GP 与 S_AXI_HP 的主从方向，解释为什么命名站在 PS 视角。
> 2. 若把 bitstream 从 BOOT.BIN 里拿掉，Linux 起来后访问 0x43C00000 会发生什么？
> 3. ACP 与 HP 都能到 DDR，什么时候值得放弃吞吐换缓存一致性？

---
🏷️ #domain/fpga #topic/soc #topic/bootloader | 🔗 [[chz1-Z1导学与异构价值]] ← **本章** → [[chz3-Z3-PL快速入门Verilog-Vivado七步流程]] | 📚 [[P13-MOC]]
