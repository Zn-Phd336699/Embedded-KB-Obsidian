---
title: "第Z1章 导学与异构价值"
part: "[[P13-MOC]]"
chapter: "Z1"
tags:
  - domain/fpga
  - topic/soc
difficulty: 2
est_minutes: 25
prerequisites:
  - "[[SE-专家之路技能地图]]"
related:
  - "[[chz2-Z2-ZYNQ7020架构全景]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第Z1章 导学与异构价值

> [!info] 导航
> ⏱ 25min | ★★☆☆☆ | 前置 [[SE-专家之路技能地图]] | → [[chz2-Z2-ZYNQ7020架构全景]]

## 🎯 学习目标
- [ ] 说清 ZYNQ PS+PL 异构架构与纯 MCU、纯 FPGA 方案的本质区别
- [ ] 用「三问判据」判断一个需求是否值得上 FPGA/ZYNQ
- [ ] 完成 HDL 与软件编程的思维切换，说出 reg/wire/always 与 C 的映射关系
- [ ] 装好 Vivado/Vitis 工具链并通过 7020 器件库验证

## Z1.1 什么是异构 SoC：PS + PL
ZYNQ（AMD/Xilinx Zynq-7000 系列）是一颗**异构 SoC**：同一块硅片上集成两个世界——

- **PS（Processing System，处理系统）**：硬核 ARM 双核 Cortex-A9 + DDR 控制器 + 常规外设（UART/SPI/I2C/千兆网 MAC 等）。它是出厂固化好的 CPU 子系统，性能固定、不可重构。
- **PL（Programmable Logic，可编程逻辑）**：FPGA fabric——LUT/FF/BRAM/DSP 组成的可重构电路。你写 HDL 描述电路，综合器把它变成真实硬件。

二者不是两颗芯片的拼接，而是共享电源、时钟与 AXI 总线的整体。**软件管业务逻辑，硬件管数据通路**，这就是异构的价值公式。为什么嵌入式软件工程师要碰 FPGA？因为有些问题只有「把算法变成电路」才能解决。

## Z1.2 PS 与 PL 各自擅长域
| 维度 | PS（ARM 硬核） | PL（FPGA fabric） |
|------|----------------|-------------------|
| 执行模型 | 顺序执行指令流 | 海量并行电路同时工作 |
| 擅长 | 协议栈/UI/文件系统/网络业务 | 纳秒级 IO 时序、高速数据通路、并行加速 |
| 时延确定性 | 受 Cache/中断/OS 抖动影响 | 纯硬件，周期级确定 |
| 修改成本 | 重编译即可（分钟级） | 重综合实现（十分钟级以上） |
| 典型角色 | Linux 应用、控制与调度 | FIR 滤波、高速采集、自定义接口 |

一句话分工：**PS 是大脑，PL 是小脑与反射弧**——决策走 PS，反应走 PL。

## Z1.3 何时值得上 FPGA：三问判据
| 判据 | MCU 能做吗 | 纯 FPGA 能做吗 | ZYNQ 的独特价值 |
|------|------------|----------------|------------------|
| 需要 Linux + 纳秒级 IO 时序 | Linux 延迟不可控 ✗ | 无 CPU 跑 Linux ✗ | **PS 跑 Linux + PL 精确时序 ★** |
| 数据吞吐超过 CPU 处理能力（如高速 ADC 流） | CPU 瓶颈 ✗ | 可做但缺协议栈/UI ✗ | PL 做数据通路 + PS 做业务 ★ |
| 需要定制硬件加速器（专用滤波/加密/压缩） | 算力不够 ✗ | 可加速但无系统 ✗ | PL 加速核 + PS 调度 ★ |

三问全是"否"就留在纯 MCU；命中任意一问且还需要系统级软件，ZYNQ 就是甜点区。

## Z1.4 HDL 与软件编程的思维切换
从 C 转 Verilog，先换脑子再写代码：
```text
软件思维： 写一行执行一行，变量在时间轴上复用同一个寄存器
硬件思维： 所有语句并行存在——每行 Verilog 描述的是一块物理电路，
           它们在每一个时钟沿同时工作。
关键概念映射：
  C 变量      → 寄存器(reg) 或 导线(wire)
  if/else     → 多路选择器(MUX)
  for 循环    → 展开为 N 份重复电路(unrolled)——不是迭代！
  函数调用    → 电路实例化(instantiate)——每次调用多占一份面积
  while(1)    → 不存在——电路永远在"运行"
初学者最大陷阱： 把 Verilog 当 C 写 → 综合出非预期电路或锁存器(latch)。
```

## Z1.5 五章学习路径图
```text
Z1 导学(本章)
 └─▶ Z2 架构全景： PS/PL 边界、AXI 互联、时钟与复位 —— 一切的地图
      └─▶ Z3 PL 快速入门： Verilog 精要 + Vivado 七步流程 + 仿真
           │   目标产出： 一个 LED 闪烁 + 按键消抖的纯 PL 工程
           └─▶ Z4 PS 裸机 + PS-PL 协同： AXI-Lite 自定义 IP / DMA
                │   目标产出： ARM 通过 AXI 读写 PL 寄存器控制 LED
                └─▶ Z5 综合实战： PL FIR 滤波 + AXI-DMA → ARM 打包 MQTT
                     目标产出： 完整的 PS+PL 数据采集系统
```
深潜指引：完整 Vivado 截图操作/PetaLinux 全流程/软 PLC 项目，参阅工作区《ZYNQ-7020 嵌入式开发完全教程》对应章节。

