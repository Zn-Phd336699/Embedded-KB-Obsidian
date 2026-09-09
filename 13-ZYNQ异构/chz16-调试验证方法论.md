---
title: "调试验证方法论"
date: 2025-09-09
category: "ZYNQ异构"
tags: ["ZYNQ", "调试", "ILA", "VIO", "时序分析", "JTAG", "GDB"]
description: "ILA/VIO在线逻辑调试、时序分析与时序收敛、JTAG裸机调试、GDB+VSCode远程调试、内核调试与软硬件联合验证"
---

# 调试验证方法论

> ILA/VIO在线逻辑调试、时序分析与时序收敛、JTAG裸机调试、GDB+VSCode远程调试、内核调试与软硬件联合验证

## 目录

1. [[#ILA/VIO 在线逻辑调试|ILA/VIO 在线逻辑调试]]
2. [[#时序分析与时序收敛|时序分析与时序收敛]]
3. [[#JTAG 裸机调试|JTAG 裸机调试]]
4. [[#Linux 应用远程调试：GDB + VSCode|Linux 应用远程调试：GDB + VSCode]]
5. [[#内核调试与软硬件联合验证方法论|内核调试与软硬件联合验证方法论]]

---

## 第21章 ILA/VIO 在线逻辑调试
把「示波器」长进 FPGA 内部 —— 观察任意内部信号，按条件触发，不占一个外部引脚。

**🎯 学习目标**
- 掌握 mark_debug → Set Up Debug → 触发分析的完整 ILA 流程
- 会用 VIO 实时强制/观测信号
- 理解采样深度、时钟域选择对调试结果的影响

### 21.1 原理三十秒
**ILA（Integrated Logic Analyzer）**= 片上逻辑分析仪：用 BRAM 当采样缓存，按你选的时钟逐拍记录目标信号，满足触发条件后经 JTAG 上传到 Hardware Manager 显示波形。**VIO（Virtual IO）**则没有缓存，提供「实时读写」——相当于虚拟的按键与 LED。

### 21.2 标准流程：Netlist Insertion（推荐）
#### Step 1 · 标记信号
```
(* mark_debug = "true" *) reg [23:0] cnt;      // 想看谁就标谁
(* mark_debug = "true" *) reg        tick;
(* mark_debug = "true" *) wire [3:0] led_r;
```
#### Step 2 · 综合后配置

- **Run Synthesis** 完成 → 打开 Synthesized Design；
- 菜单 **Tools → Set Up Debug...** 向导自动发现全部 marked 信号；
- 为每核指定**时钟域**（必须与信号同源，选 sys_clk）；采样深度 Buffer Depth：1024 起步（BRAM 富余可 4096）；
- Finish 自动生成 debug core 约束（dbg_hub + ila），重新 Implement + Generate Bitstream + 上板 Program。

#### Step 3 · 抓取与分析

- Hardware Manager 中出现 **hw_ila_1**；波形窗口添加信号组；
- 设置触发：*Immediate* 立即采一窗 / 条件触发如 `tick == Rising Edge`；
- 点击 Run Trigger，命中后分析波形 —— 与仿真波形完全同款的交互体验。

### 21.3 触发技巧速查

| 想抓什么 | 触发设置 

| 随机快照 | Trigger mode: Immediate 

| tick 脉冲出现瞬间前后 | Basic: tick = R 边沿；Position 控制前段占比 

| cnt 计到特定值 | Value 比较 cnt == 24'd12500_000-1 

| 组合条件 | Advanced 触发表达式：tick && (led_r==4'b0010) 

| 罕见事件前的历史 | 大深度 + Trigger Position 拉高（90%记录触发前） 

### 21.4 VIO：无缓存的实时旋钮
BD 里例化 `VIO v3.0`：probe_in 连状态信号（如 IP 的 STATUS 寄存器值），probe_out 连控制信号（如强制 speed 参数）。上板后在 Hardware Manager 面板直接点按钮改 probe_out —— **不用重写比特流就能改变 FPGA 行为**，是参数化实验的利器。

### 21.5 实战案例：验证消抖模块
标记 L5-1 消抖模块的 `key_sync/key_stable/cnt` 三信号，ILA 深度 2048，触发设为 key_stable 边沿。抓取后应看到：

- key_in 抖动区（若干毛刺）→ key_stable 保持旧电平约 20ms（50MHz 下计数百万级，需降低滤波常数便于观察或用大深度+分频采样）；
- 稳定后 key_pulse 单周期脉冲输出。
- 若毛刺穿过滤波器 → 检查同步器是否两级 FF、阈值计数是否被复位条件误清。

💡 低频事件的省资源技巧
20ms@50MHz = 100 万拍，直接采要海量 BRAM。工程做法：ILA 时钟换接 **clk_div1000（50kHz）**，等效时间窗放大 1000 倍，代价是单拍分辨率变粗 —— 抓慢事件足够。

### 常见问题 FAQ（避坑指南）
Q1：波形数据看起来「错乱」或信号跳变诡异？九成是时钟域选错：ILA 用 A 时钟采 B 时钟域信号必然亚稳态假象。Set Up Debug 时确认每个探针的 clock 与其源逻辑一致。

Q2：加了 ILA 后功能反而正常了？经典「Heisenbug」：ILA 改变了布线与时序，掩盖了真实违例或 CDC 缺陷。定位思路：先做时序报告确认无负裕量；再审查跨时钟路径是否缺同步器（第22章）。产品发布前务必移除 debug core 重跑全流程验证。

Q3：触发一直等不到？① 条件永假（信号名选错/位宽截断）；② 事件发生在窗口外（加大深度）；③ dbg_hub 时钟未运行（检查所选时钟源）。先用 Immediate 模式确认通路，再上条件触发。

**🧪 动手实验 L21-1：给第10章系统装眼睛**
为综合实验的 logic_scan 链路加 ILA：标记 KEY_REG 读入值、g_state、LED_REG_CTRL 写值。任务：① 抓一次「KEY0→RUN」迁移全过程；② 用 Advanced 触发抓「非法状态迁移」（state==ST_RUN 且 ctrl==0）；③ 用 VIO 强制 speed 分频值验证切换逻辑。保存 .wdb 波形文件归档进 Git。

**📝 思考题**
- 为什么 dbg_hub 需要一个时钟？它和 JTAG TCK 是什么关系？
- 估算：32 位信号 × 4096 深度需要多少 BRAM36？这对你的设计预算意味着什么？
- 对比外部逻辑分析仪（Saleae/DSLogic）与 ILA 的适用场景边界。

### 21.6 深潜：Capture Control 与存储限定（只录想要的）

- **Storage Qualification 存储限定**：设置条件（如 `we==1`）后，ILA 只在条件为真时才写入 BRAM —— 等效把采样深度放大 N 倍，专抓写事务/罕见事件；
- **Capture Mode Basic vs Advanced**：Basic 用单信号门控；Advanced 允许 16 状态比较器组合表达式做采集使能；
- **多 ILA 协同**：跨时钟域两核可设主从触发（core A 触发→经 dbg_hub 联动 core B 开始采），定位跨域握手问题利器；
- 资源账：深度×位宽÷36Kb=BRAM 数，先查 Utilization 余量再定深度 —— 避免布线拥塞。

[← 上一篇第20章 Linux应用编程](#ch20)
### 21.7 深潜：ILA 高阶调试模式与波形分析方法 ★
#### ① 高级触发序列器（Sequencer）——抓"复杂时序事件"

| 原语 | 语义 | 应用举例 

| goto t N | 条件命中后跳到触发状态 N | 先等 idle，再等 start 

| repeat t N | 同一条件连续满足 N 拍才算 | 抓"持续 ≥8 拍的使能"过滤毛刺 

| Trigger Out / In | 核间联动触发信号 | 多 ILA 级联/与示波器同步 

```
例: 只在"第二次进入 RUN 态"时触发:
  State1: state==RUN → goto State2(且 Trigger=0)
  State2: state==IDLE → goto State3
  State3: state==RUN → TRIGGER ✓
/* 复杂事件一次命中, 免去反复人工筛波形 */
```
#### ② 双 ILA 跨时钟域联合调试
CDC 问题（22章）的实证手段：ILA_A 挂源时钟域、ILA_B 挂目的域，设置 **A 主 B 从**（A 触发经 dbg_hub 联动 B 启动采集）。分析时对齐两窗波形，直接观测两级同步器的实际延迟拍数 —— 「教科书上的 CDC」第一次变成看得见的证据。

#### ③ 用 ILA 监控 AXI 总线（协议级取证）
```
mark_debug 五通道关键信号: AWVALID/AWADDR/AWPROT? AWLEN | WVALID/WDATA/WLAST |
BVALID/BRESP | ARVALID/ARADDR | RVALID/RDATA/RLAST
/* 触发: AWADDR==IP基址+偏移 → 观察 CPU 写寄存器全过程
典型违例现场: VALID 拉起后不等 READY 就撤销(违反AXI规范) /
WLAST 丢失导致从机状态机卡死 —— 抓包定责, 谁的问题一目了然 */
```
#### ④ 波形分析五步法 + 仿真实测差异清单

- 定位事件沿 → 2. 测量时间间隔（用标尺而非肉眼）→ 3. 检查因果顺序（谁先谁后）→ 4. 对照预期时序找偏差 → 5. 截图归档进实验笔记。

| 仿真通过上板异常 | 常见根因 

| 偶发数据错乱 | CDC 未同步（仿真无亚稳态模型！）→ 22章审计 

| 首次运行正常复位后死 | 寄存器缺初值/复位树未覆盖全部 FF 

| 边界值行为不同 | X 态被仿真当 0 处理，真实硬件随机 → 初值纪律 

| 高速接口误码 | IDELAY/ISERDES 未校准或约束缺失 → 时序报告复核 

#### ⑤ hw_vio 脚本化自动测试
```
# Hardware Manager Tcl 控制台 —— VIO 自动化回归
refresh_hw_vio [get_hw_vios {hw_vio_1}]
set_property PROBE_VALUE {0x5} [get_hw_probes vio_duty -of_objects [get_hw_vios *]]
commit_hw_vio [get_hw_probes vio_duty]
set duty [get_property PROBE_VALUE [get_hw_probes vio_status]]
puts "status=$duty"     ;# 断言即回归脚本 —— 配合 CI 做板上自测
```

[下一篇 →第22章 时序分析与时序收敛](#ch22)

---

## 第22章 时序分析与时序收敛
「仿真通过、上板偶发出错」的头号元凶是时序违例与跨时钟域缺陷 —— 本章给你系统化的防御工事。

**🎯 学习目标**
- 读懂 report_timing_summary，定位 WNS 违例路径
- 掌握完整约束体系：时钟/IO延迟/伪路径/多周期
- 建立 CDC（跨时钟域）设计的条件反射

### 22.1 时序检查的物理本质
寄存器到寄存器路径要求：数据在**捕获沿之前**提前到达并稳定（Setup 检查），且在捕获沿后保持足够时间（Hold 检查）。一条路径的时序余量 = 允许时间 − 实际耗时，其中实际耗时包括源/目的触发器时钟偏斜、组合逻辑与布线延迟。

| 指标 | 含义 | 合格标准 

| WNS (Worst Negative Slack) | 全设计最差建立裕量 | ≥ 0（越大越好） 

| TNS (Total NS) | 所有违例路径裕量之和 | = 0（无任何违例） 

| WHS | 最差保持裕量 | ≥ 0 

| Failing Endpoints | 违例端点数 | 0 

### 22.2 约束体系实战
```
# ---------- 领航者工程通用约束模板 ----------
# 1) 主时钟：板载 50MHz
create_clock -period 20.000 -name sys_clk [get_ports sys_clk]

# 2) PS 提供给 PL 的 FCLK 由 Vivado 自动约束（BD 工程），无需手写

# 3) 输入输出延迟（按键/LED 等低速信号可简化，高速接口必须精确）
set_input_delay  -clock sys_clk 2.0 [get_ports key*]
set_output_delay -clock sys_clk 2.0 [get_ports led*]

# 4) 跨时钟域：声明为异步组（前提：你已做同步器！）
set_clock_groups -asynchronous \
    -group [get_clocks sys_clk] \
    -group [get_clocks clk_fpga_1]      # FCLK_CLK1 例

# 5) 真正无需时序检查的信号（如复位异步使用）
set_false_path -from [get_ports rst_n]

# 6) 多周期路径：使能信号每 N 拍才有效一次
# set_multicycle_path 2 -setup -from [get_pins src/Q] ...
```

### 22.3 看报告的标准动作

- 实现完成后 **Reports → Report Timing Summary**；
- 先看总览页四项指标 —— 全绿则收工；
- 有红 → 展开 *Intra-Clock: sys_clk → Setup* → 双击最差路径打开 **Path Details**；
- 读三要素：**Source/Destination 寄存器名**（定位代码）、**Data Path Delay 构成**（logic vs route 占比）、**Clock Skew**；
- 右键路径 → Schematic 查看物理结构辅助判断。

### 22.4 违例修复套路（按优先级）

| 手段 | 适用 | 代价 

| ① 流水线切割（插一级寄存器） | 组合链过长（比较器/乘法级联） | +1拍延迟，改下游时序假设 

| ② retiming / 物理优化提示 | 布线拥塞主导 | 编译时间↑ 

| ③ 寄存器复制（fanout过大） | 高扇出控制信号 | 面积↑ 

| ④ 降频或分频域 | 算法允许更低速率 | 性能↓ 

| ⑤ pblock 物理约束 | 跨区长线 | 维护成本，最后 resort 

### 22.5 CDC 专题：工业事故重灾区 ★
两个异步时钟域之间的信号直接传递 = 亚稳态随机传播。**规则：任何跨域信号必须有同步机制**：

| 传输内容 | 正确做法 

| 单 bit 电平（使能/状态） | 目的域两级 FF 同步器（打两拍） 

| 单 bit 脉冲 | 源域转电平翻转(toggle) → 同步 → 目的域边沿检测还原 

| 多 bit 总线（如计数值） | 格雷码编码 + 两级同步（仅适用于顺序变化量）；或握手(req/ack) 

| 成批数据流 | 异步 FIFO（BRAM 自带双时钟口），别自己发明轮子 

🚨 血泪守则
「先跑通再说」的 CDC 在实验室温度下可能数月不出错，客户现场高温老化三天必现灵异复位。评审任何设计时，第一问永远是：**你的时钟树有几棵？跨在哪里？怎么同步的？**

### 常见问题 FAQ（避坑指南）
Q1：报告里几千条 unconstrained paths 警告要紧吗？分两类：输入端口无 input_delay 的属于「未定义但可控」（补约束）；完全无时钟关系的组合输出可能真漏了 create_generated_clock。原则：**让每一拍都有归属**，而不是靠 set_false_path 大扫除掩盖问题。

Q2：50MHz 低速设计还需要看时序吗？需要。低频不豁免 Hold/CDC 问题；且 PL 与 AXI 互联部分工作在 100MHz+。养成每个实现都瞄一眼 Timing Summary 的习惯，成本 10 秒。

Q3：为什么综合过了实现却违例？综合用估算线载模型，布局布线后才见真实延迟。若实现阶段 WNS 为负但绝对值小，可先尝试 `phys_opt_design` 增强档位再判修复策略。

**🧪 动手实验 L22-1：亲手制造并治愈一次违例**
写一个 32 位组合比较链（A==B 且 B>C 且 …8 级串联）跑在 200MHz MMCM 上，观察 WNS 变负；依次尝试流水线切割/降频/pblock 三种方案记录效果。然后构造一个「计数器总线直接跨域」bug，观察 ILA 波形抓到的撕裂值，再用格雷码修复验证。

**📝 思考题**
- Hold 违例为什么不能靠降频解决？它通常由什么引起？
- PS 的 FCLK_CLK0 与板载 50MHz 属于什么关系？PL 内两者交互应遵守什么规则？
- PLC IO 引擎中「PS 写 DO 寄存器」这条 AXI 路径如果违例，故障表现会是什么形态？

[← 上一篇第21章 ILA/VIO在线逻辑调试](#ch21)
### 22.6 深潜：生成时钟自动识别与 input_delay 实测法

- **MMCM/PLL 输出**：Vivado 自动创建 generated clock（名字如 `clk_out1_clk_wiz`），无需手写；只有**逻辑分频**（FF 打一拍输出做时钟）才必须手动 `create_generated_clock -source [get_pins div/Q]` —— 漏写的典型症状：报告里出现 unconstrained internal clocks；
- **input_delay 怎么定**？系统同步（源同步对端给时钟）：delay = Tco(max) + 板走线差；系统异步单端（按键类）：给个保守 2~3ns 即可，重点是"有约束"而非"精确"；高速源同步接口(DDR/LVDS)则必须按数据手册的 skew 规格逐项计算 —— 这是接口调试成败的分水岭。

### 22.7 深潜：一次真实收敛案例复盘
```
现象: 100MHz 域 WNS=-0.8ns, 违例路径: cnt[31:0]比较器→状态译码→mux
分析: DataPath Delay=10.7ns 中 logic 4.2/route 6.5 → 布线主导+级数多
处置(按序尝试):
 ① retiming? 无效(跨模块边界)
 ② 切流水: 在比较结果后插一级寄存器, 下游延迟敏感点用"提前一拍使能"补偿
    → WNS=+0.35ns ✓ 代价: 该分支输出晚一拍, 用一个"影子计数"保持语义等价
教训: 时钟周期紧张时, "先切后修"优于死磕布线; 修改必须连带更新 tb 预期。
```

### 22.8 深潜：时序收敛完整工作流与实战判例 ★
#### ① 从零到收敛的四步约束清单

- **时钟**：所有 create_clock / 确认 MMCM 自动生成时钟出现在报告里；
- **CDC 声明**：report_cdc 逐条审 —— 每条跨域路径要么有同步器（标 asynchronous 组），要么就是缺陷；
- **IO 时序**：源同步接口按手册 skew 算 input/output delay；慢速 IO 给保守值；
- **例外**：false_path/multicycle 逐条附注释说明"为什么安全" —— 无注释的例外=未来的事故。

#### ② Multicycle 实战判例（最易写错的约束）
```
场景: 使能信号每 2 拍才有效一次, 数据路径允许 2 个周期完成
正确写法(必须成对!):
  set_multicycle_path 2 -setup -from [get_pins en_reg/Q] -to [get_pins dst_reg/D]
  set_multicycle_path 1 -hold  -from [get_pins en_reg/Q] -to [get_pins dst_reg/D]
/* 忘写 -hold 是经典错误: setup 放宽的同时 hold 被隐性收紧一拍 → hold 违例!
   口诀: setup 放 N, hold 放 N-1 */
```
#### ③ 收敛决策流程（WNS 分级处置）
```
WNS ∈ (-0.1, 0)  → phys_opt_design 增强档重跑, 多半白捡
WNS ∈ (-1.0,-0.1) → 找 Top 路径: logic占比高→切流水; route高→pblock/复制寄存器
WNS < -1.0       → 架构问题: 该域频率不现实, 回到设计层(降频/改算法)
HOLD 违例        → 与频率无关! 只能: 加延迟单元/改布线约束/换引脚 —— 立即处理
/* report_cdc 的 Unsafe 输出 = 强制整改项, 不允许"先跑起来再说" */
```
#### ④ report_timing_summary 精读三分钟训练
拿到报告先看四行总览（WNS/TNS/WHS/Failing Endpoints），全绿收工；有红则进 Intra-Clock 最差路径读五要素：**Source/Destination 寄存器名**（定位代码）、**Slack 公式分解**（required−arrival）、**Data Path** 中 logic vs route 占比、**Clock Skew/Pessimism**（时钟不确定性是否被重复计入）、**Schematic 链接**核对物理结构。把这套动作练成 3 分钟肌肉记忆。

[下一篇 →第23章 JTAG裸机调试](#ch23)

---

## 第23章 JTAG 裸机调试
CPU 停下来给你看 —— 断点、单步、内存窗口，裸机世界的显微镜。

**🎯 学习目标**
- 掌握 Vitis Debugger 的断点/单步/内存与寄存器观测
- 理解硬件断点与软件断点的机制差异
- 会用 XSCT 命令行把调试过程脚本化

### 23.1 调试链路原理
JTAG 调试器经 **DAP（Debug Access Port）**连接 Cortex-A9 的调试单元，可以：暂停/恢复 CPU、读写全部核心寄存器与内存、设置硬件断点（比较器匹配地址）与监视点（数据访问触发）。这一切**不需要目标程序任何配合** —— 所以裸机阶段就能全功能调试。

### 23.2 Vitis Debugger 五板斧

| 操作 | 入口 | 要点 

| 启动调试 | 右键应用 → Debug As → Launch Hardware | 确认配置含 ps7_init 步骤（第7章） 

| 断点 | 代码行号左侧双击 | 默认软件断点；汇编级可切硬件断点 

| 单步 | F5 步入 / F6 步越 / F7 返回 / F8 继续 | -O2 下行序乱跳属正常，教学工程用 -O0 

| 看变量 | Variables / Expressions 视图 | 指针右键 View Memory 跳转内存窗 

| 看外设 | Memory 视图输入物理地址如 `0xE000A000` | 对照 UG585 寄存器手册逐位核对 

### 23.3 实战：三分钟定位「中断不来」
复现第8章 Q1 场景，演示分层排查：

- **断点 A** 在 `XScuTimer_Start()` 之后 → Run 到此暂停，Memory 打开定时器基址 `0xF8F00600`：Enable 位确已置 1 → 定时器侧无嫌疑。
- **断点 B** 在 ISR 首行 → F8 放行后未命中 → 中断未送达 CPU。
- Memory 打开 GIC 分发器 `0xF8F01100+29*4`（ISER 位段）：Timer29 对应位为 0 → **GIC 层没使能！**回查代码发现漏了 `XScuGic_Enable(&intc, TIMER_IRPT_ID)`。
- 补上重跑 → 断点 B 命中，问题闭环。全程未改一行逻辑，纯靠「证据链」。

### 23.4 XSCT：脚本化的终极形态
```
# xsct 交互或脚本（debug.tcl）：
connect
targets -set -filter {name =~ "Cortex-A9 #0"}   # 选核
rst -processor                                   # 复位该核
source ps7_init.tcl ; ps7_init                   # 初始化 SoC
dow hello_uart.elf                               # 下载
bpadd -file hello_uart.c -line 14                # 设断点
con ; sleep 1 ; stp                              # 运行到断点再单步
puts "PC=[rrd pc] r0=[rrd r0]"                   # 抓现场
mrd 0xE0001000 8                                 # 直读UART寄存器8字
dis                                              # 反汇编当前PC附近
exit
```
价值：**回归测试可脚本化** —— 每次改完驱动自动下载运行并断言关键寄存器状态，CI 化的第一步（第35章验收会复用）。

### 常见问题 FAQ（避坑指南）
Q1：暂停 CPU 后系统突然复位？CPU 停了但看门狗还在数！调试前先禁用 WDT（FSBL 配置里关掉，或调试配置中跳过），或在断点前喂狗。这是裸机调试第一坑。

Q2：断点打不上或命中位置诡异？① 编译优化 -O2 导致指令重排 —— 调试用 -O0（Properties→C/C++ Build→Optimization）；② 断点落在内联函数展开处；③ 硬件断点寄存器只有 6~8 个，超出则静默失败。

Q3：双核同时调试互相干扰？Vitis Targets 视图分别 attach 两核；注意共享外设（GIC/DDR）操作需协调。AMP 调试时建议先只挂核0，核1 用日志输出。

**🧪 动手实验 L23-1：寄存器级侦探**
不用 printf，纯靠断点+Memory 视图完成：① 验证 GPIO EMIO 输出翻转时 DATA 寄存器对应位变化；② 抓取 UART 发送一个字符过程中 TX FIFO 状态位变化序列；③ 把三个发现写成「寄存器观察笔记」—— 这份笔记就是你读懂 UG585 的里程碑。

**📝 思考题**
- 硬件断点为什么能调试 ROM/Flash 中的代码而软件断点不能？
- 设计一个「上电即停在 main 入口」的方案，便于从第一条语句开始跟踪。（提示：halt after download）
- XSCT 脚本如何在断言失败时返回非零退出码？给出 CI 集成思路。

[← 上一篇第22章 时序分析与时序收敛](#ch22)
### 23.5 深潜：板级 bring-up 的 JTAG 急救技术 ★
新板/新固件最黑暗的时刻是「串口一个字都没有」。JTAG 是此时唯一的光 —— 不需要任何代码能跑，就能读寄存器做诊断。

#### ① 无系统诊断三板斧（XSCT 直读寄存器）
```
connect
targets -set -filter {name =~ "Cortex-A9 #0"}
# ① 时钟链路健康: 读 ARM PLL 状态(SLCR)
mrd 0xF8000140    # ARM_CLK_CTRL — 值为0或全F = PLL未锁/电源异常
mrd 0xF8000100    # PLL_STATUS: bit0 ARMPLL_LOCK 应=1
# ② DDR 活性: 绕过一切软件直接写读内存
mwr 0x00100000 0xA5A51234
mrd 0x00100000    # 回读==0xA5A51234 → DDR控制器+颗粒基本OK
# ③ GPIO 心跳: 手动翻转 MIO LED 寄存器, 确认最低层硬件活着
/* 三步结论树: PLL未锁→查电源/晶振; DDR写失败→查ps7_init时序参数;
   都正常但程序不跑→问题在加载环节(镜像/入口地址) */
```
#### ② 内存 Pattern 测试脚本（DDR 可信度验收）
```
# xsct 脚本: 数据走1 + 地址抽样双重测试
set base 0x00100000
for {set i 0} {$i < 32} {incr i} {
    mwr [expr $base + $i*4] [expr 1 << $i]     # 数据走1
}
for {set a $base} {$a < $base+0x04000000} {set a [expr $a+0x100000]} {
    mwr $a 0xAAAAAAAA
    if {[lindex [mrd -value $a] 1] != 0xAAAAAAAA} { puts "FAIL @ $a" }
}
```
#### ③ 启动三级接管的 JTAG 切入点

| 死亡阶段 | JTAG 接管动作 

| BootROM 后无 FSBL | halt → 手动 source ps7_init.tcl → dow fsbl.elf 单步跟 

| FSBL 卡在 PCAP | mrd DevC 状态寄存器(0xF8007000 域) 看 PCAP_DONE/溢出位 

| U-Boot 前 DDR 即坏 | 用①②确认后修正 XSA 的 DDR 时序重出 FSBL 

[下一篇 →第24章 Linux应用远程调试](#ch24)

---

## 第24章 Linux 应用远程调试：GDB + VSCode
在 Windows 的 VSCode 里给板卡上的进程打断点 —— 现代嵌入式开发的标准姿势。

**🎯 学习目标**
- 搭建 gdbserver + 交叉 GDB + VSCode 三层调试架构
- 掌握 attach 调试、多线程检查、监视点等进阶技能
- 能对 PLC 运行时做「周期级」的行为分析

### 24.1 架构与准备
```
┌─ Windows: VSCode (GDB 前端 UI) ─┐
│  └─ arm-xilinx-linux-gnueabi-gdb ──── TCP ────┐
├─ Ubuntu: SDK 提供交叉 gdb 与 sysroot ─────────┤
│  └─ 板卡: gdbserver :1234 ./plc_runtime ◀─────┘  JTAG/网口均可承载
```

| 组件 | 获取方式 | 验证 

| 板上 gdbserver | petalinux-config -c rootfs 勾选（15.5） | `which gdbserver` 

| 主机交叉 gdb | PetaLinux SDK 自带 | `$GDB --version` 

| sysroot | SDK 安装目录 `sysroots/cortexa9t2hf-neon-xilinx-linux-gnueabi` | 含 /lib /usr/lib 镜像 

### 24.2 命令行完整流程（先跑通再上 IDE）
```
# 板上：
gdbserver :1234 /usr/bin/plc_runtime
# Process plc_runtime created; pid = 812, Listening on port 1234

# 主机（source SDK 后）：
$GDB ~/work/apps/plc_runtime            # 注意：加载的是带符号的主机侧副本
(gdb) set sysroot ~/work/sdk/sysroots/cortexa9t2hf-neon-xilinx-linux-gnueabi
(gdb) target remote 192.168.2.30:1234
(gdb) break scan_loop                    # 函数断点
(gdb) continue                           # 板上开始运行，命中后停下
(gdb) print period_ms
(gdb) bt                                 # 调用栈
```

### 24.3 VSCode 图形化配置
```
// .vscode/launch.json —— 安装 C/C++ 扩展后使用
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "ZYNQ Remote Debug",
      "type": "cppdbg",
      "request": "launch",
      "program": "${workspaceFolder}/plc_runtime",
      "cwd": "${workspaceFolder}",
      "MIMode": "gdb",
      "miDebuggerPath": "arm-xilinx-linux-gnueabi-gdb",
      "miDebuggerServerAddress": "192.168.2.30:1234",
      "setupCommands": [
        { "text": "set sysroot /home/user/work/sdk/sysroots/cortexa9t2hf-neon-xilinx-linux-gnueabi" },
        { "text": "set pagination off" }
      ]
    }
  ]
}
```
F5 启动 → 断点可视化命中、悬停看变量、Watch 窗口监视表达式 —— 与本地开发体验完全一致。板上先手动跑 `gdbserver :1234 app` 即可。

### 24.4 进阶技巧清单

| 场景 | GDB 操作 

| 调试已运行进程（不停服务） | 板上 `gdbserver --attach :1234 <pid>`；或 gdb 中 `target remote` 

| 只在特定值触发 | `break scan_loop if tick_count==500` 

| 变量被谁改了？ | `watch period_ms`（硬件监视点，写访问即停） 

| 多线程死锁分析 | `info threads` → `thread apply all bt` 一屏看清各线程卡点 

| 抓崩溃现场 | 开启 core dump 后 `gdb app core` 直接回放事故 

| 免打扰观察 | `set confirm off; handle SIGPIPE nostop noprint` 屏蔽噪音信号 

### 常见问题 FAQ（避坑指南）
Q1：断点行号对不上/单步乱跳？-O2 内联重排所致。调试构建用 `-O0 -g`；发布才开优化。若必须调优化的代码，改用汇编级断点与 watchpoint。

Q2：打印结构体显示 incomplete type？sysroot 未设置或路径错，GDB 读不到库头文件调试信息。确认 set sysroot 指向 SDK 目录而非板卡导出的 rootfs。

Q3：单步一次卡好几秒？每步都经网络往返。缓解：把断点上移到粗粒度函数、用 until/break 行号批量推进；或临时把工程搬到 NFS 上以缩短符号解析。

**🧪 动手实验 L24-1：抓住抖动现行**
对 L20-1 的 mini_rt 远程调试：① 在扫描线程设条件断点 `if jitter_us > 200`；② 命中时执行 `thread apply all bt` 截图归档；③ 分析该时刻其他线程正在做什么（大概率是通信线程在 printf）—— 用证据支撑你后续的性能优化决策。

**📝 思考题**
- 为什么 program 要指向主机侧副本而不是板上文件？两者不一致会发生什么？
- 对比 gdbserver/TCP 与 JTAG+hw_server 两种调试通道的能力边界（能否调试内核？能否暂停整机？）。
- 设计 PLC 运行时的「飞行记录仪」：环形缓冲保存最近 N 个扫描周期的耗时统计，崩溃后由 gdb 导出分析。

[← 上一篇第23章 JTAG裸机调试](#ch23)
### 24.6 深潜：GDB 高级实战三案例 ★
#### ① 案例：多线程死锁的 5 分钟定位
```
现象: Web 接口无响应, CPU 空闲(排除忙等)
(gdb) thread apply all bt
  Thread 3 (scan):   ... pthread_mutex_lock (&img_mtx) ← 卡在这
  Thread 5 (web):    ... pthread_mutex_lock (&img_mtx) ← 也卡? 不对——
  Thread 2 (log):    ... memcpy(...) ← 持锁者在拷贝大缓冲!
/* 判读: 并非死锁环, 而是"持锁时间过长"造成的活饥饿。
   log 线程在锁内做格式化+memcpy 大块 → 缩锁: 锁内只交换指针 */
若真是环状死锁: bt 显示 A 等 mtx1(持有mtx2), B 等 mtx2(持有mtx1)
→ 修复: 统一加锁顺序(37章) + lockdep/pthread_mutexattr 设 PTHREAD_MUTEX_ERRORCHECK 复核
```
#### ② 案例：变量被神秘修改 —— watchpoint 抓真凶
```
现象: period_ms 每 ~10 分钟被改成随机值
(gdb) watch -l g_cfg.period_ms        # 硬件观察点: 写访问即停
Hardware watchpoint 2: g_cfg.period_ms
(gdb) c
Hardware watchpoint 2: *g_cfg.period_ms
Old value = 10; New value = 23734
0x00013a4c in cfg_reload_thread (...) at config.c:71
# bt → 来自 SIGUSR1 处理路径, sscanf 未校验长度 → 越界写踩踏相邻内存
/* watchpoint 是"内存指纹采集器"——谁改的、改前改后值、完整调用栈一屏呈现 */
```
#### ③ core dump 全流程（事后取证）
```
# 板上开启:
ulimit -c unlimited
echo "/media/ram/core.%e.%p" > /proc/sys/kernel/core_pattern   # tmpfs防写坏存储
# 崩溃后主机分析:
$GDB plc_runtime core.plc_runtime.812
(gdb) bt full                    # 全栈含局部变量
(gdb) info threads; thread apply all bt brief
(gdb) frame N; print struct      # 逐帧还原现场
/* 加分项: 应用内置最近200条操作日志环形缓冲, 崩溃处理函数把它
   dump 到 stderr → core 里直接可见"死前在干什么"(49章黑匣子同思想) */
```
#### ④ GDB 批量化

| 手段 | 示例 

| 命令脚本 | `gdb -x init.gdb --batch app core`(init.gdb 里 bt/printf 自动执行) 

| 自定义命令 | `define plcstat / printf "tick=%d\n", g_img.scan_cnt / end` 

| hook 断点 | `define hook-stop / info threads / end` 每次停下自动打印现场 

[下一篇 →第25章 内核调试与联合验证方法论](#ch25)

---

## 第25章 内核调试与软硬件联合验证方法论
第三篇收官：内核级排障工具箱 + 一套「五层二分定位」思维框架 —— 让任何疑难杂症都有章可循。

**🎯 学习目标**
- 会用 printk/dynamic-debug/devmem/strace 组合观测内核与应用
- 能独立解析 Oops 报告并用 addr2line 定位到源码行
- 建立「分层二分」的系统级排障方法论

### 25.1 printk 与动态调试
```
#include <linux/printk.h>
dev_dbg(dev,  "di=%08x\n", di);   /* 需开 DEBUG 或动态调试 */
dev_info(dev, "probe ok\n");
dev_warn/dev_err(...);

/* 动态调试：不重编内核，运行期开关指定文件/函数的 dbg */
echo 'module plc_io +p' > /sys/kernel/debug/dynamic_debug/control
cat    /sys/kernel/debug/dynamic_debug/control        # 查看已启用项
```
💡 控制台看不到日志？三级检查
① `cat /proc/sys/kernel/printk` 当前等级低于消息等级 → `echo 8 > /proc/sys/kernel/printk`；② 日志进了环形缓冲但控制台未绑定 → `dmesg | tail` 总能看到；③ earlycon 缺失导致最早期日志丢失。

### 25.2 Oops 解析实战
驱动解引用空指针时串口吐出的典型报告：

```
Unable to handle kernel NULL pointer dereference at virtual address 00000004
pgd = ...(cut)
PC is at plc_read+0x24/0x60 [plc_io]
LR is at vfs_read+0xa0/0x160
...
[<bf010024>] [plc_read+0x24] from [<c01a3b70>] (vfs_read+...)
[<c01a3b70>] ... from [<c00a1234>] (ret_fast_syscall+0x0/0x1c)
```
读法四步：

- **第一行定性**：NULL deref @ 0x00000004 —— 某结构体成员偏移 4 被访问，而基址是 0（指针未初始化）；
- **定位函数+offset**：`plc_read+0x24`；
- **换算源码行**：
```
arm-xilinx-linux-gnueabi-addr2line -e plc_io.ko -f -i 0x24
# 输出：plc_led.c:58   —— 直达案发现场！
```
- **回溯调用链**：from 列表说明是谁调进来的（此处用户 read 系统调用）。

⚠️ Oops ≠ 必死
进程上下文 Oops 通常只杀死触发者（shell 还活着）——但内核状态可能已被污染，**复现后尽快重启再继续实验**。中断上下文的坏 Oops 才会直接 panic。

### 25.3 用户态观测三件套

| 工具 | 用途 | 示例 

| devmem | 命令行直读寄存器（mmap /dev/mem 封装） | `devmem 0x43C10008` 验证 PL 状态 

| strace | 追踪应用全部系统调用与耗时 | `strace -Ttt ./plcapp` 看 open 哪个设备失败 

| /proc 与 sysfs | 内核状态窗口 | `/proc/interrupts` 计数验证中断是否来过 ★ 

💡 /proc/interrupts 是中断问题的「心电图」
按一次按键后对比两次 cat 输出：计数涨 = 中断到达 GIC（硬件侧 OK，查驱动处理）；不涨 = 信号根本没到（查 IP 触发配置/DTS flags）。一行命令完成半层二分。

### 25.4 五层二分定位法 ★（背下来）

① 应用层gdb · strace · 日志
② 内核子系统层printk · ftrace · Oops 解析
③ 驱动层/proc/interrupts · reg dump · devmem
④ PL 逻辑层ILA/VIO · 仿真 · 版本核对
⑤ 硬件物理层示波器 · 逻辑分析仪 · 万用表 · 温度/电源
- 
自上而下逐层验证边界契约：每层先证明"我收到了正确输入"，再排查"我是否产出正确输出"

图25-1 五层二分定位模型

配套「证据矩阵」习惯：每个问题记录**现象截图 / 复现步骤 / 已排除层 / 怀疑点**四栏 —— 三轮以内必收敛。

### 常见问题 FAQ（避坑指南）
Q1：addr2line 出来全是 ?? ？.ko 编译时没带 -g 或用了 strip 过的部署副本。保留带符号版本用于调试（部署可另出精简版）；确认 addr2line 用的是交叉版工具。

Q2：devmem 写了寄存器没反应？① 该地址在 PS 侧被内核驱动占用，写操作被仲裁或无效；② 寄存器有写保护序列（如 SLCR 的 unlock 0xF8000008 写 DF0D）；③ 位域需要读改写而你整字覆盖。

Q3：strace 显示大量 EAGAIN？非阻塞 fd 上资源暂不可用的正常返回。关注点应是业务逻辑是否把 EAGAIN 当错误处理了 —— 这本身就是一类经典 bug。

**🧪 动手实验 L25-1：制造→解析→修复闭环**
① 在 plc 驱动里故意加一行 `*(int *)0 = 1;` 触发 Oops；② 完整保存串口输出，用 addr2line 定位；③ 移除 bug 后用同样的五层框架排障一次 L18-1 的按键延迟问题，写出完整《排障报告》。这份报告将作为第四篇联调的标准模板。

### 第三篇通关自测

| 能力项 | 达标标准 

| 在线调试 | 15 分钟内为任意信号组配好 ILA 并命中条件触发 

| 时序工程 | 能读懂 WNS 报告并给出两种以上修复方案及代价评估 

| CDC 防御 | 看到跨域信号第一反应是问同步机制 

| 远程调试 | VSCode F5 直达板卡断点，多线程现场一目了然 

| 系统排障 | 能用五层二分法在 30 分钟内把问题锁定到单层 

**📝 思考题**
ftrace 相比 printk 的优势是什么？什么场景值得为它付出学习成本？
- 设计「PLC 扫描超时看门狗」的三层防线：线程内自检 → 进程级 watchdog → 硬件 WDT 复位。
- 为什么说「没有复现路径的问题等于没有问题」？如何把偶发问题转化为必现？

[← 上一篇第24章 Linux应用远程调试](#ch24)
### 25.5 深潜：完整 Oops 逐行解码练习（对照真实输出）
```
Unable to handle kernel paging request at virtual address befff000
   ↑ 判性: paging request(访问了未映射/权限不符), 地址 befff000 是用户态段!
   → 八成是把用户指针直接解引用了(漏 copy_from_user)
pgd = e1234000
[befff000] *pgd=3e114801, *pte=?, *ppte=?    ← 页表走查: pgd有项但pte无效
Internal error: Oops: 805 [#1] PREEMPT ARM     ← 805: 位域解码见下表
Modules linked in: plc_io(+)                    ← 崩溃时已加载模块(+表示正在加载)
CPU: 0 PID: 412 Comm: test_app Tainted: G      ← 触发进程名! 直接定位测试程序
PC is at plc_read+0x18/0x4c [plc_io]
LR is at vfs_read+0x84/0x130
flags: Nzcv IRQs on FIQs? off ... svc mode? usr? —看CPSR模式位确认上下文
[<bf010018>] (plc_read) from [<c01a2b40>] (vfs_read...)
/* 解码 Oops:805 = 二进制 1000 0000 0101:
   bit0=1 用户态地址访问? bit2=1 读操作, bit11=1? —— 按内核 oops.txt 位表逐位对。
   三步收口: PC+offset → addr2line; 访问地址归属判断; 调用链确认入口。 */
```

### 25.6 深潜：dynamic debug 实战扩展
```
# 精细控制: 只开某文件的某函数, 并带行号前缀
echo 'func plc_probe +pfl' > /sys/kernel/debug/dynamic_debug/control
#  f=func名 l=行号 m=模块 p=打印 —— 组合字母即格式开关
grep plc /sys/kernel/debug/dynamic_debug/control   # 查看生效清单
# 批量开关整个子系统:
echo 'module uio +p' > .../control
```

### 25.7 深潜：内核级故障工具箱与诊断决策树 ★
#### ① 三种"系统不动了"的鉴别

| 类型 | 现象特征 | 内核证据 | 典型根因 

| Soft Lockup | 该核内核态死循环, 其他核/中断仍活 | "BUG: soft lockup - CPU#1 stuck for 22s" | 驱动内无限循环/自旋漏解锁 

| Hard Lockup | 连 NMI 中断都喂不上, 整机假死 | NMI watchdog 报 hard lockup(需开) | 关中断后死循环/自旋锁递归 

| Hung Task | 任务 D 状态 >120s, 系统其余正常 | "task blocked for more than 120 seconds" + 任务栈 | 等 IO/等锁永不返回 

#### ② SysRq 魔术键 —— 死机现场的最后一根稻草
```
# 前提: kernel.sysrq=1; 串口触发: Ctrl+A f? (minicom) 或:
echo t > /proc/sysrq-trigger    # dump 全部任务栈 → dmesg 尾部 = "谁把CPU占死了"
echo m > /proc/sysrq-trigger    # 内存快照
echo w > /proc/sysrq-trigger    # 只列阻塞(D)任务栈
echo b > /proc/sysrq-trigger    # 立即重启(取证后再用!)
/* 典型流程: 系统卡死 → 串口 echo t → 抓栈 → 发现某驱动自旋 → 定位 */
```
#### ③ 内核内存破坏检测器（进阶）

| 工具 | 抓什么 | 代价 

| SLUB debug | slab 对象越界/已释放后访问 | ~10-20%, 测试期开 

| KASAN | 越界/UAF 的精确行号报告 | 2×慢+3×内存, CI 专用 ★ 

| DEBUG_LIST | 链表节点损坏/重复添加 | <5% 

| kmemleak | 泄漏(39章) | 常驻可接受 

#### ④ 诊断决策树（贴墙版）
```
系统异常?
├─ 完全死死? ─→ hard lockup路径: 接JTAG halt看PC / 开NMI watchdog复现
├─ 单核卡死? ─→ soft lockup: sysrq t 找占核任务 → oops式解码
├─ 某任务D状态? ─→ hung_task栈 + /proc/PID/stack(等在哪个内核函数)
├─ 崩溃带Oops? ─→ 25.5 五步解码法
├─ 数据损坏无崩溃? ─→ SLUB debug/KASAN + watchpoint思路迁移
└─ 只是慢? ─→ 切换到第51章性能方法论(on/off-CPU)
/* 铁律: 每类问题先问"我有什么证据", 再选工具; 工具服务于假设验证 */
```

[下一篇 →第26章 项目需求分析与总体架构](#ch26)

---

