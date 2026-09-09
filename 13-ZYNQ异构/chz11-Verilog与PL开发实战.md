---
title: "Verilog HDL与PL开发实战"
date: 2025-09-09
category: "ZYNQ异构"
tags: ["ZYNQ", "Verilog", "FPGA", "PL"]
description: "Verilog HDL快速入门、组合/时序逻辑、状态机、Vivado七步流程、纯PL流水灯实战"
---

# Verilog HDL与PL开发实战

> Verilog HDL快速入门、组合/时序逻辑、状态机、Vivado七步流程、纯PL流水灯实战

## 目录

1. [[#Verilog HDL 快速入门|Verilog HDL 快速入门]]
2. [[#第一个 FPGA 工程：纯 PL 流水灯|第一个 FPGA 工程：纯 PL 流水灯]]

---

## 第5章 Verilog HDL 快速入门
目标不是成为 Verilog 专家，而是掌握支撑全课程实验的最小核心集 —— 并建立「描述硬件」而非「编写流程」的思维。

**🎯 学习目标**
- 理解 Verilog 与 C 语言的「并行 vs 顺序」本质差异
- 掌握模块结构、wire/reg、两种 always、阻塞/非阻塞赋值
- 会写三段式状态机与基础 testbench

### 5.1 硬件描述语言的心智转换
C 语言描述的是**按时间顺序执行的指令流**；Verilog 描述的是**同时存在的电路结构**。你写下的每一行都会变成门电路/触发器，所有模块**永远并行运行**。请先记住两条铁律：

⚠️ 两条铁律
① **时序逻辑用非阻塞赋值 `<=`，组合逻辑用阻塞赋值 `=`**，永不混用；② 一个信号只能在一个 always 块中被赋值（多驱动 = 短路冲突）。

### 5.2 模块：电路的最小单元
```
module led_blink #(                    // #() 参数列表（编译期常量）
    parameter CNT_MAX = 25_000_000     // 50MHz 时钟下 0.5s
)(
    input  wire sys_clk,               // 50MHz 系统时钟
    input  wire rst_n,                 // 低电平有效复位
    output reg  led                    // output reg：在时序 always 中赋值
);

reg [24:0] cnt = 0;                    // 25 位计数器，位宽要够装 CNT_MAX

always @(posedge sys_clk or negedge rst_n) begin
    if (!rst_n)
        cnt <= 25'd0;
    else if (cnt == CNT_MAX - 1)
        cnt <= 25'd0;
    else
        cnt <= cnt + 1'b1;
end

always @(posedge sys_clk or negedge rst_n) begin
    if (!rst_n)
        led <= 1'b0;
    else if (cnt == CNT_MAX - 1)
        led <= ~led;                   // 每 0.5s 翻转一次
end

endmodule
```
要点解读：

- **端口方向**：`input/output/inout`；位宽用 `[msb:lsb]`，如 `output [3:0] led` 表示 4 位总线。
- **wire vs reg**：wire 是导线（assign 赋值/模块连线）；reg 是「过程赋值变量」——注意 **reg 不一定是触发器**！在 always @(*) 里赋值的 reg 综合后是组合逻辑。
- **数字字面量**：`8'd100`（8位十进制）、`32'hDEAD_BEEF`（十六进制）、`4'b1010`（二进制）、`'0/'1`（全0全1填充）。
- **异步复位模板**：`always @(posedge clk or negedge rst_n)` —— 复位优先、无复位时也给出初值，是工业代码标准写法。

### 5.3 组合逻辑与运算符
```
// 组合逻辑两种等价写法
assign sum = a + b;                    // 1) assign 持续赋值（驱动 wire）

always @(*) begin                      // 2) 电平敏感 always（驱动 reg）
    case (sel)                         // case 必须覆盖全部分支或带 default
        2'b00: y = a;
        2'b01: y = b;
        2'b10: y = a ^ b;
        default: y = '0;               // 避免 latch！
    endcase
end

// 常用运算符速查
// 算术: + - * / %      关系: > = >          拼接: {c, b, a}   复制: {4{1'b0}}
// 条件: y = sel ? a : b;
```

### 5.4 三段式状态机：全课程复用模板
PLC 的扫描控制、Modbus 帧解析、DI 滤波都会用到状态机。请背下这个骨架：

```
localparam S_IDLE = 2'd0,
           S_RUN  = 2'd1,
           S_DONE = 2'd2;

reg [1:0]  state, next_state;          // 现态、次态
reg [7:0]  data_out;

// 第一段：时序逻辑，状态寄存器翻转
always @(posedge clk or negedge rst_n) begin
    if (!rst_n)        state <= S_IDLE;
    else               state <= next_state;
end

// 第二段：纯组合逻辑，计算次态
always @(*) begin
    next_state = state;                // 默认保持，防 latch
    case (state)
        S_IDLE: if (start)     next_state = S_RUN;
        S_RUN:  if (cnt_done)  next_state = S_DONE;
        S_DONE:                next_state = S_IDLE;
        default:               next_state = S_IDLE;
    endcase
end

// 第三段：时序逻辑，产生输出
always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        data_out <= 8'd0;
    else if (state == S_RUN)
        data_out <= data_out + 1'b1;
end
```

### 5.5 Testbench：让电路先在电脑里跑起来
```
`timescale 1ns / 1ps
module tb_led_blink;
    reg  clk = 0, rst_n = 0;
    wire led;

    led_blink #(.CNT_MAX(50)) u_dut (   // 参数改小，仿真秒级看到翻转
        .sys_clk (clk),
        .rst_n   (rst_n),
        .led     (led)
    );

    always #10 clk = ~clk;             // 50MHz：周期 20ns
    initial begin
        #100 rst_n = 1;                // 释放复位
        #5000 $finish;
    end
endmodule
```
在 Vivado 中：**Add Sources → Add or create simulation sources** 加入 tb，选择 *Run Simulation → Run Behavioral Simulation*，观察波形。养成习惯：**每个模块先仿真再上板**，这是第三篇调试方法论的起点。

### 5.6 可综合速查表

| ✅ 可综合 | ❌ 不可综合（仅仿真） 

| always、assign、if/case、for（边界固定）、function、generate、$signed | $display/$monitor、#delay 延时、initial 赋值（FPGA 初值除外）、fork/join、while（不定循环）、文件 IO 

### 常见问题 FAQ（避坑指南）
Q1：仿真结果对，上板却不对？按概率排查：① 引脚约束错误或漏约束（看 Implementation 的 Critical Warning）；② 复位极性搞反；③ 时钟未加 create_clock 约束，时序全靠运气；④ 跨时钟域信号未同步（亚稳态）——两个不同时钟域之间必须打两拍或用握手 FIFO。

Q2：Warning 提示 inferred latch 怎么回事？组合 always 中某些分支没给信号赋值，综合器只好生成锁存器「记住」旧值。修复：always @(*) 开头给所有输出赋默认值，case 补 default。

Q3：位宽不匹配会怎样？Verilog 静默截断/扩展，不报错！`reg [3:0] a; a = 8'hFF;` 实际得到 4'hF。大工程里这是隐蔽 bug 之源：赋值前显式位宽对齐，必要时用 `$width` 类 lint 工具（如 Vivado 内置 Report 或 Verilator lint）。

Q4：为什么教程代码里计数器用 25'd25_000_000？下划线是什么？下划线是数字分隔符，纯粹提高可读性，等价 25000000。50MHz 时钟数 25,000,000 次恰好 0.5 秒。

**🧪 动手实验 L5-1：按键消抖模块**
编写 `key_debounce` 模块：输入抖动按键 `key_in`，输出干净脉冲 `key_pulse`（按下瞬间产生一个时钟周期脉冲）。参考思路：按键电平连续稳定 20ms（50MHz 下计数 1,000,000）才认为有效，检测「稳定后电平与上一有效电平不同」输出脉冲。先写 testbench 仿真（用小计数值），通过后再综合。这个模块将在第10章与 PLC 篇的 DI 滤波中直接复用。

**📝 思考题**
- 解释为什么「一个信号在两个 always 块中赋值」在 C 语言里合法，在 Verilog 里却是严重错误。
- 把 5.4 状态机改成「Mealy 型输出」（输出由现态+输入共同决定），输出段应放在哪一段？有什么代价？
- 设计一个 8 位循环移位流水灯需要的最小寄存器数量是多少？写出核心一行代码。

[← 上一篇第4章 开发环境搭建](#ch04)
### 4.8 深潜：Vivado Tcl 自动化 —— 从「点鼠标」到「跑脚本」
Vivado 本质是一个 Tcl 解释器加 GUI。掌握批处理模式后，编译可无人值守/可 CI 化：

```
# build.tcl —— 非工程模式一键出 bit 的最小脚本
create_project -force plc_flow ./prj -part xc7z020clg484-1
add_files ./src/flow_led.v
add_files -fileset constrs_1 ./xdc/flow_led.xdc
set_property top flow_led [current_fileset]
launch_runs synth_1 -job 8
wait_on_run synth_1
launch_runs impl_1 -to_step write_bitstream -job 8
wait_on_run impl_1
open_run impl_1
report_timing_summary -file timing.rpt
puts "BUILD DONE"

# 命令行运行（Windows/Linux 同语法）：
vivado -mode batch -source build.tcl -log build.log -journal build.jou
# GUI 里做的每个动作，Messages 窗口上方 tclconsole 都有对应命令 ——
# 学习路径：先复制粘贴 GUI 生成的命令，再拼装成脚本。
```

| Tcl 高频命令 | 用途 

| get_ports / get_pins / get_cells -filter | 按名/属性选对象，写约束脚本的基础 

| report_utilization / report_timing_summary | 资源与时序报告（-file 落盘归档） 

| write_bitstream / write_hw_platform -include_bit | 产物导出；后者即导 XSA 的命令形态 

| read_xdc / create_clock | 动态注入约束（实验对比用） 

### 4.9 深潜：License 与版本管理细则

- WebPack 免费许可绑定账号登录（联网激活一次即可离线一段时间）；付费 License 文件放 `%XILINXD_LICENSE_FILE%` 指向路径或 `C:\.Xilinx\Xilinx.lic`；
- 多版本共存：安装目录隔离即可（2020.2 与 2018.3 可并存），注意 **Xilinx 环境变量冲突**——命令行用各自 settings64.bat 初始化；
- 团队协作：统一版本+统一补丁（AR# 更新包），工程内记录 `vivado -version` 输出到版本说明。

### 5.7 深潜：function 与 task —— 代码复用两件套
```
/* function：纯组合、零延时、必须有时耗返回值 —— 当"表达式"用 */
function automatic [7:0] byte_swap(input [7:0] d);   /* automatic可重入 */
    byte_swap = {d[3:0], d[7:4]};
endfunction
assign out = byte_swap(din);

/* task：可含时序控制(仅仿真/不可综合延时)——测试平台主力 */
task automatic send_byte(input [7:0] d);
    for (int i = 0; i < 8; i++) begin
        uart_tx = d[i]; @(posedge clk);
    end
endtask
```

### 5.8 深潜：generate 再进一步 —— 参数化 N 位流水灯
```
module flow_led #(parameter WIDTH=4, CNT_MAX=12_500_000)
(
 input clk,rst_n, output wire [WIDTH-1:0] led
);
genvar g;
wire [WIDTH-1:0] tap;
/* 位宽无关写法：移位方向统一，首尾由 generate 补接 */
assign tap[0] = tap[WIDTH-1];
generate for (g=1; g<WIDTH; g=g+1) begin : STAGE
    my_dff u(.clk(clk),.rst_n(rst_n),.d(tap[g-1]),.q(tap[g]));
end endgenerate
assign led = tap;
endmodule
/* 改 WIDTH 即得 8/16 路版本 —— "参数化+生成"是 IP 化思维的第一课 */
```

### 5.9 深潜：自校验 Testbench 与并发断言
```
/* 手工看波形 → 自动判分：错误计数器 + 断言 */
integer errors = 0;
always @(posedge clk) if (state==S_DONE && data_out !== expect_q)
begin $display("[%0t] FAIL got=%h exp=%h", $time, data_out, expect_q); errors++; end
final? 用 initial #MAX_TIME:
initial begin #1_000_000;
  if (errors==0) $display("*** TEST PASS ***"); else $display("*** %0d ERRORS ***",errors);
  $finish; end

/* SVA 立即断言(可综合工具也识别用于形式化)：
   assert property (@(posedge clk) start |-> ##2 busy)
   else $error("start后2拍busy未置位"); */
```
纪律升级：**每个模块交付时附带 self-checking tb**——回归时只看 PASS/FAIL 行，这是第三篇与第四篇自动化测试的思想源头。

### 5.10 深潜：有符号运算与截断陷阱三则

- 比较两侧一边无符号一边有符号 → 整体按无符号比，-1 变成最大数！统一 `$signed()` 显式声明；
- `a >> s` 对有符号数是逻辑右移（高位补0），算术右移用 `$signed(a) >>> s`；
- 乘法位宽：结果位宽=操作数之和，但中间表达式会被上下文截断 —— 关键路径先扩位再算：`wire signed [33:0] p = a * b;`(a,b 各17位)。

[下一篇 →第6章 第一个FPGA工程：纯PL流水灯](#ch06)

---

## 第6章 第一个 FPGA 工程：纯 PL 流水灯
完整走通「建工程 → 写代码 → 加约束 → 综合 → 实现 → 烧写 → 验证」—— 这条流水线你将重复上百次。

**🎯 学习目标**
- 独立完成一个 Vivado 工程从零到上板的全流程
- 理解综合/实现/比特流各阶段做了什么
- 掌握 JTAG 临时下载与 QSPI 固化两种烧写方式

### 6.1 创建工程

- 启动 Vivado → **Create Project** → RTL Project，勾选 *Do not specify sources at this time*。
- 器件选择：`xc7z020clg484-1`（领航者对应型号，Package=clg484，Speed=-1/-2 以丝印为准）。可收藏为默认部件避免每次搜索。
- 工程名 `pl_flow_led`，路径**无中文无空格**（如 `D:\work\fpga\pl_flow_led`）。

📌 为什么是 -1 速度等级？
Vivado 器件列表中 xc7z020clg484 有 -1/-2/-3 变体，代表速度等级。选高等级综合时序更宽松但真实芯片不支持。正点原子领航者资料通常按 **-1** 教学（保守稳妥），若你确认板卡为 -2 芯片也可选 -2。不确定就选 -1 —— 时序报告偏悲观总好过假乐观。

### 6.2 设计输入
**Add Sources → Add or create design sources → Create File**，新建 `flow_led.v`：

```
module flow_led #(
    parameter CNT_MAX = 12_500_000        // 50MHz / 12.5M = 4Hz 移位节拍
)(
    input  wire       sys_clk,            // 板载 50MHz（引脚查原理图）
    input  wire       rst_n,              // 复位按键（低有效）
    output wire [3:0] led                 // 4 个用户 LED（引脚查原理图）
);

reg [23:0] cnt;                           // 2^24 = 16.7M < 12.5M? 注意：需 24 位即可装下 1250 万

always @(posedge sys_clk or negedge rst_n) begin
    if (!rst_n)
        cnt <= 24'd0;
    else if (cnt == CNT_MAX - 1'b1)
        cnt <= 24'd0;
    else
        cnt <= cnt + 1'b1;
end

reg [3:0] led_r;

always @(posedge sys_clk or negedge rst_n) begin
    if (!rst_n)
        led_r <= 4'b0001;                              // 初始点亮 LED0
    else if (cnt == CNT_MAX - 1'b1)
        led_r <= {led_r[2:0], led_r[3]};               // 循环左移
end

assign led = led_r;                       // 若板卡 LED 低电平点亮，改为 ~led_r

endmodule
```

**Add Sources → Add or create constraints**，新建 `flow_led.xdc`（引脚号务必替换为你第3章查图结果）：

```
# 时钟
set_property -dict {PACKAGE_PIN N18 IOSTANDARD LVCMOS33} [get_ports sys_clk]
create_clock -period 20.000 -name sys_clk [get_ports sys_clk]
# 复位按键
set_property -dict {PACKAGE_PIN C10 IOSTANDARD LVCMOS33} [get_ports rst_n]
# 4 个 LED（示例引脚，以原理图为准）
set_property -dict {PACKAGE_PIN H17 IOSTANDARD LVCMOS33} [get_ports {led[0]}]
set_property -dict {PACKAGE_PIN K15 IOSTANDARD LVCMOS33} [get_ports {led[1]}]
set_property -dict {PACKAGE_PIN J15 IOSTANDARD LVCMOS33} [get_ports {led[2]}]
set_property -dict {PACKAGE_PIN K16 IOSTANDARD LVCMOS33} [get_ports {led[3]}]
```

### 6.3 编译流水线：每个阶段在做什么？
点击左侧 **Flow Navigator** 依次执行：

| 阶段 | 按钮 | 做的事 | 产物 

| 综合 Synthesis | Run Synthesis | RTL → 门级网表（把代码翻译成 LUT/FF/BRAM 连接关系）并做首次逻辑优化 | .dcp 网表 

| 实现 Implementation | Run Implementation | 布局布线：网表放进真实 CLB 位置、在开关矩阵里连线，满足时序 | .bit 所需的完整数据库 

| 比特流 Bitstream | Generate Bitstream | 打包配置数据为 .bit 文件 | flow_led.bit 

💡 打开时序报告的习惯
实现完成后弹出对话框选择 *Open Implemented Design* → **Reports → Report Timing Summary**。关注 WNS（最差裕量）：正值通过，负值违例。现在这个低速设计必然轻松通过，但请从第一个工程就建立「看时序」的条件反射，第22章将深入。

### 6.4 JTAG 下载验证

- USB 线连接板卡，启动模式拨码设为 **JTAG**，上电。
- **Open Hardware Manager → Open Target → Auto Connect**，应看到 `xc7z020`。
- 右键器件 → **Program Device** → 选择自动填充的 bit 文件 → Program。
- 观察板上 4 个 LED 循环流水。按住复位键流水停止，松开恢复。

⚠️ JTAG 下载是「易失」的
FPGA 配置存储器是 SRAM：断电即丢、重新上电变空白。要产品化必须固化 —— 见下一节。调试阶段反复改代码时，JTAG 快速迭代反而是优点。

### 6.5 固化到 QSPI Flash

- **Tools → Generate Memory Configuration File**：Format 选 MCS，Size 按 32MB（0x2000000），生成 `flow_led.mcs`。（或在 Hardware Manager 中右键 Add Configuration Memory Device 直接关联 bit。）
- Hardware Manager 中 **Add Configuration Memory Device** → 搜索并选择板载 QSPI 型号（领航者为 `s25fl256sxxxxxx0-spi-x1_x2_x4` 系列，具体以手册为准；选错型号会烧写失败或无法启动）。
- 提示关联编程文件时选择刚生成的 mcs，OK 后开始写入（几分钟）。
- 写入完成后断电，启动模式拨到 **QSPI**，重新上电 —— LED 自动恢复流水灯。

🚨 固化后启动失败的排查顺序
① 启动模式拨码真的拨到 QSPI 了吗？（Top 常见原因）② 配置器件型号是否选对；③ BOOT.MODE 与 MIO 上拉是否被外设干扰；④ 用串口观察是否有 FSBL 输出（本例纯 PL 无 FSBL 属正常，LED 即是全部现象）。

### 6.6 认识 Vivado 工程结构（Git 必备知识）
```
pl_flow_led/
├── pl_flow_led.xpr          # 工程入口（XML）
├── pl_flow_led.srcs/        # ★ 源码：sources_1(.v) + constrs_1(.xdc) + sim_1(tb)
├── pl_flow_led.gen/         # IP/BD 输出
├── pl_flow_led.cache/       # 综合缓存（大，可不提交）
├── pl_flow_led.hw/          # 硬件管理器记录
└── pl_flow_led.runs/        # ★ 综合实现结果（含 .bit）

# .gitignore 建议忽略 cache/ runs/ hw/ gen/，
# 只提交 xpr + srcs/ —— 别人 clone 后重新 Run Synthesis 即可复现。
```

### 常见问题 FAQ（避坑指南）
Q1：Generate Bitstream 报错 place/route 未跑？Vivado 会自动串联三步，若中途报错先看 Messages 窗口第一条 **ERROR**（不是最后一条）。新手高频错误：XDC 引脚拼写与端口名不一致（大小写敏感）、端口名带空格、忘记 create_clock 导致后续 DRC 失败。

Q2：Program Device 时找不到目标？① 板卡电源没开或 USB 线数据芯损坏；② Windows 下 JTAG 驱动未装好（设备管理器有感叹号）；③ 虚拟机抢占了 USB 设备——在 VMware 中断开与虚拟机的连接；④ 多个 Vivado 实例争用 hw_server，任务栏结束所有 hw_server.exe 重试。

Q3：为什么我的流水灯第一格亮很久才开始流动？CNT_MAX 设得过大（如 25M 对应 0.5s 但你感觉像 2s），检查板载时钟实际频率：有的板子 PL 全局时钟是 100MHz 或 200MHz，计数上限要按实际频率换算。用ILA实测频率是最稳的办法（第21章）。

**🧪 动手实验 L6-1：交互式流水灯**
在 6.2 工程基础上增加两个按键：`key_dir` 按下切换移位方向，`key_speed` 在 4Hz/1Hz 两档间切换（提示：参数化两个 CNT 上限 + mux 选择）。要求：按键输入先用实验 L5-1 的消抖模块处理。完成后 JTAG 下载验证，再走一遍 QSPI 固化流程巩固记忆。

**📝 思考题**
- 综合通过但实现失败，问题可能出在哪一类资源上？（提示：布局布线要面对物理现实）
- 如果要把流水灯改成 8 路 PWM 呼吸灯，计数器架构需要怎么改造？估算需要多少个 FF。
- 解释为什么 QSPI 固化文件要用 MCS 格式而不是直接写 bit？两者内容有何差别？

[← 上一篇第5章 Verilog HDL 快速入门](#ch05)
### 6.7 深潜：工程模板化 —— 十分钟起新项目
把 6.2 的源码/约束抽成模板仓库 `tpl-zynq-pl/`（含空 top、通用 XDC、tb 骨架、build.tcl），新实验三步：`cp -r tpl new_lab → 改模块名/引脚 → vivado -mode batch -source build.tcl`。配合 Git tag（lab06-pass），每个实验可复现可回溯 —— 这套模板将直接演化为第41章项目的工程底座。

💡 非工程模式（Non-Project Mode）一句话
不建 .xpr、全程 Tcl 手工调度 synth_design/opt_design/place_design/route_design/write_bitstream —— 灵活度最高、CI 首选；初学阶段用 Project Mode + build.tcl 足够，知道存在即可。

[下一篇 →第7章 PS裸机开发入门：Hello ZYNQ](#ch07)

---