## Z1.6 工具链与环境确认
| 工具 | 版本基准 | 用途 | 获取 |
|------|----------|------|------|
| Vivado ML Standard | 2020.2 ★教程口径 | PL 综合/实现/比特流生成 | xilinx.com 免费（WebPACK 许可覆盖 7020） |
| Vitis Unified IDE | 2020.2 | PS 裸机应用/FSBL/调试 | 随 Vivado 安装 |
| PetaLinux | 2020.2 | Linux BSP 构建(U-Boot/Kernel/rootfs) | xilinx.com（需 Linux 主机） |
| 串口终端 + JTAG | - | 调试/烧写 | 板载 USB-JTAG + UART |

## Z1.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 新建工程找不到 xc7z020 | License Manager 查看证书状态 | 重装勾选 Zynq-7000 器件支持 | 器件列表出现 xc7z020clg400-2 |
| 空模块综合报 license 错误 | Help→Manage License→View Status | 重新 Load License | 空工程综合无错完成 |
| 安装中断报磁盘不足 | 装前查可用空间 ≥60GB（典型值） | 换盘或清理旧版本 | 全套工具可正常启动 |

## Z1.8 实测数据表（典型值）
| 场景 | 软件(Cortex-A9) | 硬件(PL 并行) |
|------|------------------|----------------|
| 64-tap FIR ×1024 样本 | ~200µs（典型值） | ~10µs（典型值），约 20× |
| 高速 ADC 流预处理 | 受中断/Cache 抖动影响 | 周期级确定延迟 |
| 自定义时序协议解析 | 位翻转靠轮询，易丢沿 | 硬件逐沿捕获零丢失 |

## Z1.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| WebPACK 证书下载失败 | 账号未绑定/代理拦截 | 直连网络重新登录 AMD 账户获取证书 |
| 综合 7020 报器件不支持 | 安装漏勾 Zynq-7000 系列 | 重跑安装器补选器件包 |
| JTAG 识别不到板卡 | 驱动未装/USB 线接触不良 | 设备管理器核对 USB-JTAG 枚举状态 |
| 串口终端无输出 | 波特率不匹配(默认 115200)/COM 口选错 | 换终端逐一试常用波特率并核对端口号 |

## Z1.10 部署注意事项
1. 教程口径统一为 Vivado/Vitis/PetaLinux 2020.2，跨大版本 UI 与 IP 行为可能有差异。
2. 安装路径与工程目录避免中文和空格——Tcl 流程对特殊字符敏感。
3. Windows 主机全套安装磁盘占用可达 100GB（典型值），预留余量。
4. 先接好供电与 JTAG 再上电；带电插拔 USB-JTAG 易致枚举失败。
5. 本篇是概念地图级笔记，截图级实操请配合工作区《ZYNQ 教程》全文使用。

> [!example]- 🧪 动手实验 LZ1-1：Vivado 安装与许可证验证（60 分钟）
> **步骤**：① 注册 AMD/Xilinx 账号并下载 Vivado 2020.2 ML Standard；② 安装时勾选 Zynq-7000 器件支持 + DocNav；③ 启动后 Help→Manage License→Load License 加载 WebPACK 免费证书；④ 新建空工程选 xc7z020clg400-2（领航者核心）验证器件库可用。
> **验收**：能创建工程且综合一个空模块不报错、无 license 告警。

## Z1.11 进阶话题
- Zynq UltraScale+ MPSoC（A53+R5 多核+更大 PL）：本篇方法论可直接迁移。
- HLS 高层次综合：用 C/C++ 生成 RTL，降低门槛但牺牲微观控制力。
- 软核处理器（MicroBlaze/RISC-V）：在 PL 内再嵌一颗软 CPU 的第三形态。
- 动态部分重配置（PR）：运行期替换局部电路，进阶玩法。

> [!warning]- ❓ FAQ
> **Q1：必须先成为 FPGA 专家才能学 ZYNQ 吗？**
> A1：不需要。会「能让 LED 闪的 Verilog」+ Vivado 七步流程即可入门（见 Z3），复杂外设 IP 有图形化模板生成。
> **Q2：ZYNQ 对比 STM32 外挂 FPGA 方案好在哪？**
> A2：省掉两芯片间高速互连——片内 AXI 带宽高、延迟低且共享 DDR，软硬件共用一条 JTAG 调试链。
> **Q3：PL 掉电后配置还在吗？**
> A3：不在。SRAM 型 FPGA 掉电即失配，每次启动由 BootROM/FSBL 重新加载比特流（详见 Z2 启动链）。

> [!question] 📝 思考题
> 1. 你的当前项目中有哪个环节如果用 PL 实现会显著提升性能？
> 2. 解释为什么 Verilog 的 for 循环不能像 C 一样减少代码量。
> 3. ZYNQ 的 PS 和 PL 分别上电还是同时上电？启动顺序由谁决定？（预告 Z2）

---
🏷️ #domain/fpga #topic/soc | 🔗 [[SE-专家之路技能地图]] ← **本章** → [[chz2-Z2-ZYNQ7020架构全景]] | 📚 [[P13-MOC]]
