---
title: "ZYNQ架构与硬件资源详解"
date: 2025-09-09
category: "ZYNQ异构"
tags: ["ZYNQ", "FPGA", "架构", "硬件"]
description: "ZYNQ-7000家族架构、XC7Z020资源、PS-PL互联、领航者开发板硬件、Vivado开发环境搭建"
---

# ZYNQ架构与硬件资源详解

> ZYNQ-7000家族架构、XC7Z020资源、PS-PL互联、领航者开发板硬件、Vivado开发环境搭建

## 目录

1. [[#ZYNQ 架构详解|ZYNQ 架构详解]]
2. [[#领航者开发板硬件资源|领航者开发板硬件资源]]
3. [[#开发环境搭建|开发环境搭建]]

---

## 第2章 ZYNQ 架构详解
读懂这颗芯片的「两张地图」：资源地图与总线互联图 —— 后续所有开发都在这张图上进行。

**🎯 学习目标**
- 掌握 XC7Z020 的 PS 与 PL 资源构成及关键参数
- 理解 PS-PL 五类 AXI 互联通道的用途与选型
- 记住关键地址空间分区，能看懂 Vivado 分配的 IP 基地址

### 2.1 ZYNQ-7000 家族与 XC7Z020 定位
ZYNQ-7000 系列共享相同的 PS（双核 A9），差别主要在 PL 规模。**7020 是性价比与生态的黄金档**，也是国内教学与工业小批量产品的主流选择。

| 器件 | 系统逻辑单元 | LUT | BRAM(36Kb) | DSP48E1 | PS 部分 

| Z-7010 | 28K | 17,600 | 60 | 80 | 相同：双核 Cortex-A9
NEON+FPU、512KB L2、
256KB OCM、DDR 控制器 

| **Z-7020 ★** | **85K** | **53,200** | **140 (4.9Mb)** | **220** 

| Z-7030 | 125K | 78,400 | 265 | 400 

| Z-7045 | 350K | 218,600 | 545 | 900 

### 2.2 整体架构一张图

PS 处理器系统（硬核 ARM）
PL 可编程逻辑（FPGA）
APU 应用处理单元2× Cortex-A9 @767MHz(-2) · NEON/FPU每核 32KB L1-I/D · 共享 512KB L2 · SCU
DDR 控制器板载 1GB DDR3·32bit
OCM 片上存储256KB · 低延迟
IOP 外设（MIO 引脚复用）GPIO×54 · UART×2 · SPI×2 · I2C×2 · CAN×2SDIO×2(TF/eMMC) · USB2.0 OTG×2 · 千兆网 MAC×2QSPI 控制器（启动固件存放处）
中央互联 Central Interconnect + DMA×8通道SLCR 系统控制@0xF8000000 · 时钟 PLL×3
GIC 中断控制器（SPI 32~95）私有定时器/WDT · 全局定时器BootROM 128KB（固化启动代码）
可编程资源 XC7Z020LUT×53,200 · FF×106,400 · BRAM 4.9MbDSP48E1×220 · MMCM/PLL×4 · XADC 双12位
用户自定义逻辑区（本课程重点）AXI 从设备：寄存器接口（第9章）DI滤波 / DO驱动 / PWM发生器（第27章）XADC 采集控制 / 中断汇聚（第27章）ILA/VIO 调试核（第21章）高速算法：并行滤波/图像预处理…
PL 时钟与复位输入 FCLK_CLK0~3（PS 提供）复位 FCLK_RESET0~3
HP 高性能端口 ×4S_AXI_HP0~3 直连 DDR 控制器64bit · 大数据量搬运专用
- 
M_AXI_GP0/1
配置PL寄存器

S_AXI_HP0~3
PL→DDR大搬运

IRQ_F2P ×16
PL事件上报
另有 S_AXI_ACP（缓存一致性）/ S_AXI_GP（通用）通道，详见正文表格

图2-1 ZYNQ-7020 架构与 PS-PL 关键互联通道（简化版，完整框图见 UG585 Figure 3-1）

### 2.3 PS：一个被低估的「完整 SoC」
#### ① APU 应用处理器单元

双核 **ARM Cortex-A9**，领航者所用 -2 速度等级最高 767MHz；每核带 **NEON SIMD + VFP 浮点**，32KB L1 指令/数据缓存。
- **512KB 共享 L2 缓存** + SCU 缓存一致性单元——这是它能流畅运行 Linux 的根本；也是 S_AXI_ACP 通道能让 PL 直接读写缓存的原因。
- 每核私有 32 位定时器与看门狗，另有全局定时器——裸机篇的定时实验主角。

#### ② 存储系统

- **DDR 控制器**：支持 DDR3/DDR3L/DDR2/LPDDR2，16/32 位总线。领航者板载 1GB DDR3（32bit）。注意：PS 的 DDR 控制器是**唯一**的物理 DDR 入口，PL 不能绕过它直接访问内存条，只能经 S_AXI_HP 端口排队。
- **OCM 256KB** 片上 RAM：零等待访问，常用于 FSBL、实时性苛刻的中断向量/热代码。映射在 0xFFFC0000（高端）或 0x00000000（低端别名）。
- **BootROM 128KB**：芯片出厂固化，决定上电后第一段代码从哪里读（SD/QSPI/JTAG），第12章详解。

#### ③ IOP 与 MIO
54 根 **MIO**（Multiuse I/O）把 PS 外设引到芯片管脚，每个外设可路由到多组候选引脚，由 SLCR 寄存器选择。当 54 根不够用时，可通过 **EMIO** 把 GPIO/UART 等借道 PL 引出。记住两个常用基地址：`GPIO=0xE000A000`、`UART1=0xE0001000`（领航者的调试串口接 UART1）。

### 2.4 PL：Artix 级可编程逻辑

| 资源 | 数量 | 通俗理解 

| LUT6 查找表 | 53,200 | 实现任意 6 输入组合逻辑的「万能门」 

| FF 触发器 | 106,400 | 时序状态存储，1 bit 一个 

| BRAM 块存储 | 140×36Kb≈4.9Mb | 双口 RAM/ROM/FIFO 硬核，做缓存与缓冲池 

| DSP48E1 | 220 | 25×18 乘加硬核，滤波器/FIR/矩阵运算主力 

| CMT 时钟管理 | 4 组（MMCM+PLL） | 倍频/分频/移相，生成各模块所需时钟 

| XADC | 双通道 12bit 1MSPS | 片内电压温度监测 + 最多17路外部模拟输入，PLC篇模拟量采集的基础 

💡 容量直觉
5 万多个 LUT 对入门项目绰绰有余：一个带滤波的 16 通道 DI 模块约占几百个 LUT，一个 AXI-Lite 从接口约 300~500 个 LUT，软 PLC 项目全部自定义逻辑合计通常 <5000 LUT（<10%）。真正的瓶颈往往是 IO 数量与布线拥塞，而不是容量。

### 2.5 PS-PL 互联：五类通道怎么选？

| 通道 | 方向 | 位宽 | 典型用途 | 本课程使用点 

| **M_AXI_GP0/1** | PS → PL | 32/64b | CPU 读写 PL 侧 IP 寄存器（AXI-Lite 为主） | ★ 第9章起所有自定义 IP 的控制口 

| **S_AXI_HP0~3** | PL → DDR | 64b | 高带宽成批数据（视频帧、ADC 数据流） | 扩展实验：XADC 连续采集 DMA 

| S_AXI_ACP | PL ↔ L2 | 64b | 缓存一致的小数据交互、低延迟 | 了解即可 

| S_AXI_GP0/1 | PL ↔ PS 内存 | 32/64b | 通用存储映射，较少用 | 了解即可 

| 辅助信号组 | 双向 | - | FCLK_CLK0~3 时钟、FCLK_RESET0~3 复位、IRQ_F2P 16 根中断、EMIO | ★ PLC IO引擎用 CLK0+IRQ_F2P[0] 

一句话选型：**控制类小数据走 M_AXI_GP（AXI-Lite），数据类大流量走 S_AXI_HP（配 DMA），事件通知走 IRQ_F2P**。软 PLC 的 IO 引擎恰好三条全用到，第四篇将实战串联。

### 2.6 关键地址空间速查

| 地址区间 | 归属 | 备注 

| 0x0000_0000 起 | DDR 低端 / OCM 低别名 | Linux 内核加载于此 

| 0xE000_0000 ~ 0xE02F_FFFF | PS I/O 外设 | UART0=E0000000、UART1=E0001000、I2C0=E0004000、SPI0=E0006000、CAN0=E0008000、GEM0=E000B000、QSPI=E000D000、GPIO=E000A000、SD0=E0100000 

| 0xF800_0000 | SLCR 系统级控制 | MIO 复用、PLL、时钟使能的总开关 

| 0xF8F0_1000 | GIC 中断分发器 | CPU 接口在 0xF8F0_0100 

| 0xFFFC_0000 | OCM 高端映射 | FSBL 运行舞台 

| 0x43C0_0000 ~ 0x7FFF_FFFF | M_AXI_GP0 窗口 | Vivado 给自定义 IP 分配的默认落点（如 0x42C00000/0x43C10000 等） 

| 0x8000_0000 ~ 0xBFFF_FFFF | M_AXI_GP1 窗口 | - 

### 2.7 四种开发模式与课程对应

| 模式 | 说明 | 对应章节 

| 纯 FPGA 开发 | 只用 PL，Verilog 描述电路，JTAG 烧写 bitstream | 第5、6章 

| PS 裸机（Bare-metal） | C 语言直操作寄存器/库函数，无 OS，实时性最好 | 第7~10章 

| Linux 系统 | U-Boot 启动内核，驱动与应用分层，生态最强 | 第二篇 

| AMP 非对称多核 | 核0跑 Linux、核1跑裸机实时任务（或双裸机） | 拓展方向（第36章展望） 

本课程的软 PLC 采用 **Linux 模式**：PS 上的 Linux 承担梯形图解释、Modbus 通信与 Web 服务，PL 承担毫秒级以下的 IO 采样与输出驱动，两者通过 AXI 寄存器 + 中断协作——这就是工业界「软 PLC」的标准姿势。

### 常见问题 FAQ（避坑指南）
Q1：A9 只有 767MHz，会不会太弱跑不动 Linux？不会。Cortex-A9 带 MMU 与 L2 缓存，单核性能约为同频 Cortex-M7 的数倍，双核跑轻量 Linux（无桌面）非常流畅。真正要担心的是**实时性**而非算力——这正是我们把硬实时 IO 放到 PL 的原因。

Q2：PL 的逻辑掉电后会丢失吗？会。FPGA 基于 SRAM 工艺，配置信息掉电即失。因此每次上电都要由 PS 侧启动链从 QSPI Flash 或 TF 卡加载 bitstream（第12章）。这也是为什么最终交付物是打包在一起的 BOOT.BIN（FSBL+bitstream+U-Boot）。

Q3：M_AXI_GP 的带宽够用吗？对寄存器型访问完全够（每次事务几十纳秒级）。但如果要从 PL 向内存连续搬 ADC 流数据，请改用 S_AXI_HP + DMA，GP 口的仲裁延迟会让吞吐掉到几十 MB/s 以下。

Q4：为什么我的自定义 IP 在地址编辑器里显示的基址和教程不一样？Vivado 会根据已用空间自动排布，只要落在 GP0 窗口（0x43C00000~0x7FFFFFFF）内且不与其他 IP 重叠即可。记录下你自己的基址，后续软件代码以它为准，不要照抄教程数值。

**📝 思考题**
- 设计一个「100kHz、4通道应变片信号采集 + 上位机曲线显示」的系统，说明采集链路应放在 PS 还是 PL？数据应通过哪条 AXI 通道回传？为什么？
- 查阅 UG585 附录 B（寄存器汇总），找到 GPIO 模块的 MASK_DATA_LSW 寄存器偏移，计算它在地址空间中的绝对地址。
- 如果 PLC 输出脉冲控制步进电机，脉冲频率需要精确稳定，这个任务放 PS 还是 PL？若放 PL，CPU 如何设定频率与使能？

### 2.8 深潜：电源域与时钟树（硬件认知盲区扫除）

| 电源轨 | 典型值 | 供给对象/注意点 

| VCCINT | 1.0V | PL 核电压，电流大头（上电顺序最优先） 

| VCCAUX | 1.8V | PL 辅助 + XADC 参考 

| VCCO_INT? | 1.8V | PS IO 辅助（MIO 逻辑） 

| VCCO_MIO0/1 | 3.3V/1.8V | MIO 两个 Bank 独立电平 —— MIO 电平由它决定 

| VCCO_PL(bank34/35) | 按板卡 | PL IO 电平 → XDC IOSTANDARD 必须与其一致(3章Q2) 

| VCCPINT/VCCPAUX/VCCOADJ | 1.0/1.8/1.5? | PS 核与辅助；VCCO_DDR 随 DDR 类型(1.5V DDR3) 

- **上电顺序**：VCCINT→VCCAUX→VCCO…（数据手册 Table 顺序），板卡由电源芯片好信号级联保证 —— 自研底板必查项；
- **PS 时钟树**：33.33MHz 进 → 三 PLL(ARM/DDR/IO) 各自倍频 → SLCR 分配外设时钟；改 ARM 频率=改 PLL 参数（Vivado PS 配置自动算），运行期不可乱动 —— 解释了 7 章「波特率随 PLL 变」的现象；
- **PL 时钟**：FCLK_CLK0~3 由 IO PLL 分频而来，频率在 PS 配置页设定（默认100MHz），BD 中作为 AXI 与自定义逻辑时钟 —— 与 22 章 CDC 纪律直接挂钩。

[← 上一篇第1章 课程导学与学习路线图](#ch01)
[下一篇 →第3章 领航者开发板硬件资源](#ch03)

---

## 第3章 领航者开发板硬件资源
磨刀不误砍柴工 —— 学会「读板」：看懂资源分布，掌握从原理图反查 FPGA 引脚的方法。

**🎯 学习目标**
- 熟悉领航者开发板的存储、时钟、通信与调试资源
- 掌握「原理图 → 网络标号 → 引脚约束」的查图方法论
- 能独立编写 XDC 引脚约束文件

### 3.1 板卡资源总览
领航者ZYNQ采用核心资源一体的板卡设计，围绕 **XC7Z020-2CLG484** 展开。以下资源清单请对照你手中的板卡逐一确认：

| 类别 | 资源 | 说明与用途 

| 存储 | DDR3 SDRAM ×1GB | 32bit 数据位宽，Linux 运行主内存 

| QSPI Flash（W25Q256，32MB） | 存放固化 BOOT.BIN（FSBL+bitstream+U-Boot），掉电不丢 

| eMMC（8GB） | 大容量根文件系统/数据存储 

| MicroSD 卡座 | 日常开发主力：启动卡 + NFS 替代方案 

| 显示与人机 | HDMI 输出、RGB LCD 接口、OLED 接口 | 进阶显示实验；本课程主线不依赖 

| 通信 | 千兆以太网口（RGMII PHY） | NFS/TFTP 开发、Modbus TCP、Web 监控 —— PLC 篇关键通道 

| USB2.0 OTG | U 盘/网口 gadget 实验（选学） 

| USB 转串口（板载） | 连接 PS UART1，Linux 控制台 console 

| 调试 | 板载 USB-JTAG 下载器 + UART | 一根 USB 线完成烧写与串口，无需外购下载器 

| 用户交互 | PL 用户 LED、轻触按键、拨码开关若干 | 基础实验的「示波器」；具体数量见丝印与原理图 

| 扩展 | 扩展排针（引出部分 PL IO 与电源） | PLC 篇 DI/DO/PWM 外接端子来源 

| 时钟复位 | PL 全局时钟晶振（50MHz）、PS 参考时钟（33.33MHz）、复位按键 | XDC 中 create_clock 的对象 

📌 以原理图为唯一事实来源
不同批次板卡的 LED/按键数量与引脚可能调整。**本课程所有涉及具体引脚的位置都要求你自己查一遍原理图与随板 XDC 文件**——这既是纪律也是技能：工业项目里，硬件工程师交接给你的永远是原理图，而不是教程截图。

### 3.2 核心方法：三步从原理图找到引脚
以「点亮一个 PL 用户 LED」为例，完整走一遍查图流程：

- **在原理图中定位元件**：打开随板 PDF 原理图，搜索元件位号（如 D1）或网络名（如 `LED0`），确认 LED 的驱动极性——限流电阻接 VCC 则低电平点亮（多数板卡如此），反之高电平点亮。这一步决定你代码里写 `led ```
# led.xdc —— 引脚约束示例（引脚号务必按你的原理图修改！）
set_property -dict {PACKAGE_PIN H17 IOSTANDARD LVCMOS33} [get_ports {led[0]}]
set_property -dict {PACKAGE_PIN K15 IOSTANDARD LVCMOS33} [get_ports {led[1]}]

# PL 50MHz 系统时钟（同样需查图确认引脚）
create_clock -period 20.000 -name sys_clk [get_ports sys_clk]
set_property -dict {PACKAGE_PIN N18 IOSTANDARD LVCMOS33} [get_ports sys_clk]
```

### 3.3 启动相关的三个硬件开关
ZYNQ 的启动介质由 **MIO 配置引脚的电平**决定（BootROM 上电采样），板上以拨码开关/跳线帽形式暴露：

| 启动模式 | 用途 | 本课程场景 

| JTAG | Vivado 直接下载 bitstream / 裸机 ELF，掉电丢失 | 第6章流水灯、第7~10章裸机、ILA 调试 

| QSPI Flash | 上电自动从 32MB SPI Flash 启动 | 产品化交付（第34章系统集成） 

| SD 卡（TF） | 上电从 FAT 分区读 BOOT.BIN | 日常 Linux 开发首选 

| eMMC / NAND | 备选介质 | - 

日常开发的标准姿势：**JTAG 调试 + SD 卡启动双模式随时切换**。每次烧写前先确认拨码位置，这是新手最常见的「为什么没反应」原因 Top1。

### 3.4 为 PLC 实战预埋的硬件视角
第四篇软 PLC 需要「像模像样」的工业 IO。利用扩展排针即可搭建最小验证环境：

- **DI 数字量输入**：排针 IO → 按键/开关模块模拟现场按钮（PL 内做 10ms 消抖滤波）；
- **DO 数字量输出**：排针 IO → LED 或光耦继电器模块（弱电演示；如接真负载必须加隔离并遵守安全电压）；
- **AO/PWM**：PL PWM 输出 → RC 滤波得模拟量，或直接驱动风扇测速；
- **AI 模拟量**：电位器分压 0~1V 接入 XADC 专用于通道（查原理图确认 VP/VN 或 VAUXP 引脚走线）。

🚨 安全红线
本课程所有 IO 实验默认 **3.3V 弱电**。若确需驱动继电器控制市电设备：必须使用带光耦隔离的继电器模块、强弱电端子严格分离、由具备电工资质的人员操作市电侧。初学阶段强烈建议仅用 LED/蜂鸣器演示逻辑。

### 常见问题 FAQ（避坑指南）
Q1：插上 USB 后电脑识别不到板载下载器/串口？① 更换 USB 线（部分线材只供电无数据芯）；② Windows 设备管理器查看有无黄色感叹号，手动安装随板资料的 USB-JTAG/串口驱动；③ 禁用笔记本的 USB 节能选项；④ Linux 虚拟机需在 VMware 中把该 USB 设备「连接到虚拟机」。

Q2：必须用 QSPI 启动吗？只用 SD 卡可以完成全部课程吗？可以。SD 卡启动完全覆盖学习需求（BOOT.BIN 放 FAT 分区即可）。QSPI 固化只在最后「产品形态」演示时体验一次。注意 QSPI 写入次数有限且擦除较慢，频繁迭代开发不要用它。

Q3：HDMI、LCD 这些外设教程不讲，是不是买亏了？没有。它们是很好的自学延伸题（如 HDMI 输出字符、LCD 触摸画板），官方资料中心有配套例程。本课程聚焦工业控制主线，显示需求由 Web 监控界面承担——这也是真实工控产品的形态（无头设备 + 浏览器访问）。

Q4：怎么确认我的板子是 7020 而不是 7010？① 看核心芯片丝印 `XC7Z020-2CLG484`；② Vivado 工程建好后打开 synthesized design，Utilization 报告里 LUT 总量约 53,200 即为 7020（7010 约 17,600）。买错型号不影响前 10 章学习，但第四篇余量会紧张。

**📝 思考题**
- 在你的原理图中找到两个用户按键的网络名、FPGA 引脚号与电平有效极性，写成 XDC 片段。
- 为什么 XDC 里除了 PACKAGE_PIN 还必须指定 IOSTANDARD？如果 Bank 电压是 1.8V 却配了 LVCMOS33 会怎样？
- 设想把板子交付给客户现场部署，启动模式应设为哪种？为什么 JTAG 模式不适合量产？

[← 上一篇第2章 ZYNQ 架构详解](#ch02)
[下一篇 →第4章 开发环境搭建](#ch04)

---

## 第4章 开发环境搭建
一次装对，全程受益 —— Windows 侧 Vivado/Vitis + Ubuntu 虚拟机 PetaLinux + 网络服务三件套。

**🎯 学习目标**
- 完成 Vivado/Vitis 2020.2 与 PetaLinux 2020.2 的规范安装
- 搭建 TFTP / NFS / 串口 终端等日常开发基础设施
- 通过本章自检清单，确保后续每一章实验环境可用

### 4.1 环境总体架构

| 位置 | 安装内容 | 职责 

| Windows 宿主机 | Vivado 2020.2 + Vitis、MobaXterm、VSCode、Git | PL 工程开发、裸机调试、串口终端、远程编辑代码 

| Ubuntu 18.04 虚拟机 | PetaLinux 2020.2、NFS/TFTP 服务、交叉编译 SDK | Linux 全家桶构建、驱动/应用编译、文件服务 

| 领航者开发板 | BOOT.BIN / 镜像 | 被调试目标，经 USB(JTAG+串口)+网线 与主机互联 

💡 推荐布局理由
Vivado 图形界面在 Windows 原生运行最流畅；PetaLinux 只能装在 Linux。两者通过「共享文件夹/网盘 + NFS」衔接 bitstream 与 HDF 文件。如果你习惯全 Linux 工作流，把 Vivado 也装进虚拟机完全可行（内存建议 32GB）。

### 4.2 安装 Vivado / Vitis 2020.2（Windows）

- 注册 AMD/Xilinx 账号，从官网下载 **Vivado 2020.2 Unified Installer**（约几十 MB 在线安装器，或完整离线包）。
- 运行安装器，选择 **Vitis**（2020.2 起 SDK 功能并入 Vitis，裸机开发必需）。
- 器件勾选：**Zynq-7000 SoC**（可再加 Artix-7 备用）；文档勾选 DocNav。
- 安装路径**全英文、无空格**（如 `D:\Xilinx`），磁盘预留 ≥100GB。
- 许可：选择 **WebPack 免费许可**，Zynq-7020 在覆盖列表内，无需付费 License。
- 安装完成后启动 Vivado，确认版本号 2020.2；插入开发板 USB 线，Hardware Manager 中应能识别板载 JTAG。

### 4.3 Ubuntu 18.04 虚拟机

- 安装 VMware Workstation（16 及以上）。
- 新建虚拟机：镜像 `ubuntu-18.04.6-desktop-amd64.iso`；配置 **4 核 CPU / 16GB 内存（最低8GB）/ 150GB 磁盘（选单个文件）**。
- 装好后执行系统更新与基础工具：

```
sudo apt update && sudo apt upgrade -y
sudo apt install -y open-vm-tools-desktop net-tools openssh-server
# 换阿里源（编辑 /etc/apt/sources.list 将 archive.ubuntu.com 替换为 mirrors.aliyun.com）
sudo sed -i 's/cn.archive.ubuntu.com/mirrors.aliyun.com/g; s/archive.ubuntu.com/mirrors.aliyun.com/g' /etc/apt/sources.list
sudo apt update
# 固定 IP（桥接模式示例，按你的局域网网段修改）
sudo nano /etc/netplan/01-netcfg.yaml
```
```
# /etc/netplan/01-netcfg.yaml —— 静态IP示例
network:
  version: 2
  renderer: networkd
  ethernets:
    ens33:
      dhcp4: no
      addresses: [192.168.2.20/24]
      gateway: 192.168.2.1
      nameservers:
        addresses: [192.168.2.1, 114.114.114.114]
```
```
sudo netplan apply && ip a   # 确认 IP 生效
```

#### 网络规划表（全课程统一，强烈建议照抄）

| 设备 | IP | 说明 

| Windows 宿主机 | 192.168.2.10 | 有线网卡桥接进虚拟机 

| Ubuntu 虚拟机 | 192.168.2.20 | NFS/TFTP 服务器、编译机 

| ZYNQ 开发板 | 192.168.2.30 | U-Boot 与 Linux 中的静态地址 

⚠️ 桥接要点
VMware 虚拟网络编辑器中，VMnet0 桥接到**有线物理网卡**（不是无线、不是 VPN 虚拟网卡）；板卡与主机接同一台交换机/路由器 LAN 口；Windows 防火墙允许 ICMP（或临时关闭测试）。三台设备互 ping 全通才算过关。

### 4.4 安装 PetaLinux 2020.2

- 安装依赖（UG1144 官方清单）并修正默认 shell：

```
sudo dpkg-reconfigure dash    # 选择 No，改回 bash
sudo apt install -y tofrodos iproute2 gawk xvfb gcc git make net-tools \
  libncurses5-dev tftpd zlib1g-dev libssl-dev flex bison libselinux1 \
  gnupg wget diffstat chrpath socat xterm autoconf libtool tar unzip \
  texinfo zlib1g-dev gcc-multilib automake zlib1g:i386 screen pax gzip \
  cpio python3 python3-pip python3-pexpect xz-utils debianutils \
  iputils-ping libsdl1.2-dev libglib2.0-dev lib32z1
```

- 运行安装器（**不要用 root，也不要装进系统目录**）：

```
mkdir -p /opt/pkg/petalinux/2020.2
sudo chown -R $USER:$USER /opt/pkg
chmod +x petalinux-v2020.2-final-installer.run
./petalinux-v2020.2-final-installer.run /opt/pkg/petalinux/2020.2
# 按提示阅读并接受许可协议（输入 q + y）
# 写入环境变量
echo 'source /opt/pkg/petalinux/2020.2/settings.sh' >> ~/.bashrc
source ~/.bashrc
echo $PETALINUX        # 应输出安装路径
petalinux-util --version  # 应显示 2020.2
```
💡 sstate 与 downloads 加速目录
首次构建 PetaLinux 会联网下载大量源码包。提前从官网下载对应 `sstate-aarch64 2020.2` 与 `downloads-2020.2` 离线包解压到 `~/work/sstate` 与 `~/work/downloads`，建工程时在 `petalinux-config → Yocto Settings` 里指向本地路径，可将构建时间从数小时缩到几十分钟，且断网可用。

### 4.5 串口终端与文件服务
```
# 1) Windows 侧：MobaXterm → Serial → 选板卡串口
#    波特率 115200，8N1，无流控（保存为会话）

# 2) Ubuntu 侧 TFTP 服务（供 U-Boot 拉取镜像）
sudo apt install -y tftpd-hpa
sudo mkdir -p /tftpboot && sudo chmod 777 /tftpboot
sudo nano /etc/default/tftpd-hpa
#   TFTP_DIRECTORY="/tftpboot"
#   TFTP_OPTIONS="--secure --create"
sudo systemctl restart tftpd-hpa
echo "tftp-ok" | sudo tee /tftpboot/test.txt
tftp 127.0.0.1 -c get test.txt && cat test.txt   # 自检

# 3) Ubuntu 侧 NFS 服务（供板卡挂载根文件系统）
sudo apt install -y nfs-kernel-server
mkdir -p ~/work/rootfs
echo "/home/$USER/work/rootfs *(rw,sync,no_root_squash,no_subtree_check)" | sudo tee -a /etc/exports
sudo exportfs -ra && showmount -e localhost      # 自检
sudo ufw disable                                  # 关闭防火墙避免干扰
```

### 4.6 工作目录规范（全课程遵循）
```
~/work/
├── fpga/        # Vivado 工程（每实验一个子目录）
├── plnx/        # PetaLinux 工程
├── apps/        # Linux 驱动与应用源码（Git 管理）
├── tools/       # 自用脚本（烧卡、打包等）
├── rootfs/      # NFS 根文件系统导出目录
├── sstate/      # PetaLinux 离线 sstate
└── downloads/   # PetaLinux 离线源码包
```

### 4.7 环境自检清单（全部通过再进入第5章）

| # | 检查项 | 方法 | 预期 

| 1 | Vivado 版本 | 启动 Vivado → Help → About | 2020.2 

| 2 | JTAG 识别 | Vivado → Open Hardware Manager → Open Target | 识别到 xc7z020 

| 3 | 串口连通 | MobaXterm 打开串口，按板卡复位 | 有输出（或至少无报错占用） 

| 4 | PetaLinux | `petalinux-util --version` | 2020.2 

| 5 | 三机互通 | Windows↔Ubuntu↔板卡 互 ping | 全部通 

| 6 | TFTP | 本机 get 测试 | 取回 test.txt 

| 7 | NFS | `showmount -e localhost` | 列出 rootfs 导出 

### 常见问题 FAQ（避坑指南）
Q1：Vivado 安装完成但启动闪退/白屏？常见原因：① 安装路径含中文或空格；② 显卡驱动兼容问题——尝试右键「以图形处理器运行→集成显卡」；③ 缺 VC 运行库；④ 以管理员身份运行一次。若仍失败，查看 `Vivado Launch.log` 末尾报错检索。

Q2：petalinux-config 界面乱码或直接退出？多为 locale 问题：执行 `sudo locale-gen en_US.UTF-8`，并在 `~/.bashrc` 加 `export LC_ALL=en_US.UTF-8`。另确认终端窗口足够大（ncurses 菜单需要 ≥80×24）。

Q3：构建时报磁盘空间不足？PetaLinux 单工程可膨胀至 30~60GB。① 确认虚拟机磁盘 ≥150GB；② sstate 与工程分盘存放；③ 旧工程及时删除 `build/tmp`；④ VMware 磁盘选「单个文件」避免碎片化，必要时用 vmware-vdiskmanager 扩容。

Q4：WSL2 里能装 PetaLinux 2020.2 吗？官方不支持（2020.2 仅认证 Ubuntu 18.04 原生/主流虚拟机）。WSL2 的网络与 systemd 差异会导致 NFS 等服务异常。求稳请用 VMware/VirtualBox 完整虚拟机；WSL2 可作为辅助 shell 使用但不作为主环境。

**🧪 动手实验 L4-1：环境验收**
按 4.7 清单逐项完成并记录截图/输出。额外任务：① 在 Ubuntu 中用 `ssh user@192.168.2.20` 从 Windows VSCode Remote-SSH 连通；② 把 `test.txt` 放入 /tftpboot 后，在 Windows 命令行 `tftp -i 192.168.2.20 get test.txt`（需启用 Windows TFTP 客户端功能）验证跨机取文件。

**📝 思考题**
- 为什么 NFS 导出配置里要加 `no_root_squash`？去掉后板卡以 root 挂载会遇到什么现象？
- 如果公司内网禁止静态 IP，你会如何改造 4.3 的网络方案让板卡仍能被稳定访问？（提示：DHCP 保留 / mDNS / hostnames）
- sstate 缓存为什么能加速构建？它缓存的粒度是什么？

[← 上一篇第3章 领航者开发板硬件资源](#ch03)
[下一篇 →第5章 Verilog HDL 快速入门](#ch05)

---

