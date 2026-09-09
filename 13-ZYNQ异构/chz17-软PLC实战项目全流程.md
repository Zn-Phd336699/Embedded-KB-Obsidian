---
title: "软PLC实战项目全流程"
date: 2025-09-09
category: "ZYNQ异构"
tags: ["ZYNQ", "软PLC", "工业自动化", "Modbus", "梯形图", "UIO"]
description: "软PLC项目完整实战：需求分析、PL侧IO引擎、UIO驱动、运行时内核、梯形图解释器、定时器计数器、Modbus TCP/RTU、Web监控、系统集成"
---

# 软PLC实战项目全流程

> 软PLC项目完整实战：需求分析、PL侧IO引擎、UIO驱动、运行时内核、梯形图解释器、定时器计数器、Modbus TCP/RTU、Web监控、系统集成

## 目录

1. [[#项目需求分析与总体架构|项目需求分析与总体架构]]
2. [[#PL 侧 IO 引擎设计|PL 侧 IO 引擎设计]]
3. [[#Linux 平台定制与 UIO 驱动|Linux 平台定制与 UIO 驱动]]
4. [[#软 PLC 运行时内核设计|软 PLC 运行时内核设计]]
5. [[#梯形图解释器实现|梯形图解释器实现]]
6. [[#功能块：定时器与计数器|功能块：定时器与计数器]]
7. [[#Modbus TCP / RTU 从站实现|Modbus TCP / RTU 从站实现]]
8. [[#Web 监控界面|Web 监控界面]]
9. [[#系统集成与开机自启|系统集成与开机自启]]
10. [[#综合案例与验收测试|综合案例与验收测试]]
11. [[#项目总结与技术展望|项目总结与技术展望]]

---

## 第26章 项目需求分析与总体架构
像产品经理一样定义边界，像架构师一样切分模块 —— 磨刀两章，砍柴九章。

**🎯 学习目标**
- 理解 PLC 的核心概念：扫描周期、IEC 61131-3、软 PLC 形态
- 完成本项目的需求规格与验收指标
- 掌握 ZYNQ 软 PLC 的经典架构与模块契约

### 26.1 PLC 与 IEC 61131-3 三十秒入门
**PLC（可编程逻辑控制器）**是工业自动化的「大脑」，其灵魂是**扫描周期模型**：周而复始地执行「*读输入 → 解算逻辑 → 写输出*」三段式循环，周期典型 1~20ms。编程语言由国际标准 **IEC 61131-3** 规定五种：梯形图 LD（电气工程师最爱）、功能块图 FBD、结构化文本 ST、指令表 IL、顺序功能图 SFC。

**软 PLC** = 用通用 SoC/工控机 + 软件运行时实现上述功能。相比传统硬 PLC：硬件成本低、生态开放（Linux 网络/Web/AI 全都能上）；代价是实时性依赖系统设计 —— 而 **ZYNQ 的 PL 恰好用硬件逻辑补齐了实时短板**，这正是本项目选它的根本原因。

### 26.2 需求规格书 v1.0

| # | 需求项 | 规格 | 验收方式 

| R1 | 数字量输入 DI | 8 路，板载去抖 ≥10ms 可配，边沿事件上报 | L35 用例 V-DI 

| R2 | 数字量输出 DO | 8 路，支持软件强制(force)覆盖逻辑输出 | V-DO 

| R3 | 模拟量输入 AI | 2 路 XADC，0~1V，12bit，更新率 ≥100Hz | V-AI 标定误差≤2% 

| R4 | PWM 输出 | 2 路，100Hz~10kHz，占空比 0~100% 运行时可调 | 示波器实测 

| R5 | 梯形图运行时 | LD→IL 编译执行；触点/线圈/定时器 TON·TOFF·TP/计数器 CTU·CTD | 标准用例程序全过 

| R6 | 扫描周期 | 标称 10ms，抖动 <±1ms（默认内核） | 30min 统计报告 

| R7 | Modbus 从站 | TCP(502) + RTU(RS485可选) 双栈；FC1/2/3/5/6/15/16 | Modbus Poll 主站验证 

| R8 | Web 监控 | HTTP 页面实时显示 IO/变量/周期，支持强制与启停 | 浏览器演示 

| R9 | 可靠性 | 开机自启；运行时崩溃自动重启；看门狗三级防线 | kill -9 测试 

### 26.3 总体架构一张图

PL · IO 引擎（第27章，Verilog）
DI 滤波 ×810ms 去抖+沿检测
DO 寄存器 ×8 + Force硬件自治输出
PWM ×2独立分频/占空比
XADC 控制接口AI×2 平均滤波
AXI4-Lite 从设备：统一寄存器映射CTRL/DI/DO/AI/PWM/EVENT（见27.3表）
中断汇聚：DI变化 | AI就绪 → IRQ_F2P[0]50kHz 扫描节拍发生器
PS · Linux 5.4（第28~34章）
plcio 平台驱动/UIO寄存器+中断抽象（28章）
PLC Runtime 内核10ms扫描+IL解释器(29~31)
Modbus TCP :502RTU /dev/ttyPS1（32章）
Web 服务 :8080HTTP JSON API（33章）
共享映像区 Image Map（互斥保护）%IX %QX %IW %QW %MW —— 三线程读写唯一真源
系统集成层（34章）init脚本自启 · watchdog · 配置文件日志环形缓冲 · 版本API
- 

寄存器读/写

中断
外部世界：按键/继电器接扩展排针 · 电位器→XADC · RS485/网线→主站与浏览器

图26-1 软 PLC 总体架构与模块契约总览

### 26.4 关键架构决策记录（ADR）

| 决策点 | 选择 | 理由 

| IO 采样放哪？ | PL 硬件滤波 + 中断上报 | CPU 抖动不影响输入时序；输出由 PL 自治保持 

| 解释器形态 | 自研 IL 虚拟机（文本指令表） | 教学价值最大化；代码量可控(<2000行)；LD 由配套 Python 工具编译为 IL 

| 驱动方案 | UIO(generic-uio) 为主 | 避免内核态代码维护成本；中断语义足够；同时保留字符驱动对照实现 

| 通信框架 | 自研轻量 Modbus 从站 | libmodbus 移植作对照；自研才能讲透帧解析与并发 

| 实时性等级 | 标准内核 + ABSTIME 睡眠 | 满足 R6 即达标；PREEMPT_RT 作为拓展任务 

### 26.5 开发里程碑（与章节对应）

| 里程碑 | 内容 | 章节 

| M1 | PL IO 引擎 bitstream 通过仿真与 ILA 验证 | 27 

| M2 | Linux 能读写全部寄存器并收到中断 | 28 

| M3 | 运行时跑通首个梯形图（启保停） | 29~30 

| M4 | 定时器/计数器功能块齐全 | 31 

| M5 | Modbus 双栈从站上线 | 32 

| M6 | Web 监控 + 自启 + 综合验收 | 33~35 

### 常见问题 FAQ（避坑指南）
Q1：为什么不用 CODESYS/Beremiz 现成运行时？商业 CODESYS 收费且黑盒；Beremiz/MatIEC 开源但工程链复杂，初学者极易迷失在工具而非原理里。自研迷你运行时（约2000行C）让你吃透扫描模型、解释器、通信三大件 —— 之后再用开源方案就是降维使用。课程第36章会给出对接 Beremiz 的路线图。

Q2：10ms 够做什么真实控制？电机启停、阀门开关、灯光联锁、温控 PID（慢对象）绰绰有余 —— 这正是主流小型 PLC 的档位。伺服级运动控制需 μs 级，那是 PL 侧专项逻辑的领地（拓展方向）。

Q3：没有 RS485 外设能做 RTU 吗？可以：USB 转 485 接板卡 USB 口走 /dev/ttyUSB0，或主机侧用 USB-RS485 当主站模拟。协议层与物理介质无关，教学目标完全达成。

**📝 思考题**
解释「读输入→解算→写输出」为何必须原子成批交换，而不能边算边写 IO？（提示：竞态与一致性）
- 若客户提出「断电后保持计数器值」，架构上需要新增什么机制？评估工作量。
- 对比你的方案与西门子 S7-200 SMART 的规格差异，写出三条你项目的差异化卖点。

[← 上一篇第25章 内核调试与联合验证方法论](#ch25)
[下一篇 →第27章 PL侧IO引擎设计](#ch27)

---

## 第27章 PL 侧 IO 引擎设计
本章交付软 PLC 的「硬件肌肉」：去抖 DI、自治 DO、PWM、AI 均值、中断汇聚 —— 全部封装为一个 AXI 从设备。

**🎯 学习目标**
- 完成 plc_io_engine 的模块设计与全部核心 RTL
- 固化软硬件寄存器合同 v1.0
- 用仿真+ILA 双重手段验证 IO 时序指标

### 27.1 模块划分
```
plc_io_engine/
├── plc_io_engine.v        # 顶层：例化 AXI-Lite 从机模板(第9章方法) + 各功能块
├── di_filter.v            # DI 去抖 + 边沿检测 + 事件锁存   (本节重点)
├── pwm_gen.v              # 独立双路 PWM                     (本节重点)
├── ai_avg.v               # XADC 读数滑动均值滤波
└── irq_catch.v            # 中断源聚合 + 写1清除
```

### 27.2 寄存器映射 v1.0（软硬件合同，冻结！）

| 偏移 | 名称 | R/W | 位定义 

| 0x00 | ID | R | 固定 0x504C_4331 ("PLC1") 

| 0x04 | CTRL | R/W | bit0=全局使能, bit1=软件复位, bit8=中断使能(DI), bit9=中断使能(AI) 

| 0x08 | DI_LEVEL | R | bit[7:0] 滤波后电平（1=有效） 

| 0x0C | DI_RISE | R/W1C | 上升沿事件锁存，写 1 清除 

| 0x10 | DI_FALL | R/W1C | 下降沿事件锁存，写 1 清除 

| 0x14 | DI_DEBCYCLE | R/W | [15:0] 去抖拍数（默认 500_000=10ms@50MHz） 

| 0x18 | DO_OUT | R/W | bit[7:0] 逻辑输出值 

| 0x1C | DO_FORCE_EN | R/W | bit[i]=1 → 通道 i 被 FORCE_VAL 接管 

| 0x20 | DO_FORCE_VAL | R/W | 强制值 

| 0x24 | AI_CH0 | R | 12bit 均值结果 <<4 | 有效标志 

| 0x28 | AI_CH1 | R | 同上 

| 0x2C | PWM0_CFG | R/W | [31:16]=周期计数, [15:0]=占空比计数 

| 0x30 | PWM1_CFG | R/W | 同上 

| 0x34 | EVT_TICKCNT | R | 32bit 自由运行节拍计数（软件算周期用） 

| 0x38 | IRQ_STATUS | R/W1C | bit0=DI事件挂起, bit1=AI就绪挂起 

### 27.3 DI 滤波模块（核心 RTL）
```
module di_filter #(
    parameter WIDTH = 8,
    parameter DEF_CYC = 500_000                 // 10ms @50MHz
)(
    input  wire             clk,
    input  wire             rst_n,
    input  wire [WIDTH-1:0] raw_in,             // 板级按键/开关（低有效已在外部处理）
    input  wire [15:0]      deb_cycle,
    output reg  [WIDTH-1:0] level,              // 稳定电平
    output reg  [WIDTH-1:0] rise,               // 上升沿脉冲（同步到 clk 单周期）
    output reg  [WIDTH-1:0] fall
);
    reg [WIDTH-1:0] sync_ff;                    // 两级同步（防亚稳态，22章！）
    always @(posedge clk or negedge rst_n)
        if (!rst_n) sync_ff <= '0;
        else        sync_ff <= {sync_ff[WIDTH-2:0], raw_in};

    genvar g;
    generate for (g = 0; g < WIDTH; g = g + 1) begin : CH
        reg [15:0] cnt;
        reg        stable;
        always @(posedge clk or negedge rst_n) begin
            if (!rst_n) begin
                cnt <= '0; stable <= 1'b0;
            end else if (sync_ff[g] == stable) begin
                cnt <= '0;                      // 与当前稳态一致→清零重来
            end else begin
                // 输入异于稳态：持续计数，满 deb_cycle 拍才翻转
                if (cnt >= deb_cycle - 1'b1) begin
                    stable <= sync_ff[g];       // 连续 N 拍一致才更新稳态
                    cnt    <= '0;
                end else
                    cnt <= cnt + 1'b1;
            end
        end
        assign level_bit = stable;
    end endgenerate

    wire [WIDTH-1:0] lv;
    // ... 将各通道 stable 汇成 lv（工程上用数组端口，此处示意） ...

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            level <= '0; rise <= '0; fall <= '0;
        end else begin
            level     <= lv;
            rise      <=  lv & ~level;          // 新旧相与出沿
            fall      <= ~lv &  level;
        end
    end
endmodule
```
⚠️ 关于上面 generate 的写法
为了版面简洁做了示意性省略（lv 汇聚与动态阈值）。**请把它当伪码骨架**：动手补全每通道 stable 数组化（用 `reg stable_arr[WIDTH-1:0]` + for 循环而非 generate），这正是 L27-1 的任务之一 —— 亲手补全的过程就是最好的练习。

### 27.4 PWM 发生器
```
module pwm_gen #(parameter DEF_PERIOD = 50_000)(   // 默认 1kHz@50MHz
    input  wire        clk, rst_n, en,
    input  wire [15:0] period, duty,           // 计数值：freq=clk/period
    output reg         pwm_o
);
    reg [15:0] cnt;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)          cnt <= '0;
        else if (!en || period == '0) cnt <= '0;
        else if (cnt >= period - 1'b1) cnt <= '0;
        else                           cnt <= cnt + 1'b1;
    end
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)                       pwm_o <= 1'b0;
        else if (!en)                     pwm_o <= 1'b0;
        else                              pwm_o <= (cnt < duty);
    end
endmodule
```

### 27.5 中断汇聚与 AI 均值（要点）

- **irq_catch**：把 DI 的 rise/fall 或非零事件 OR 起来置 `IRQ_STATUS.bit0`；AI 每 64 次采样完成置 bit1。**只有 CTRL 对应使能位打开才输出到 IRQ_F2P[0]**；软件写 1 清除对应挂起位后拉低中断线 —— 「电平型中断 + W1C」是 Linux 驱动最喜欢的模型。
- **ai_avg**：对 XADC IP 的 AXI 读数做 16 点滑动窗均值，输出 `{valid, mean[11:0], 4'h0}` 打包进 0x24/0x28。
- **EVT_TICKCNT**：自由跑的 32 位计数器，软件两次采样差即真实扫描耗时 —— R6 验收的数据源。

### 27.6 集成与上板验证

- 顶层把各模块接到第9章模板生成的 `slv_reg0..15`（扩展到 16 个寄存器）；对外引出 `di_i[7:0]/do_o[7:0]/pwm_o[1:0]`；
- BD 中：Add IP（仓库）→ S_AXI 自动连 SmartConnect/M_AXI_GP0 → `interrupt` 口连 **xlconcat → IRQ_F2P[0]**（ZYNQ PS 核勾选 IRQ_F2P）；di/do/pwm Make External 后 XDC 绑排针；
- Address Editor 记下基址（示例取 **0x43C10000**）→ Export XSA；
- **Vitis 裸机冒烟测试**（先不上Linux）：Xil_Out32(ID)=0x504C4331 ✓ → 写 DEBCYCLE → 手按按键轮询 DI_LEVEL 变化 → 写 DO_FORCE 观察排针电平。全绿再进入第28章。
- ILA 复核：抓 raw_in 与 level 波形实测去抖窗口 ≈ 设定值 ±1 拍。

### 常见问题 FAQ（避坑指南）
Q1：DI 抖动偶尔漏事件？检查三处：① 同步器是否两级且无中间组合逻辑；② rise/fall 锁存是否被软件清得太快导致覆盖（改为「事件置位保持直到 W1C」，即锁存器语义而非脉冲直通）；③ 去抖阈值期间发生的多次物理抖动合并为一次是设计预期，不是 bug。

Q2：DO 强制功能写入后输出不变？Force 是「每拍生效」的组合优先逻辑：`do_final = force_en ? force_val : do_out`。若写成仅在写寄存器瞬间采样就会失效。同时确认全局使能 bit0 已置位。

Q3：PWM 占空比写 0 仍有一小尖峰？duty==0 时比较恒假应恒低，出现尖峰说明 cnt==duty 相等瞬间被计入高段。修复：条件改 `(cnt < duty) && (duty != 0)`，或让 duty=period 表示常高。

**🧪 动手实验 L27-1：补全并证明它**
① 补全 27.3 的 generate/汇聚省略部分，写出可综合完整版；② 编写 testbench：模拟一个带 3ms 抖动的按键波形，断言 level 仅翻转一次、rise 恰好一拍宽；③ 上板后用 devmem 冒烟（25章技能）逐寄存器核对合同表，截图归档 —— 这张「验收单」是 M1 里程碑的通关文牒。

**📝 思考题**
- 为什么 DI 事件要做成「锁存+W1C」而不是直接把脉冲送给 PS？（提示：扫描周期与事件到达的相位差）
- 若把引擎时钟从 50MHz 换成 FCLK_CLK0 的 100MHz，哪些参数要联动修改？
- 设计「看门狗喂狗信号由 PL 生成、PS 必须周期性清 EVENT_TICKCNT 才不触发硬件复位」的最小方案。

### 27.7 深潜：IO 引擎的仿真验证与上板调试全流程 ★
#### ① 分层 Testbench 结构（每个模块独立可回归）

| 层级 | 测试对象 | 自检断言示例 

| 单元级 | di_filter 单通道 | 注入「稳定20ms→翻转」波形，断言 rise 恰好 1 拍且时刻误差 ≤2 拍 

| 单元级 | pwm_gen | duty=0 恒低 / duty=period 恒高 / 中途改占空比下一周期生效 

| 集成级 | AXI 从机+全部寄存器 | VIP 写读回所有 W1C 寄存器；Force 覆盖优先级矩阵（force_en×logic 值 4 组合） 

| 系统级 | 中断行为 | 事件→IRQ 拉高→写1清除→拉低，时序断言 

```
/* 自检tb模板: 任务化激励+自动判分(5.9节风格) */
task test_debounce(input int jitter_ns);
    apply_key_with_jitter(jitter_ns);      /* 抖动模型: 随机毛刺+稳定段 */
    @(posedge virt_done);
    if (rise_cnt !== 1 || fall_seen) begin
        $error("debounce FAIL j=%0d rises=%0d", jitter_ns, rise_cnt); err++;
    end
endtask
initial begin
    test_debounce(100_000);   /* 远小于阈值 */
    test_debounce(9_900_000); /* 接近10ms阈值——边界! */
    if (err==0) $display("*** IO-ENGINE TB PASS ***");
    $finish;
end
```

#### ② 上板 Bring-up 顺序（每步一条 devmem 铁证）
```
Step1 时钟活: 读 TICKCNT(0x34) 两次差值 >0          ← 一票否决项
Step2 ID对:  devmem 0x43C10000 == 0x504C4331
Step3 DI链:  手按按键, DI_LEVEL 对应位变化; DEBCYCLE 改大后响应变慢 ✓
Step4 DO链:  FORCE 全置/全清, 万用表量排针电平
Step5 PWM:   示波器测频率=clk/period, 占空比线性扫掠无死区
Step6 AI:    电位器旋转 raw 单调变化, 断线标志触发
Step7 中断:  /proc/interrupts GIC61 计数随按键增长; poll 收到事件
/* 每一步通过才进下一步 —— 出问题立即锁定在本层, 这是 bring-up 纪律 */
```

#### ③ Bring-up 高频 Bug Top5（症状→根因）

- TICK 不走 → ACLK 未连/复位极性反（低有效写成高有效）——占新工程故障 40%；
- ID 读回全 0 → 地址窗口错或 bitstream 是旧的（先查 Vivado 是否真的重新生成了 bit）；
- DI 电平反相 → 板卡按键低有效但 IP 按 high-active 设计 —— 在 XDC 或 IP 参数层统一约定；
- 中断只来一次 → W1C 写的是「整字回写」把其他挂起位也清了 —— 必须读-改-写仅清本源位；
- PWM 有窄毛刺 → duty 边界比较含等号（27.4 FAQ 同源），仿真边界用例可提前拦截。

[← 上一篇第26章 项目需求分析与总体架构](#ch26)
[下一篇 →第28章 Linux平台定制与UIO驱动](#ch28)

---

## 第28章 Linux 平台定制与 UIO 驱动
M2 里程碑：让用户态程序读写 IO 引擎全部寄存器、并稳定收到硬件中断。

**🎯 学习目标**
- 掌握 UIO(generic-uio) 机制的原理与设备树配置
- 封装 plcio 用户态库：寄存器 API + 中断等待线程
- 理解 UIO 与自写字符驱动的工程取舍

### 28.1 为什么选 UIO
UIO（Userspace I/O）内核框架只做三件事：**mmap 物理寄存器窗口、挂接 IRQ、把「等中断」变成对 `/dev/uioX` 的阻塞 read**。业务逻辑全在用户态 —— 对 PL 自定义 IP 这类「私有协议寄存器堆」是最省心的方案：

| 维度 | UIO 方案 | 自写字符驱动（17/18章） 

| 开发量 | 仅 DTS + 用户态库 | 完整内核模块 + 维护内核版本兼容 

| 实时性 | 中断→唤醒约 10~50μs，足够 PLC 扫描 | 相当（ISR 更快但差异对本项目无感） 

| 安全性 | 用户态崩溃不连累内核 ★ | 驱动 bug = 系统级风险 

| 适用边界 | 寄存器型简单交互；无 DMA | 需要内核服务（DMA/子系统接入）时必选 

### 28.2 设备树与内核配置
```
/* system-user.dtsi */
/ {
    plc_io@43c10000 {
        compatible   = "generic-uio";        /* 触发 uio_pdrv_genirq 绑定 */
        reg          = <0x43c10000 0x1000>;
        interrupt-parent = <&intc>;
        interrupts   = <0 29 4>;             /* IRQ_F2P[0] → GIC61 */
    };
};
```
```
# 内核确认（14章 menuconfig 已开）：
CONFIG_UIO=y
CONFIG_UIO_PDRV_GENIRQ=y
# PetaLinux rootfs 里让节点名固定为 uio0 而非 uio1：
# 追加到 system-user.dtsi 根节点：
#   chosen { ... } 同级加：
#   uio_alias: alias 无需 —— 直接用 by-name 查找更稳（见28.3库代码）
# 板上验证：
dmesg | grep -i uio          # generic-uio: probe 成功
ls -l /dev/uio*              # 出现设备节点
cat /sys/class/uio/uio0/name # "generic-uio"
cat /sys/class/uio/uio0/maps/map0/addr   # 0x43c10000 ✓
```

### 28.3 用户态库 plcio.h / plcio.c（运行时地基）
```
/* plcio.h —— 寄存器合同(27.2)的软件投影 */
#include <stdint.h>
enum {
    REG_ID=0x00, REG_CTRL=0x04, REG_DI=0x08, REG_DIRISE=0x0C, REG_DIFALL=0x10,
    REG_DEBCYC=0x14, REG_DO=0x18, REG_FEN=0x1C, REG_FVAL=0x20,
    REG_AI0=0x24, REG_AI1=0x28, REG_PWM0=0x2C, REG_PWM1=0x30,
    REG_TICK=0x34, REG_IRQST=0x38,
};
int  plcio_open(const char *uioname);        /* 按 name 匹配 /sys/class/uio */
void plcio_close(void);
uint32_t plcio_rd(uint32_t off);
void     plcio_wr(uint32_t off, uint32_t val);
int      plcio_wait_irq(int timeout_ms);     /* >0 收到中断; 0 超时 */

/* plcio.c 关键实现节选 */
static int uio_fd = -1;
static volatile uint32_t *regs;

int plcio_open(const char *want)
{
    char path[256];
    for (int i = 0; i < 8; i++) {            /* 按 name 找，避免编号漂移 */
        snprintf(path, sizeof path,
                 "/sys/class/uio/uio%d/name", i);
        FILE *f = fopen(path, "r");
        if (!f) continue;
        char nm[64] = {0}; fgets(nm, sizeof nm, f); fclose(f);
        if (strncmp(nm, want, strlen(want))) continue;

        snprintf(path, sizeof path, "/dev/uio%d", i);
        uio_fd = open(path, O_RDWR | O_SYNC);
        int mfd = open(path, O_RDWR | O_SYNC);   /* mmap 用同一 fd 即可 */
        regs = mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_SHARED, mfd, 0);
        return (regs == MAP_FAILED) ? -1 : 0;
    }
    return -1;
}

int plcio_wait_irq(int timeout_ms)
{
    struct pollfd p = { .fd = uio_fd, .events = POLLIN };
    int r = poll(&p, 1, timeout_ms);
    if (r > 0) {
        uint32_t nread; read(uio_fd, &nread, 4);/* 读走触发次数(必需！) */
        return 1;                                /* 下次中断自动重新使能 */
    }
    return r;                                    /* 0=超时, <0=错误 */
}
```
📌 generic-uio 中断语义
收到中断后内核**自动屏蔽**该 IRQ；用户态处理完毕必须 **read() 掉事件计数**，下一次中断才会重新放行 —— 天然防风暴。若用裸 `uio`（非 genirq 版），则要自己写 1 到 `/dev/uio0` 手动 re-enable。

### 28.4 冒烟测试程序
```
#!/bin/sh
# smoke.sh —— M2 验收脚本（25章方法论落地）
devmem 0x43C10004 32 0x1              # CTRL.EN
echo "ID   = $(devmem 0x43C10000)"   # 期望 0x504C4331
echo "DI   = $(devmem 0x43C10008)"
devmem 0x43C1001C 32 0xFF             # 全通道强制
devmem 0x43C10020 32 0xA5             # 强制值 A5
echo "DO   = $(devmem 0x43C10018)"   # 期望 0xA5
# 中断计数对照：
cat /proc/interrupts | grep 61        # 按键前后各看一次，计数应增长
echo "TICK = $(devmem 0x43C10034)"
```
全部符合预期 → **M2 达成**。若 ID 读回 0 或总线挂死，回到第9章 FAQ Q1 的四步排查。

### 常见问题 FAQ（避坑指南）
Q1：/dev/uio0 没出现？① compatible 不是 generic-uio（或内核没开 CONFIG_UIO_PDRV_GENIRQ）；② DTS 改了没重新构建/旧 dtb 在板上；③ 地址与 bitstream 不符导致 probe 失败 —— dmesg 找 uio 相关报错。

Q2：poll 一直不返回？逐级验证：CTRL 的中断使能位（bit8/bit9）是否置位；`/proc/interrupts` 对应 GIC61 计数是否增长（不涨=PL侧没发）；涨了还不醒=用户态忘了 read 清计数导致永久屏蔽。

Q3：mmap 后读写错乱？mmap 偏移必须是**页对齐的物理偏移**（uio 用 map0 即 offset 0），大小不超过 reg 声明窗口；指针必须 volatile 且用 32 位对齐访问。

**🧪 动手实验 L28-1：plcio_test 工具**
基于 plcio 库写一个命令行工具：`plcio_test rd <off> / wr <off> <val> / irqtest / loop 100`。其中 irqtest 连续等待 100 次 DI 中断并统计平均延迟（用 REG_TICK 差值换算）。输出格式化表格 —— 它将成为后续每章联调的标准仪器。

**📝 思考题**
- UIO 模型下如果 PL 发出中断后 1ms 内用户态没 read，第二次中断会丢失吗？对你的 DI 事件设计意味着什么？（提示：27.3 锁存语义的价值）
- 什么信号必须放弃 UIO 回归内核驱动？给出两条硬性判据。
- 设计「寄存器访问审计」：在库层记录最近 64 条读写日志供 Web 页展示，评估其对实时性的影响。

[← 上一篇第27章 PL侧IO引擎设计](#ch27)
[下一篇 →第29章 软PLC运行时内核设计](#ch29)

---

## 第29章 软 PLC 运行时内核设计
M3 前奏：搭出运行时的「骨架」—— 三线程模型、映像区、扫描循环与看门狗。

**🎯 学习目标**
- 设计并实现扫描线程/通信线程/监控线程的协作架构
- 建立 IEC 风格变量映像区与互斥保护
- 实现带抖动统计与超时看门狗的 10ms 扫描循环

### 29.1 进程视图与线程职责

| 执行体 | 周期/触发 | 职责 | 禁止事项 

| **scan 线程** | 10ms 绝对时间睡眠 | 读DI/AI→解算梯形图→写DO/PWM；喂狗；抖动统计 | 禁止 printf/网络调用 ★ 

| comm 线程 | 事件驱动(epoll) | Modbus TCP 监听 + RTU 串口轮询（32章） | 不直接碰硬件寄存器 

| web 线程 | 事件驱动 | HTTP JSON API + 页面静态资源（33章） | 同上 

| irq 辅助 | poll /dev/uio0 | 收 DI 事件 → 写入事件队列唤醒 scan 提前采样（可选优化） | - 

### 29.2 变量映像区：IEC 寻址风格

| 区域 | 前缀 | 容量 | Modbus 映射(32章) | 例子 

| 离散输入 | %IX | 128 点 | Discrete Input (FC2) 只读 | %IX0.3 = DI通道3 

| 离散输出 | %QX | 128 点 | Coil (FC1/5/15) | %QX0.0 = DO通道0 

| 模拟输入 | %IW | 64 字 | Input Register (FC4) | %IW0 = AI_CH0 工程量 

| 保持寄存器 | %MW | 256 字 | Holding Register (FC3/6/16) | 定时器预设/计数值 

```
/* image.h —— 全局唯一真源 */
typedef struct {
    /* 输入半区：scan 更新，他人只读 */
    uint8_t  ix[16];            /* %IX 按位寻址 */
    int16_t  iw[64];
    /* 输出/中间半区：逻辑解算产出，comm/web 可写(MW)可读(QX) */
    uint8_t  qx[16];
    int16_t  mw[256];
    /* 运行统计（只读给外部） */
    uint32_t scan_cnt;          /* 扫描次数 */
    uint32_t scan_max_us, scan_avg_us;
    uint8_t  running;           /* RUN/STOP/FAULT */
} image_t;

extern image_t g_img;                        /* 单实例 */
static inline void img_lock(void)   { pthread_mutex_lock(&g_img_mtx); }
static inline void img_unlock(void) { pthread_mutex_unlock(&g_img_mtx); }
/* 访问纪律：单次锁定内完成"取快照或写回"，锁内不做耗时操作 */
```

### 29.3 扫描循环核心（含看门狗与统计）
```
void *scan_thread(void *arg)
{
    struct timespec next, t0, t1;
    uint32_t last_tick = plcio_rd(REG_TICK);
    clock_gettime(CLOCK_MONOTONIC, &next);

    while (g_running) {
        /* ---- ① 读输入 ---- */
        img_lock();
        uint8_t di = plcio_rd(REG_DI);
        memcpy(g_img.ix, &di, sizeof di);
        g_img.iw[0] = ai_to_engineering(plcio_rd(REG_AI0));   /* 0~10000=0~10V */
        g_img.iw[1] = ai_to_engineering(plcio_rd(REG_AI1));
        img_unlock();

        /* ---- ② 解算用户逻辑（第30章解释器）---- */
        logic_execute();                    /* 内部读写 g_img，自行持锁 */

        /* ---- ③ 写输出 ---- */
        img_lock();
        uint8_t qout = 0;
        memcpy(&qout, g_img.qx, 1);
        img_unlock();
        plcio_wr(REG_DO, qout);             /* PL 自治保持到下周期 */

        /* ---- ④ 周期节拍与看门狗 ---- */
        uint32_t now = plcio_rd(REG_TICK);
        if (now == last_tick && ++stall_cnt > 50) {   /* 500ms 硬件无心跳 */
            log_write(LOG_FAULT, "PL engine stalled!");
            plcio_wr(REG_FVAL, 0);          /* 安全态：全断输出 */
        } else { stall_cnt = 0; last_tick = now; }

        /* ---- ⑤ 定时到下个周期 ---- */
        next.tv_nsec += 10 * 1000000L;
        time_norm(&next);
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);

        /* ---- ⑥ 抖动统计（供 Web 显示）---- */
        clock_gettime(CLOCK_MONOTONIC, &t1);
        long late_us = ts_diff_us(&next, &t1);      /* 正值=迟到 */
        stat_update(late_us);
    }
    return NULL;
}
```

### 29.4 配置与生命周期

- `/etc/plc/plc.conf`：键值对（scan_ms=10、uio=generic-uio、modbus_port=502、web_port=8080）；启动解析，SIGHUP 重载；
- `/etc/plc/program.il`：用户程序文本（30章格式），校验失败则进入 FAULT 并保持安全输出；
- 信号处理：SIGTERM/SIGINT → 置 `g_running=0` → 各线程 join → DO 清零退出；
- SIGSEGV 由 systemd Restart=always 或 init 脚本兜底拉起（34章）。

### 常见问题 FAQ（避坑指南）
Q1：为什么禁止 scan 线程 printf？串口 115200 打一行 ≈ 数十毫秒 —— 直接摧毁 10ms 节拍。日志统一走无锁环形缓冲由 web/独立线程落盘；紧急故障用 log_write(LOG_FAULT) 也只是入队。

Q2：映像区要不要用双缓冲代替互斥？本项目数据量小（<1KB），mutex 开销纳秒级完全够。双缓冲适合大块高频场景（视频帧）。先选简单方案，有测量证据再优化 —— 过早优化的反面教材就在这。

Q3：TICK 计数器 32 位回绕怎么办？差值比较用无符号减法 `(uint32_t)(now - last)` 天然免疫回绕；判定阈值远小于 2³¹ 即安全。

**🧪 动手实验 L29-1：骨架先行**
实现 image/plcio/log/stat 四模块 + scan 线程（logic_execute 先用空函数占位）。验收：① 运行 30 分钟，Web 占位接口能报 scan_cnt≈180000±5、max_us<800；② kill -USR1 触发优雅退出且 DO 归零；③ 人为注释掉 plcio 心跳检查重编译，验证 FAULT 分支能触发安全输出。这个骨架将伴随你走完整个项目。

**📝 思考题**
- 若把解算逻辑放到 irq 辅助线程里做，会引入什么新问题？为什么坚持在 scan 线程做？
- 设计「在线改参数不停机」机制：哪些配置可以热更新？如何保证一致性？
- 对比你的映像区设计与 IEC 61131-3 的 RETAIN（掉电保持）语义，给出保留区的实现草案。

### 29.5 深潜：一次扫描抖动排查全程（方法论示范）★
把第51章的分析框架落到本项目：现象 → 证据链 → 根因 → 固化，全程可复现。

```
【现象】24h 老化中 P99 抖动 0.3ms 正常, 但每天 2~3 次孤立尖刺 4~8ms
【假设空间】① 内核抢占 ② THP/内存 ③ 日志IO阻塞 ④ NFS抖动 ⑤ 中断风暴
【证据1】尖刺时刻 dmesg 无异常; /proc/interrupts 平稳 → 排除⑤
【证据2】perf sched record 长跑抓到尖刺窗口:
        scan 线程最大调度延迟 6.1ms, 处于 D 状态(不可中断睡眠)!
【归因】D状态+时间规律性 → 日志线程 write() 落 NFS, 服务器偶发慢
        → 扫描线程虽不写盘, 但 img_lock 被「正在格式化日志的日志线程」
          长持锁? 复查: 日志线程持锁做 sprintf! 锁粒度错误实锤
【修复】
  ① 锁内只拷贝原始数据到本地缓冲, 格式化移出临界区
  ② 日志落盘改异步: 环形缓冲 + 独立 lowprio 线程批量写本地分区
     (弃 NFS 实时写; NFS 仅用于代码同步)
【复测】72h 零 >500μs 尖刺; 《优化报告》按 51.9 模板归档
/* 教训: "锁内不做慢操作"纪律(29章FAQ)不是背出来的, 是被这种案例教育出来的 */
```
#### 配套调试命令速记
```
perf sched record -p $(pidof plc_runtime) -- sleep 60 && perf sched latency --sort max
cat /proc/$(pidof plc_runtime)/status | grep -E 'voluntary|State'
watch -n1 'cat /sys/kernel/debug? /proc/vmstat | egrep "pgmigrate|compact"'
```

[← 上一篇第28章 Linux平台定制与UIO驱动](#ch28)
[下一篇 →第30章 梯形图解释器实现](#ch30)

---

## 第30章 梯形图解释器实现
项目的「灵魂」章节：让板卡真正执行用户逻辑 —— 触点、线圈、以及那条著名的启保停。

**🎯 学习目标**
- 理解 LD→IL 的编译链路与虚拟机执行模型
- 实现文本解析器 + 栈式求值的迷你运行时
- 跑通第一个真实 PLC 程序并在线修改验证

### 30.1 两级设计：LD →(编译)→ IL →(VM 执行)
直接解析图形化梯形图对 C 运行时太重。工业界经典做法是**中间语言**：PC 端工具把梯形图编译为指令表 IL，板上 VM 只需执行线性指令流 —— 复杂度被永久隔离在 PC 工具里。

```
# program.il —— 启保停（Start-Hold-Stop），分号后为注释
# 语法：OP OPERAND        （一行一条，空行分隔网络 Network）

; --- Network 1: 启保停 ---
LD   %IX0.0          ; 常开触点 Start(KEY0)
OR   %QX0.0          ; 并联自保持线圈反馈
ANDN %IX0.1          ; 串联常闭 Stop(KEY1)
OUT  %QX0.0          ; 输出线圈 → DO通道0

; --- Network 2: 运行指示 ---
LD   %QX0.0
OUT  %QX0.1          ; LED1 跟随
```

### 30.2 指令集与操作数编码

| 指令 | 语义 | 栈效果 

| `LD x / LDN x` | 装载触点状态（取反）作为新的左母线起点 | push(bit x) 

| `AND x / ANDN x` | 串联常开/常闭 | acc &= x 

| `OR x / ORN x` | 并联支路 | acc |= x 

| `OUT coil` | 线圈跟随当前 acc | coil = acc（不弹） 

| `SET / RST coil` | 置位/复位锁存线圈 | 条件写 

| 空行 | 网络边界：acc 清空、进入下一逻辑组 | clear 

```
/* operand 编码：高4位区域 + 低12位索引 */
typedef enum { AREA_IX = 1, AREA_QX, AREA_IW, AREA_MW } area_t;

typedef struct {
    uint8_t op;                 /* OP_LD..OP_RST */
    uint8_t neg;                /* 触点是否取反 */
    uint16_t area, idx;
} instr_t;

static instr_t prog[MAX_INSTR];
static int     prog_len;
```

### 30.3 解析器（容错是重点）
```
int logic_load(const char *path)
{
    FILE *fp = fopen(path, "r");
    if (!fp) return -1;
    char line[128]; int lineno = 0;
    while (fgets(line, sizeof line, fp)) {
        lineno++;
        char *h = strchr(line, ';'); if (h) *h = 0;      /* 掐掉注释 */
        /* 分词：OP OPERAND */
        char op[16], arg[32];
        if (sscanf(line, "%15s %31s", op, arg) != 2) continue;  /* 空行 */
        instr_t *in = &prog[prog_len];
        memset(in, 0, sizeof *in);

        if (!strcmp(op, "LD"))   in->op = OP_LD;
        else if (!strcmp(op, "AND")) in->op = OP_AND;
        else if (!strcmp(op, "OR"))  in->op = OP_OR;
        else if (!strcmp(op, "OUT")) in->op = OP_OUT;
        else if (!strcmp(op, "SET")) in->op = OP_SET;
        else if (!strcmp(op, "RST")) in->op = OP_RST;
        else return err(lineno, "unknown opcode");

        in->neg = (strchr(op, 'N') && in->op != OP_OUT &&
                   in->op != OP_SET && in->op != OP_RST);
        if (parse_operand(arg, &in->area, &in->idx))    /* %IX0.3 → (IX,3) */
            return err(lineno, "bad operand");
        if (++prog_len >= MAX_INSTR) return err(lineno, "too many");
    }
    fclose(fp);
    LOGI("program loaded: %d instructions", prog_len);
    return 0;
}
```

### 30.4 虚拟机执行引擎（每扫描周期跑一遍）
```
static inline int rd_bit(uint16_t area, uint16_t i)
{
    switch (area) {
    case AREA_IX: return (g_img.ix[i / 8] >> (i % 8)) & 1;
    case AREA_QX: return (g_img.qx[i / 8] >> (i % 8)) & 1;
    default:      return 0;
    }
}
static inline void wr_bit(uint16_t area, uint16_t i, int v)
{
    if (area == AREA_QX) {
        if (v) g_img.qx[i / 8] |=  (1 << (i % 8));
        else   g_img.qx[i / 8] &= ~(1 << (i % 8));
    }                                   /* MW 位访问扩展位 */
}

void logic_execute(void)                 /* 由 scan 线程调用，已持锁范围外 */
{
    img_lock();
    int acc = 0;
    for (int pc = 0; pc < prog_len; pc++) {
        instr_t *in = &prog[pc];
        int bit;
        switch (in->op) {
        case OP_LD:
            bit = rd_bit(in->area, in->idx);
            acc = in->neg ? !bit : bit;
            break;
        case OP_AND:
            bit = rd_bit(in->area, in->idx);
            acc = acc & (in->neg ? !bit : bit);
            break;
        case OP_OR:
            bit = rd_bit(in->area, in->idx);
            acc = acc | (in->neg ? !bit : bit);
            break;
        case OP_OUT: wr_bit(in->area, in->idx, acc); break;
        case OP_SET: if (acc) wr_bit(in->area, in->idx, 1); break;
        case OP_RST: if (acc) wr_bit(in->area, in->idx, 0); break;
        }
    }
    img_unlock();
}
```
💡 为什么这么快？
千条指令 × 单次访存 ≈ 微秒级 —— 相对 10ms 周期开销可忽略。真正的性能边界在锁竞争与 IO 寄存器往返，这也是架构上把解算放锁内一次完成的原因。

### 30.5 配套 PC 工具：LD→IL 编译器（Python）
```
# ld2il.py —— 把简单梯形图描述编译为 .il（教学级实现思路）
# 输入 JSON：{"networks":[{"series":["%IX0.0","NOT:%IX0.1"],
#                        "parallel":["%QX0.0"],"out":"%QX0.0"}]}
import json, sys

def emit(net):
    first_series = net["series"][0]
    print(f"LD   {first_series}")
    for op in net["series"][1:]:
        kw = "ANDN" if op.startswith("NOT:") else "AND"
        print(f"{kw:
进阶任务（选做）：用 graphviz 绘制梯形图渲染 HTML 报告，或接入 *Beremiz* 的 matiec 编译器输出 ST→C 对比学习。

### 常见问题 FAQ（避坑指南）
Q1：自保持不生效？检查 OUT 写的是否就是 OR 引用的同一线圈（%QX0.0），且**读回路径**存在：wr_bit 后下一周期 rd_bit 能读到。若 DO 被 Force 覆盖，映像区 qx 与实际输出会分叉 —— Force 属于 PL 层，调试期请关闭。

Q2：程序改了没生效？logic_load 只在上电执行。提供 SIGUSR2 → 重新 load + 校验失败回滚旧程序的机制；Web 页的「下载程序」按钮走同一通道。

Q3：非法操作数让运行时崩溃了？parse_operand 必须校验区域前缀与数值范围，越界直接拒绝加载进 FAULT 态 —— 用户输入永远不可信，这是工控软件的底线。

**🧪 动手实验 L30-1：启保停上线 ★M3**
① 加载 30.1 的 program.il；② 按 KEY0 → DO0/DO1 点亮，按 KEY1 → 熄灭；③ 用 Web 占位接口观察 %QX 变化时序；④ 故意加载含语法错误的程序验证 FAULT 回滚；⑤ 记录 M3 验收单。完成后你拥有一台「能编程的最小 PLC」。

**📝 思考题**
- 为什么 OUT 之后 acc 不清零？这允许什么样的书写习惯？与三菱/西门子行为一致吗？
- 若两个网络分别 OUT 同一线圈会怎样？工业规范如何处理双线圈问题？你的 VM 要不要报警？
- 评估把 IL 预编译成字节码缓存（跳过每次启动解析）的收益与复杂度。

### 30.6 深潜：ST（结构化文本）语言子集设计与编译路径
LD/IL 之外，**ST 是工业算法逻辑的主力语言**（类似 Pascal）。本节设计一个可落地的 ST 子集，让解释器直接执行 .st 程序 —— 完成这一步，你的 PLC 就具备主流编程形态。

#### ① 设计边界（先冻结范围）

| 能力 | 子集 v1 支持 | v2 规划(36章展望) 

| 类型 | BOOL / INT / DINT / REAL / TIME | + 数组、STRING、自定义结构 

| 变量 | VAR..END_VAR 全局映像映射(%IX/%QX/%MW) | + 局部变量、RETAIN 标注 

| 语句 | x:=expr; IF/ELSIF/ELSE; CASE; FOR; WHILE; RETURN | + REPEAT、EXIT、CONTINUE 

| 功能块 | TON / TOFF / TP / CTU / CTD 调用 | + 用户自定义FB实例化 

| 表达式 | + - * / MOD <> = <= >= AND OR XOR NOT () | + 移位、类型显式转换函数 

#### ② 文法骨架（EBNF 节选）——递归下降的直接蓝图
```
program      = { var_decl } { statement } ;
var_decl     = "VAR" ( ident ":" type [":=" expr] ";" )... "END_VAR" ;
statement    = assign | if_stmt | case_stmt | for_stmt | while_stmt
             | fb_call ";" | "RETURN" ";" ;
assign       = location ":=" expr ";" ;
if_stmt      = "IF" expr "THEN" { statement }
               { "ELSIF" expr "THEN" { statement } }
               [ "ELSE" { statement } ] "END_IF" ";" ;
case_stmt    = "CASE" expr "OF" { const_list ":" { statement } }
               [ "ELSE" { statement } ] "END_CASE" ";" ;
for_stmt     = "FOR" ident ":=" expr "TO" expr ["BY" const]
               "DO" { statement } "END_FOR" ";" ;
```

#### ③ 表达式求值：优先级表 + 双栈法（调度场）

| 优先级 | 运算符 | 结合性 

| 1(高) | () 函数调用 | - 

| 2 | 一元 - NOT | 右 

| 3 | * / MOD | 左 

| 4 | + - | 左 

| 5 | < > <= >= | 左 

| 6 | = <> | 左 

| 7(低) | AND XOR | 左 

| 8 | OR | 左 

```
/* 求值器骨架: 词法(token流)→递归下降解析→AST 或直接双栈求值 */
typedef enum { T_NUM,T_ID,T_OP,T_LP,T_RP } tk_t;
static int expr_eval(const char **s);        /* 返回int简化版 */

/* 生产级建议: 解析成AST一次(启动时), 每扫描周期walk AST求值;
   性能敏感则把AST编译为IL指令流 —— 与现有VM零改动融合! */
```

#### ④ ST → IL 编译映射表（复用第30.2 VM 的关键设计）

| ST 结构 | 生成的 IL 形态 | 说明 

| `a := b AND c;` | LD b / AND c / ST a? → 用 MW 中转: LD b,AND c,OUT %MWk | 布尔表达式天然映射能流 

| IF c THEN A ELSE B END_IF | JMPC label_else … JMP end / label_else: B… / end: | VM 需补 JMPC/JMP/LBL 三条跳转指令 ★ 

| CASE x OF 1:A 2:B ELSE C | 连续比较跳转链(或跳转表优化) | v1 用比较链足够 

| FOR i:=1 TO n DO | i:=初值; LBL loop / 条件判断 JMPC end / 循环体 / i+=步长 / JMP loop | 循环变量放 MW 槽 

| TON#t(IN:=x, PT:=T#2s) | LD x / TON slot,2000 / 存Q到目标 | 直接复用31章功能块指令! 

这个设计的精妙之处：**ST 编译器的输出就是现有 IL** —— VM 一行不改，只新增 PC 端 st2il 编译器；或者板上直接内置微型 ST 解释器（AST walk），两条路线代码量均在 800~1500 行。

#### ⑤ 端到端示例：电机启停 + 过载联锁（ST 源码）
```
PROGRAM Main
VAR
    start  : BOOL;  stop : BOOL;  overload : BOOL;
    motor  : BOOL;  fault_latch : BOOL;
    t_ol   : TIME;                          (* 过载确认延时 *)
END_VAR

    start := %IX0.0;  stop := %IX0.1;  overload := (%IW0 > 9000);

    IF overload THEN
        t_on? ton_ol(IN := TRUE, PT := T#500MS);
        IF ton_ol.Q THEN fault_latch := TRUE; END_IF;
    ELSE
        ton_ol(IN := FALSE, PT := T#500MS);
    END_IF;

    IF fault_latch THEN
        motor := FALSE;
    ELSIF stop THEN
        motor := FALSE;
    ELSIF start OR motor THEN
        motor := TRUE;
    END_IF;

    %QX0.0 := motor AND NOT fault_latch;
END_PROGRAM
```
验收标准：① 该程序经你的编译器/解释器在板上运行，行为与手写 IL 版一致；② 故意注入语法错误（漏 END_IF），报错行号准确；③ 扫描周期增量 ≤1ms（100 条语句量级）。

### 30.7 深潜：两种实现路线对比与推荐

| 路线 | 板上 ST 解释器(AST walk) | PC 端 st2il 编译器 

| 开发量 | ~1500 行 C(词法+解析+AST+求值) | ~1200 行 Python(复用 ld2il 基建) 

| 运行开销 | 每周期遍历 AST(慢 3~5×) | 板上仍跑线性 IL(最快)★ 

| 错误报告 | 运行期才发现部分错误 | 下载前全静态检查 ★ 

| 学习收获 | 解析器/求值器原理 | 编译器后端思想 

| 建议 | 主线走 **st2il 编译路线**(与 IEC 工具形态一致)；AST 解释器作为选修加深理解。两者共用同一文法定义保证语义等价 —— 对拍测试即最佳验证。 

[← 上一篇第29章 软PLC运行时内核设计](#ch29)
[下一篇 →第31章 功能块：定时器与计数器](#ch31)

---

## 第31章 功能块：定时器与计数器
没有定时器的 PLC 只能做组合逻辑。本章补齐 TON/TOFF/TP 与 CTU/CTD —— 工业逻辑的最后拼图。

**🎯 学习目标**
- 精确掌握 IEC 61131-3 三种定时器与两种计数器语义
- 在运行时中实现功能块实例与 MW 状态槽
- 用星三角启动程序完成综合验证 ★M4

### 31.1 TON 通电延时定时器（最高频）

IN
Q
- 

PT=2s 后 Q=1
IN↓ → Q 立即复位，ET 清零
ET

t
ET 爬升到 PT

图31-1 TON 时序：IN 保持 ≥PT 才输出，断开立即复位

| 类型 | 触发→动作 | 典型用途 

| **TON** | IN 为真持续 ET≥PT → Q=1；IN 假则立即 Q=0、ET=0 | 延时启动、消抖、星三角切换 

| **TOFF** | IN 真 → Q 立即 1；IN 变假后保持 PT 再关 | 风机停机延时、灯光保持 

| **TP** | IN 上升沿触发固定宽度 PT 的单脉冲（期间再触发无效） | 阀门冲刷、报警闪烁节拍 

### 31.2 实例模型：MW 槽位即状态机
每个定时器实例占用 `%MW` 区连续 4 字：`{state, ET_ms, PT_ms, reserved}`。IL 里这样使用：

```
; --- Network 1: 按下 Start 延时 2s 启动 ---
LD   %IX0.0
ANDN %MW20          ; TON1 的 Q 反馈存在 MW20.state 位? —— 见下方简化
; 实际采用扩展指令直接驱动功能块：
LD   %IX0.0
TON  1 , 2000       ; 实例#1, PT=2000ms（状态自动存于 MW 槽 #1）
OUTB %MW21          ; 把 TON1.Q 装入 %MW21 作为可读中间变量
LD   %MW21
OUT  %QX0.2
```
📌 设计取舍说明
完整 IEC 需要功能块实例数据库与 ST 语言。教学版取折中：**TON n, pt_ms** 指令 + 固定槽表，语义完整但零配置。第36章展望中说明升级到 matiec 编译 ST 的路径。

### 31.3 运行时实现（每周期先于梯形图执行）
```
typedef struct { uint8_t q; int16_t et, pt, pad; } ton_t;
static ton_t tons[MAX_TONS];            /* 槽表，映射到 MW 高段 */

void fb_tick_10ms(void)                  /* scan 循环②之前调用 */
{
    /* ① 先执行本周期挂起的 TON 指令输入条件已在 VM 中记录 */
    for (int i = 0; i < MAX_TONS; i++) {
        ton_t *t = &tons[i];
        if (!t->active) continue;
        if (t->in) {
            if (t->et < t->pt)
                t->et += g_cfg.scan_ms;
            t->q = (t->et >= t->pt);
        } else {
            t->q = 0; t->et = 0;
        }
        t->active = 0;                   /* 本轮消费完毕 */
    }
}

/* VM 中 TON 指令的处理分支 */
case OP_TON:
    tons[in->idx].in     = acc;          /* 左母线能流即 IN */
    tons[in->idx].pt     = in->ext;      /* PT 编码在指令立即数 */
    tons[in->idx].active = 1;
    acc = tons[in->idx].q;               /* 输出回填能流，可 OUT */
    break;
```

| 计数器 | 输入 | 输出 | 语义 

| **CTU 加计数** | CU上升沿 / R / PV | Q / CV | CV 到 PV 时 Q=1；R 优先清零 

| **CTD 减计数** | CD上升沿 / LD / PV | Q / CV | CV≤0 时 Q=1 

```
case OP_CTU:
    cu = acc && !tons_ctu_prev[in->idx];       /* 检测 CU 上升沿 */
    tons_ctu_prev[in->idx] = acc;
    if (g_img.mw[in->ext])                      /* R 操作数由 MW 提供 */
        ctu[i].cv = 0;
    else if (cu)
        ctu[i].cv++;
    ctu[i].q = (ctu[i].cv >= ctu[i].pv);
    acc = ctu[i].q;
    break;
```

### 31.4 综合案例：星三角降压启动 ★
```
# program_star_delta.il
# IO分配: KEY0=启动 %IX0.0 | KEY1=停止 %IX0.1
#         DO0=主接触器KM1 | DO1=星形KM_Y | DO2=三角形KM_D | DO3=运行灯

; N1: 运行锁存（启保停骨架）
LD %IX0.0
OR %QX0.0
ANDN %IX0.1
OUT %QX0.0                       ; KM1 主接触器

; N2: 星形接法 —— 启动瞬间投入，5s 后退出
LD %QX0.0
ANDN %MW22                       ; TON2.Q (三角定时) 取反 = 未到切换时间
ANDN %QX0.2                      ; 与三角形互锁（硬互锁双保险）
OUT %QX0.1

; N3: 切换定时 5s
LD %QX0.0
TON  2 , 5000
OUTB %MW22

; N4: 三角形接法 —— 定时到且已断星形
LD %MW22
ANDN %QX0.1
OUT %QX0.2

; N5: 运行指示
LD %QX0.0
OUT %QX0.3
```
🚨 接触器互锁是安全底线
真实星三角必须**软硬双重互锁**：软件 ANDN 对方输出之外，硬件上把两接触器常闭辅助触点串入对方线圈回路。任何 PLC 教学都不允许跳过这条铁律。

### 常见问题 FAQ（避坑指南）
Q1：TON 时间不准，5s 实测 6s？ET 以扫描次数×scan_ms 累计 —— 若实际周期漂移（29章统计），时间随之漂移。修正路径：① 用 PL TICK 差值校准；② 高要求场景把定时基准改为硬件定时器中断计数。

Q2：CTU 一按键盘数字狂跳？CU 没做上升沿检测，长按被多次采样。务必保留 prev 态比较；DI 层的去抖只滤物理抖动，不替代沿检测。

Q3：重启后定时器状态残留？槽表未初始化。冷启动 memset 全部功能块槽并写默认 PV；需要 RETAIN 语义的槽单独登记（26章思考题的落地机会）。

**🧪 动手实验 L31-1：交通灯控制器**
东西/南北两组红黄绿（DO0~DO5），周期 12s：绿8s→黄2s→红10s 交替。只用 TON 实现状态机（建议 3 个级联 TON）。验收：示波器双通道测相邻相位切换误差 ≤10ms；Web 页显示当前状态号与各 ET 值。完成后 M4 达成 —— 你的 PLC 已具备解决真实工程问题的能力。

**📝 思考题**
TP 在脉冲期间再次收到上升沿为什么必须忽略？如果重触发会破坏什么应用？
- 对比「10ms 累计」与「读系统绝对时间差」两种 ET 实现，各自的精度上限由什么决定？
- 为 CTU 增加「掉电保持」：哪些数据要保存？何时写入持久介质才不影响实时性？

[← 上一篇第30章 梯形图解释器实现](#ch30)
[下一篇 →第32章 Modbus TCP/RTU从站实现](#ch32)

---

## 第32章 Modbus TCP / RTU 从站实现
M5 里程碑：让 SCADA、组态王、Python 脚本都能读写你的 PLC —— 工业互联互通的第一步。

**🎯 学习目标**
- 掌握 Modbus 帧结构与功能码语义
- 实现并发安全的 TCP 从站（502 端口）与 RTU 从站
- 建立映像区 ↔ Modbus 地址的完整映射并回归测试

### 32.1 协议速览与地址映射合同

| 功能码 | 名称 | 映射目标 | 访问 

| FC01/02 | 读线圈/离散输入 | %QX0.x（0..127）/ %IX0.x | R 

| FC05/15 | 写单/多线圈 | %QX —— 仅写入「上位机强制位」，逻辑仍可覆盖* | R/W 

| FC03/06/16 | 读/写保持寄存器 | %MW0..255 | R/W 

| FC04 | 读输入寄存器 | %IW0..63（AI工程量等） | R 

* 设计决策：DO 的 Modbus 写入进入 `remote_force[]` 掩码，由用户程序决定是否采纳（例如配合 DO_FORCE_EN 通道）—— 避免远程误写直接驱动现场设备。

### 32.2 TCP 从站核心代码
```
/* modbus_tcp.c —— 单文件从站（每连接一线程模型） */
void *tcp_worker(void *cfd_p)
{
    int fd = (int)(intptr_t)cfd_p;
    uint8_t req[260], rsp[260];

    for (;;) {
        /* ① MBAP 头 7 字节：TxID(2) ProtoID(2) Len(2) UnitID(1) */
        if (readn(fd, req, 7) != 7) break;
        uint16_t txid = req[0] << 8 | req[1];
        uint16_t len  = req[4] << 8 | req[5];
        if (len < 2 || len > sizeof(req) - 6) break;   /* 合法性闸门 */
        if (readn(fd, req + 7, len - 1) != len - 1) break;

        /* ② PDU = Function Code(1) + Data */
        int rlen = mb_process(req + 7, len - 1, rsp + 7);/* 统一入口 */
        if (rlen < 0) {                                  /* 异常响应 */
            rsp[7] = req[7] | 0x80;
            rsp[8] = (uint8_t)-rlen;                     /* 异常码 */
            rlen = 2;
        }
        /* ③ 回包：复用 TxID */
        uint16_t rl = rlen + 1;
        rsp[0] = txid >> 8; rsp[1] = txid & 0xFF;
        rsp[2] = 0;      rsp[3] = 0;                 /* Protocol ID */
        rsp[4] = rl >> 8; rsp[5] = rl & 0xFF;
        rsp[6] = req[6];                              /* UnitID 原样 */
        writen(fd, rsp, 6 + rl);
    }
    close(fd);
    return NULL;
}

/* 监听循环 */
void *modbus_tcp_server(void *arg)
{
    int srv = tcp_listen(g_cfg.mb_port);              /* 20章骨架复用 */
    for (;;) {
        int c = accept(srv, NULL, NULL);
        pthread_t th;
        pthread_create(&th, NULL, tcp_worker,
                       (void*)(intptr_t)c);
        pthread_detach(th);
    }
}
```

### 32.3 FC 分发器：一切经映像区
```
int mb_process(const uint8_t *pdu, int plen, uint8_t *out)
{
    uint8_t fc = pdu[0];
    uint16_t addr = pdu[1] << 8 | pdu[2];
    uint16_t cnt  = pdu[3] << 8 | pdu[4];

    switch (fc) {
    case 3: {                                   /* 读保持寄存器 %MW */
        if (cnt > 125 || addr + cnt > 256) return -2;   /* Illegal Data Addr */
        img_lock();
        out[1] = cnt * 2;
        for (int i = 0; i < cnt; i++) {
            out[2 + 2*i] = g_img.mw[addr+i] >> 8;
            out[3 + 2*i] = g_img.mw[addr+i] & 0xFF;
        }
        img_unlock();
        return 2 + cnt * 2;
    }
    case 6: {                                   /* 写单寄存器 */
        uint16_t v = pdu[4] << 8 | pdu[5];
        if (addr >= 256) return -2;
        img_lock(); g_img.mw[addr] = v; img_unlock();
        memcpy(out, pdu, 5);                    /* 原样回显 */
        return 5;
    }
    case 1: case 2: case 5: case 15: case 4:
        return fc_bit_or_input(pdu, plen, out); /* 同构实现，留作 L32-1 */
    default:
        return -1;                              /* Illegal Function */
    }
}
```

### 32.4 RTU 从站要点

- **帧结构**：`SlaveAddr(1) + PDU + CRC16(lo,hi)`，无 MBAP；
- **帧定界**：依赖 ≥3.5 字符时间的静默间隔（115200 下约 330μs）。实现：termios VTIME 短读 + 超时判定帧尾；
- **CRC16-MODBUS**（多项式 0xA001 反射），查表法：

```
static uint16_t crc16(const uint8_t *d, int n)
{
    uint16_t crc = 0xFFFF;
    while (n--) {
        crc ^= *d++;
        for (int i = 0; i < 8; i++)
            crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
    return crc;                                  /* 低字节先发！*/
}
/* 主循环：read 到首字节后，循环 read 直到超时无新数据 → 校验 CRC →
   地址匹配则 mb_process() → 应答前按 RS485 方向控制切发送(DE/RE 引脚) */
```

### 32.5 测试矩阵（M5 验收）
```
# Ubuntu 主机侧用 mbpoll（apt install mbpoll）
mbpoll -m tcp -a 1 -t 3 -r 0 -c 4 192.168.2.30          # 读 MW0..3
mbpoll -m tcp -a 1 -t 4 -r 100 192.168.2.30 12345       # 写 MW100
# Python 快速验证：
pip install pymodbus
python3 -c "
from pymodbus.client import ModbusTcpClient
c=ModbusTcpClient('192.168.2.30'); c.connect()
print(c.read_holding_registers(0,4,slave=1).registers)
c.write_register(100,777,slave=1)
print(c.read_holding_registers(100,1,slave=1).registers)"
# Web 页同步观察 MW 变化 → 三端一致性 ✓
```

### 常见问题 FAQ（避坑指南）
Q1：TCP 能连上但读数全 0？UnitID 不匹配（很多主站默认发 255 或 1）；或读了 %MW 但你的梯形图只写 %QX。先用 plcio_test 在板侧确认数据源非空，再查映射偏移。

Q2：RTU 无应答？排查链：示波器看 A/B 差分有无波形 → CRC 计算是否低字节在前 → 波特率/校验位一致 → RS485 收发方向脚切换时序（应答前切 TX）。四个点覆盖 99% 故障。

Q3：多主站同时写一个寄存器会怎样？img_lock 保证原子性，但业务语义上「最后写入者胜」。工业惯例是只读区/可写区分离 + 关键参数加影子确认（写后回读比对），必要时扩展双字时间戳。

**🧪 动手实验 L32-1：补全 FC 并自动化回归**
① 实现 FC1/2/5/15/4 五个分支（位操作注意字节内序）；② 编写 Python pytest 脚本覆盖：合法读写、越界地址返回异常码 02、非法功能码返回 01、并发 10 客户端压测 5 分钟无掉线；③ 全部通过后 M5 达成。把测试脚本纳入 Git —— 这就是你的第一个工控软件 CI。

**📝 思考题**
- Modbus 是「无状态」协议吗？从你的实现角度说明事务 ID 的作用与局限。
- 为什么 FC15 写多线圈要逐位打包而不是整字节拷贝？写出你处理 LSB-first 的代码。
- 若上级要求支持 Modbus TCP 网关转发 RTU 设备，架构如何演进？（提示：网关模式与地址空间路由）

### 32.6 深潜：libmodbus 交叉编译与协议级联调
#### ① libmodbus 移植（对照自研栈的工程价值）
```
# 交叉编译三步(源码 ~3万行, 成熟稳定)
./configure --host=arm-xilinx-linux-gnueabi? --prefix=$PWD/out \
            ac_cv_func_malloc_0_nonnull=yes      # 规避交叉检测误判
make -j && make install
# 运行时替换: 把 32章自研从站换成 libmodbus 的 modbus_new_tcp+map 模式,
# 对外接口不变 —— 双实现 A/B 对拍是发现协议细节差异的最佳手段。
```
#### ② 一致性回归矩阵（自动化）

| 用例族 | 覆盖点 | 工具 

| 功能码全量 | FC1/2/3/4/5/6/15/16 正常路径 + 各自异常码 | pymodbus 脚本化断言 

| 边界 | 数量上限125/地址0xFFFF/跨区读 | 期望精确异常码02/03 

| 鲁棒 | 坏CRC(RTU)/短包/半包/TxID错配 | raw socket 发畸形帧 

| 并发 | 16客户端混合读写5分钟无错无死锁 | pytest-xdist 并行 

| 时序 | 请求间隔1ms~1s扫描 RTT 分布 | 统计进《性能基线报告》 

#### ③ 帧级调试三板斧

- **Wireshark 过滤链**：`modbus && tcp.srcport!=502` 只看主站请求；右键「Follow TCP Stream」还原完整事务对；
- **栈内 hexdump 钩子**：收发函数入口打印 `[TX] 9c4b00000006010...` 带序号——与抓包逐帧对账，快速判定问题在协议栈还是网络；
- **UnitID/字节序错位速判表**：响应全 0→查 UnitID 与映射偏移；数值离奇巨大→字节序或缩放系数错；偶发 CRC 错(RTU)→示波器看波形质量而非先怀疑代码。

[← 上一篇第31章 功能块：定时器与计数器](#ch31)
[下一篇 →第33章 Web监控界面](#ch33)

---

## 第33章 Web 监控界面
给 PLC 装上「仪表盘」：浏览器里看 IO、改参数、下载程序 —— 零客户端依赖的现代工控体验。

**🎯 学习目标**
- 在运行时内嵌轻量 HTTP 服务与 JSON API
- 编写自动刷新的单页监控界面
- 理解工控 Web 服务的安全边界

### 33.1 架构决策

| 方案 | 优点 | 结论 

| 外挂 lighttpd + CGI | 功能全 | 进程间共享映像区复杂（需 IPC） 

| **运行时内嵌 HTTP 线程 ★** | 直接读映像区、零依赖、代码量 ~300 行 | 本项目采用 

| WebSocket 推送 | 实时性最佳 | 作为拓展任务（L33-2） 

### 33.2 API 设计合同

| 方法/路径 | 功能 | 响应示例 

| GET /api/status | 全量状态快照 | `{"run":true,"di":[1,0,..],"do":[..],"ai":[4096,2048],"scan":{"avg":9.98,"max":11.2,"cnt":183000}}` 

| POST /api/control | 启动/停止 `{cmd:"start|stop"}` | `{"ok":true}` 

| POST /api/force | DO强制 `{ch:3,val:1,on:true}` | `{"ok":true}` 

| POST /api/program | 上传IL文本 → 校验 → 热替换 | `{"ok":false,"line":12,"err":"bad operand"}` 

| GET / | 监控页面(index.html 内嵌) | - 

```
/* web.c —— 路由分发骨架 */
void *web_thread(void *arg)
{
    int srv = tcp_listen(g_cfg.web_port);
    for (;;) {
        int c = accept(srv, NULL, NULL);
        char req[1024];
        read_http_request(c, req, sizeof req);       /* 读到 \r\n\r\n */
        if (strstr(req, "GET /api/status"))
            api_status(c);                           /* 拼 JSON 发送 */
        else if (strstr(req, "POST /api/control"))
            api_control(c, req);
        else if (strstr(req, "POST /api/force"))
            api_force(c, req);
        else if (strstr(req, "POST /api/program"))
            api_program(c, req);
        else
            send_static(c, req);                     /* 页面/404 */
        close(c);                                    /* 短连接，够用 */
    }
}

void api_status(int c)
{
    char buf[2048], *p = buf;
    p += sprintf(p, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{");
    img_lock();
    p += json_di_do(p);                              /* 数组拼接 */
    p += sprintf(p, ",\"ai\":[%d,%d]", g_img.iw[0], g_img.iw[1]);
    img_unlock();
    stat_lock();
    p += sprintf(p, ",\"scan\":{\"avg\":%.2f,\"max\":%.2f,\"cnt\":%u}}",
                 st.avg_us / 1000.0, st.max_us / 1000.0, st.cnt);
    writen(c, buf, strlen(buf));
}
```

### 33.3 监控页面 index.html（核心 JS 节选）
```
<!-- 单文件内嵌进 C 字符串或从 /etc/plc/www 读取 -->
<table id="io"></table>
<script>
async function refresh() {
  const s = await (await fetch('/api/status')).json();
  let h = '<tr><th>通道</th>' +
          Array.from({length:8},(_,i)=>'<th>'+i+'</th>').join('')+'</tr>';
  h += '<tr><td>DI</td>' + s.di.map(v=>
        `<td style="background:${v?'#7ee787':'none'}">${v}</td>`).join('');
  h += '<tr><td>DO</td>' + s.do.map((v,i)=>
        `<td onclick="force(${i},${v?0:1})" style="cursor:pointer">${v}</td>`).join('');
  document.getElementById('io').innerHTML = h;
  scan.textContent = `扫描 ${s.scan.avg} ms (max ${s.scan.max}) · ${s.scan.cnt} 次`;
}
async function force(ch, val) {
  await fetch('/api/force', {method:'POST',
      body: JSON.stringify({ch, val, on:true})});
}
setInterval(refresh, 1000);   /* 1Hz 轮询：对 10ms 扫描零干扰 */
</script>
```
效果：LED 表格点击即强制、AI 数值实时刷新、扫描统计一目了然。所有写操作走「映像区锁」串行化 —— 与 Modbus 共享同一真源。

⚠️ 工控 Web 安全红线
本课程为教学简化：**无认证、明文 HTTP、仅限实验局域网**。产品化必须补齐：HTTPS(TLS)、登录会话、操作审计日志、写操作二次确认、与办公网隔离。把这份清单写进你的项目 README 的 Known Limitations —— 面试时这是加分项。

### 常见问题 FAQ（避坑指南）
Q1：页面数据不刷新？F12 看 Network：① 请求被浏览器缓存（响应加 Cache-Control: no-store）；② JSON 拼接语法错误导致 fetch 解析失败 —— 用控制台看原始响应排查。

Q2：频繁刷新后板子变卡？短连接 TIME_WAIT 堆积 + accept 风暴。限流：每 IP 并发≤2、刷新间隔≥500ms 校验；或升级长轮询/WebSocket（拓展任务）。

Q3：上传程序接口被恶意大文件撑爆内存？读 body 时硬性限制 Content-Length ≤64KB，超限直接断开并记录审计日志。所有对外输入都过闸门 —— 与 mb_process 的长度检查同一纪律。

**🧪 动手实验 L33-1：仪表盘完工**
① 实现 status/control/force/program 四个 API 全部联调；② 页面增加「程序编辑器」textarea：加载当前 IL、修改提交、错误行高亮显示返回的 err 信息；③ 用两个浏览器窗口同时操作验证并发一致性。完成后你的 PLC 已具备完整的人机交互闭环。

**📝 思考题**
- 为什么 api_status 里要持 img_lock？如果只读单个 uint32 是否可以不加锁？（提示：撕裂读）
- 对比轮询与 WebSocket 在 10 台客户端同时监控时的服务器负载模型。
- 设计「操作权限分级」：观察员/操作员/工程师三级，各自可用的 API 子集如何裁剪？

[← 上一篇第32章 Modbus TCP/RTU从站实现](#ch32)
[下一篇 →第34章 系统集成与开机自启](#ch34)

---

## 第34章 系统集成与开机自启
从「开发板上的程序」到「上电即用的设备」：自启、看门狗、版本化与升级通道。

**🎯 学习目标**
- 完成 PLC 服务的 sysvinit 自启与崩溃自愈
- 落地三级看门狗防线
- 掌握 QSPI 产品化固化与升级包制作

### 34.1 交付物清单（Release Checklist）
```
release_v1.0/
├── BOOT.BIN                 # fsbl + plc_io_engine.bit + u-boot（QSPI 固化）
├── image.ub                 # kernel+dtb（含 generic-uio 节点）
├── rootfs.tar.gz            # 含 /usr/bin/plc_runtime + gdbserver 移除版
└── etc_plc/
    ├── plc.conf             # 生产配置（端口/周期/安全输出策略）
    ├── program.il           # 出厂逻辑（如星三角模板）
    └── www/index.html       # 监控页面
```

### 34.2 开机自启与崩溃自愈
```
#!/bin/sh
# /etc/init.d/S99plc —— PetaLinux 配方安装（16.5 方法）
DAEMON=/usr/bin/plc_runtime
PIDF=/var/run/plc.pid
case "$1" in
  start)
    # 确保依赖就绪：uio 节点存在才启动
    [ -d /sys/class/uio/uio0 ] || { echo "uio0 missing"; exit 1; }
    start-stop-daemon -S -b -m -p $PIDF -x $DAEMON -- \
        -c /etc/plc/plc.conf -p /etc/plc/program.il
    ;;
  stop)    start-stop-daemon -K -p $PIDF ;;
  restart) $0 stop; sleep 1; $0 start ;;
  *) echo "Usage: $0 {start|stop|restart}"; exit 1 ;;
esac
```
```
#!/bin/sh
# /etc/init.d/S98plcguard —— 简易守护：崩溃 3 次内自动拉起
MAX=3; N=0
while true; do
    if ! [ -f /var/run/plc.pid ] || ! kill -0 $(cat /var/run/plc.pid) 2>/dev/null; then
        N=$((N+1))
        [ $N -gt $MAX ] && { logger "plc crash-loop, give up"; break; }
        logger "plc down, restarting ($N/$MAX)"
        /etc/init.d/S99plc start
    fi
    sleep 5
done &
```

### 34.3 三级看门狗防线（R9 需求）

| 级别 | 机制 | 响应时间 

| L1 线程自检 | scan 循环内检测自身 late_us 连续超限 → 记日志并自恢复（重同步 next） | 1 周期内 

| L2 进程级 | plcguard 守护 + systemd 等价 Restart=always | ~5s 

| L3 硬件级 | PS 硬件看门狗 /dev/watchdog + PL 心跳联合喂狗：仅当「进程活着且 PL TICK 在走」才喂 | ~10s 强制复位 

```
/* L3 喂狗逻辑（独立 watchdog 线程，5s 周期）*/
int wdt = open("/dev/watchdog", O_WRONLY);
write(wdt, "1", 1);                       /* 启动，默认超时由设备树配置 */
for (;;) {
    sleep(5);
    uint32_t tk = plcio_rd(REG_TICK);
    if (g_running && tk != g_last_tick && st.fault == 0)
        write(wdt, "w", 1);               /* 双条件满足才喂 */
    g_last_tick = tk;
    /* 不喂 → 硬件复位 → BOOT.BIN 重新走完整启动链（约 15s）*/
}
```

### 34.4 版本化与 QSPI 固化

- 构建脚本注入版本：C 宏 `BUILD_TS/__DATE__` + bitstream 的 ID 寄存器高位编版本 → Web 页与 `/api/status` 一并上报，现场对版一目了然；
- QSPI 固化（13.6 流程）：BOOT.BIN 写 0x0；image.ub 与 rootfs 仍留 SD/eMMC（QSPI 32MB 放不下完整 rootfs，属正常工程取舍）；
- 升级包 = `tar czf plc_update.tgz BOOT.BIN image.ub etc_plc/ install.sh`；U 盘插入后 install.sh 校验 md5 → 备份旧版 → 替换 → 重启。OTA 双分区方案作为 36 章展望。

### 常见问题 FAQ（避坑指南）
Q1：自启脚本执行了但进程不在？① rcS 阶段 uio 尚未就绪 —— S99 序号保证晚于驱动加载，仍失败则脚本内加 udevadm settle 或重试；② start-stop-daemon -b 后台化时 stdout 丢失，日志务必走 syslog/文件；③ 工作目录假设错误 —— 一律用绝对路径。

Q2：看门狗把正常运行的系统复位了？喂狗条件写得太严（如 PL TICK 判定窗口过短）或 wdt 超时小于喂狗周期。先 `cat /proc/sys/kernel/watchdog? 用 /sys/class/watchdog/watchdog0/timeout` 核对，留 2 倍裕量。

Q3：升级中途断电变砖？单分区覆盖式升级的固有风险。缓解：A/B 分区 + uboot 启动计数回退（13章思考题方案），或至少保证 BOOT.BIN 原子写入（先写临时偏移再改启动指针超出 QSPI 简单方案能力，需 eMMC 方案）。

**🧪 动手实验 L34-1：整机交付演练**
① 制作 release_v1.0 目录并烧写 QSPI+SD；② 断电重启验证：60 秒内 Web 可访问、Modbus 可读；③ 依次模拟三级故障（kill 运行时 / 停止喂狗线程 / 拔网线）观察自愈行为并记录时间线；④ 制作升级包在另一台「客户板」上完成升级演练。通过后进入最终验收章。

**📝 思考题**
- 为什么 L3 喂狗要同时检查进程存活与 PL 心跳？只查其一分别漏掉什么故障？
- 设计「安全输出默认值」配置：RUN 停止/FAULT/断电恢复三种场景下各通道的期望状态表。
- 若客户要求 7×24 连续运行 MTBF>1 年，你会增加哪些测试项来逼近验证？

[← 上一篇第33章 Web监控界面](#ch33)
[下一篇 →第35章 综合案例与验收测试](#ch35)

---

## 第35章 综合案例与验收测试
用工程化的方式宣布胜利：需求追踪矩阵 + 可复现测试用例 + 性能实测报告。

**🎯 学习目标**
- 建立需求→用例→证据的完整追溯链
- 量化验证全部性能指标（R6 等）
- 产出规范的《项目验收报告》

### 35.1 需求追踪矩阵（节选）

| 需求 | 用例组 | 方法/仪器 | 通过判据 

| R1 DI | V-DI-01..04 | 信号发生器/按键 + Web 观察 + ILA | 10ms±20% 去抖；事件零丢失 

| R2 DO+Force | V-DO-01..03 | 万用表/LED + Modbus 写 | Force 即时生效；解除后逻辑恢复 

| R3 AI | V-AI-01..02 | 电位器 5 点标定 vs 万用表 | 线性误差 ≤2% FS 

| R4 PWM | V-PWM-01..03 | 示波器测频宽 | 100Hz~10kHz ±0.5%；占空比线性 

| R5 逻辑 | V-LD 三案例 | 标准程序行为比对 | 启保停/星三角/交通灯全过 

| R6 扫描 | V-RT-01 | 30min 连续运行统计 | avg≤10ms 抖动 max<11ms 

| R7 Modbus | V-MB 自动化 | pymodbus pytest 32章脚本 | 全部断言绿；异常码正确 

| R8 Web | V-WB 手册 | 双浏览器并发操作 | 状态一致；错误输入有提示 

| R9 可靠性 | V-SR 故障注入 | kill -9 / 断网 / 断电循环 ×50 | 自愈成功率 100% 

### 35.2 关键性能实测方法
#### ① 扫描周期抖动（V-RT-01）
```
# 板上后台采集 30 分钟：
plcio_test loop 180000 > scan_stat.log
# 统计列：avg/max/min/p99 —— 期望 avg≈10.00ms, max<11ms
# 同时 Web 页曲线确认无趋势性劣化（内存泄漏的旁证）
```
#### ② DI 端到端响应延迟
示波器 CH1 接按键物理引脚，CH2 接对应 DO 输出；逻辑里做「DI 直通 DO」测试程序。测量**按键沿→输出沿**总延迟 = PL 去抖(10ms) + 扫描采样等待(0~10ms) + 解算 + 输出。理论最大 ≈21ms，实测应落在 15~21ms 区间且分布可解释。

#### ③ Modbus 吞吐
```
import time, statistics
from pymodbus.client import ModbusTcpClient
c = ModbusTcpClient('192.168.2.30'); c.connect()
lat = []
for _ in range(1000):
    t0 = time.perf_counter()
    c.read_holding_registers(0, 8, slave=1)
    lat.append((time.perf_counter()-t0)*1000)
print(f"avg={statistics.mean(lat):.2f}ms p95={sorted(lat)[950]:.2f}ms")
# 参考值：百兆内网 avg 1~3ms —— 足够 SCADA 500ms 轮询场景
```

### 35.3 综合演示场景：「微型灌装产线」
把所有 IO 编成一个故事，作为答辩演示脚本：

- **上电自检**：Web 显示版本/自检绿灯（34章）；
- **启动条件**：安全门 %IX0.6 闭合 + 启动按钮 %IX0.0（启保停骨架）；
- **灌装节拍**：TP 触发阀门 DO0 冲刷 300ms（31章 TP）；
- **计数剔除**：CTU 统计瓶数，每满 10 个 TON 500ms 停带提醒（功能块组合）；
- **温度联锁**：%IW0 > 阈值(%MW50 由 Modbus 下发) → 强制停机 + 蜂鸣 PWM（AI 联动）；
- **远程监控**：SCADA(mbpoll) 与 Web 双端同步观察全流程；
- **故障演练**：现场 kill 运行时 → 5s 自愈 → 产线自动恢复待机态（R9 实证）。

### 35.4 验收报告模板
```
ZYNQ7020 软 PLC 项目验收报告 v1.0
1. 交付物清单（对照 34.1，含 md5）
2. 环境说明：板卡批次/Vivado 版本/构建时间戳
3. 需求追踪矩阵：逐项 PASS/FAIL + 证据链接（截图/log/波形文件）
4. 性能数据汇总表（扫描/延迟/吞吐/资源占用 top/free）
5. 已知限制与风险（Web 无认证等 —— 诚实是工程师的美德）
6. 结论与签核：开发___ 复核___ 日期___
```

### 常见问题 FAQ（避坑指南）
Q1：扫描统计偶发 15ms 尖峰，算 FAIL 吗？先归因再判定：单次 NFS/日志 IO 引起的孤立尖峰（p99 仍 <11ms）可接受并记录；趋势性超限必须修。验收的意义是给出**可解释的边界**，不是追求绝对完美。

Q2：测试用例太多做不完？优先级排序：安全相关(R9/DO互锁) > 核心功能(R5/R6) > 边界(R7异常码) > 体验(R8)。自动化脚本(32章 pytest)一次编写反复运行 —— 手工只留演示项。

Q3：答辩时被问「和真实西门子 PLC 差距」怎么答？坦诚框架：认证(IEC61131-3 一致性等级/功能安全 SIL)、鲁棒性(多年老化验证)、生态(TIA Portal 工具链)是差距；差异化在开放性(Linux 生态/自研深度/成本)。展示你清楚差距本身就是能力证明。

**📝 思考题**
- 为什么 DI 端到端延迟的「分布」比「平均值」更重要？画出你实测的直方图并解释双峰来源。
- 为 V-SR 设计自动化故障注入脚本（kill/断网/断电模拟），如何判定「自愈成功」？
- 如果验收指标改为「扫描 1ms」，你的架构哪些环节先崩？给出改造路线优先级。

### 35.5 深潜：联调排障手册——集成期 Top10 问题（症状→层→根因→解法）

| # | 症状 | 层 | 根因 | 解法/预防 

| 1 | 功能全变回旧版 | PL | 改了 RTL 忘记重新 Export XSA/下载 bit | 版本寄存器(0x0C)带构建时间戳，启动自检打印 ★ 

| 2 | 读 IP 寄存器总线挂死 | 地址 | DTS reg 与 Vivado 分配不一致 | 以 Address Editor 为唯一真源；脚本自动生成宏头文件 

| 3 | /dev/uio0 不存在 | 内核 | compatible 不匹配或 CONFIG 缺失 | dtc 反编译验证 + dmesg grep uio 

| 4 | insmod Invalid format | 内核 | vermagic 不一致 | 模块与内核同一棵源码树编译(17章) 

| 5 | 中断计数不涨 | 硬件 | IRQ_F2P 未勾选/concat 未连/xlconcat 位序错 | ILA 直接探 IRQ 线，二分定位在 PL 还是 GIC 

| 6 | 偶发扫描尖刺 | 应用 | 锁内格式化/NFS 写日志（29.5 案例） | 锁粒度纪律+异步日志架构 

| 7 | NFS 根随机卡死数秒 | 网络 | 交换机节能/网卡协商抖动 | ethtool 关 autoneg? 固定速率+关 EEE；关键数据走本地分区 

| 8 | Modbus 偶发连接拒绝 | 应用 | backlog 满/线程创建失败未处理 | listen backlog≥16 + accept 失败重试+连接数上限 

| 9 | 长时间运行后 Web 无响应但 PLC 正常 | 应用 | Web 线程被慢客户端阻塞(半开连接) | 读写超时+心跳断连+连接表巡检回收 

| 10 | 重启后时间回到 1970, SOE 全乱 | 系统 | 无 RTC 电池且 NTP 未就绪即开始记录 | 时间未同步标志置位, SOE 缓冲延后打戳; 加 RTC 模块(43章) 

💡 手册使用法
每次联调新问题解决后，强制追加一行到本手册（症状≤20字）。三个月后它就是你团队最值钱的知识资产——面试时「你踩过什么坑」的答案全部出自这里。

[← 上一篇第34章 系统集成与开机自启](#ch34)
[下一篇 →第36章 项目总结与技术展望](#ch36)

---

## 第36章 项目总结与技术展望
收官：把 36 章的旅程收束成一张知识地图，并给你下一段进阶路线。

**🎯 学习目标**
- 复盘全项目技能图谱与工程决策
- 获得可执行的进阶路线图（实时/总线/标准运行时）
- 学会把项目转化为求职与学术成果

### 36.1 技能图谱：每一篇在哪里发光

| 篇章技能 | 在软 PLC 项目中的落点 

| Verilog / 三段式 FSM（5章） | DI 滤波状态机、PWM、中断汇聚（27章） 

| AXI 与自定义 IP（9章） | plc_io_engine 寄存器合同与集成（27章） 

| 裸机中断体系（8章） | 理解 GIC→IRQ_F2P 链路的底层语义 

| 启动链与 BOOT.BIN（12/13章） | 产品化固化与升级包（34章） 

| 设备树 / platform 驱动（14/18章） | generic-uio 节点与中断绑定（28章） 

| PetaLinux 工作流（15章） | rootfs 定制、gdbserver/lighttpd 集成（15.5/34章） 

| ILA / 时序 / CDC（21/22章） | IO 引擎验证、50MHz↔AXI 互联的健壮性 

| 远程调试 / Oops 解析（24/25章） | 运行时联调、五层定位排障（29~34章全程） 

| 应用编程四件套（20章） | 扫描循环、互斥映像区、socket 通信（29/32章） 

### 36.2 项目量化画像

| 模块 | 规模（约） | 语言 

| PL IO 引擎 | 1200 行 RTL + 400 行 TB | Verilog 

| plcio 用户态库 + 测试工具 | 600 行 | C 

| 运行时（映像/解释器/功能块/扫描） | 1800 行 | C 

| Modbus TCP/RTU 从站 | 900 行 | C 

| Web 服务 + 页面 | 500 C + 300 HTML/JS | C / JS 

| LD→IL 编译器 + 自动化测试 | 400 Python | Python 

| **合计** | **≈6000 行，全部亲手** | - 

### 36.3 进阶路线图（按投入产出排序）

| 方向 | 做什么 | 关键资源 | 难度 

| 实时性升级 | PetaLinux 打 PREEMPT_RT 补丁，扫描抖动压到 <100μs，重跑 V-RT 对比报告 | Xilinx RT 内核源、LWN RT 系列 | ★★ 

| 标准 IEC 运行时 | 对接 **matiec/Beremiz**：ST/LD 全语言、离线 IDE，你的硬件做执行端 | beremiz-project.org | ★★★ 

| 工业以太网 | **SOEM** 主站跑 EtherCAT 从机（如 EL1008/EL2008 端子）—— 简历含金量陡增 | Open EtherCAT Society | ★★★ 

| 信息模型 | **open62541** 实现 OPC UA Server，把映像区暴露为节点集 | open62541.org | ★★ 

| AMP 异构 | 核0 Linux + 核1 裸机实时核（OpenAMP/rpmsg 通信），把扫描下沉到核1 | Xilinx OpenAMP Wiki | ★★★★ 

| 高速采集 | S_AXI_HP + VDMA/AXI-DMA，XADC 1MSPS 连续流 + 环形缓冲 | PG035 DMA、UG585 HP 口 | ★★★ 

| 可靠升级 | eMMC A/B 双 rootfs + uboot 计数回退的 OTA 框架 | SWUpdate / RAUC 设计文档 | ★★★ 

| 安全概念 | 学习 IEC 61508 SIL 级别要求，为互锁通道做「双通道异构表决」设计文档 | IEC 61508 入门材料 | ★★（概念） 

### 36.4 成果包装指南
#### 简历写法（STAR 法则示例）
✍️ 项目描述模板
基于 ZYNQ-7020 自研工业软 PLC：PL 侧 Verilog 实现 8 通道去抖 DI/8 路 DO/双 PWM/XADC 采集与中断引擎（AXI4-Lite，资源占用 <10%）；PS 侧 Linux 运行时实现 IEC 风格 IL 虚拟机、TON/TOFF/TP/CTU/CTD 功能块与 10ms 精确扫描（30 分钟实测抖动 <1ms）；自研 Modbus TCP/RTU 双栈从站（pymodbus 自动化回归 100% 通过）与 Web 监控；三级看门狗实现 50 次故障注入 100% 自愈。全栈代码约 6000 行。

#### 毕设/答辩要点

- 准备 3 层深度答案：30 秒电梯陈述 → 5 分钟架构讲解 → 任意模块代码级追问；
- 现场演示脚本化（35.3 产线故事），并预录视频防现场翻车；
- 主动展示「已知限制」清单 —— 评审最认可清醒的工程师；
- 数据说话：扫描抖动直方图、DI 延迟分布、故障自愈时间线三张图胜过千言。

### 36.5 进阶资源清单

- **官方文档**：UG585(TRM)、UG1144(PetaLinux)、PG059(AXI GPIO)、UG1037(AXI 参考)、AMBA AXI 规范(IHI0022)；
- **书籍**：《嵌入式Linux驱动开发指南》(正点原子)、《Linux Device Drivers 3rd》、《FPGA Prototyping by SystemVerilog Examples》(Pong Chu)；
- **开源项目精读**：linux-xlnx 驱动目录、u-boot-xlnx、SOEM、open62541、Beremiz/matiec、libmodbus；
- **社区**：AMD/Xilinx Developer Forum、Hackaday、知乎/FPGA开源工坊等中文社区。

### 全课程通关自测（能答出 80% 即毕业）

| # | 终极问题 

| 1 | 从按下板卡电源到 Web 页面显示 IO 状态，完整叙述经过的每一级软件与其职责。 

| 2 | 解释一个按键信号从物理引脚到 %IX0.0 位翻转的全部路径，指出每一步可能的故障模式。 

| 3 | 为什么 DI 事件用「锁存+W1C」而不用脉冲直通？如果扫描线程卡死 500ms 会发生什么、如何被发现？ 

| 4 | 给出把扫描抖动从 1ms 压到 100μs 的三条措施及各自代价。 

| 5 | 如果让你把本项目做成双机热备，你会如何设计同步与切换？列出前三个要解决的问题。 

🎓 结语
36 章走完，你已经完成了从「点亮一个 LED」到「交付一台工业控制器」的完整跃迁。真正值钱的不是这块板子，而是你在此过程中建立的**系统思维、契约意识与证据文化** —— 它们可以平移到任何嵌入式平台。保持动手，保持好奇，下一颗芯片见。

[← 上一篇第35章 综合案例与验收测试](#ch35)
[下一篇 →第37章 内核并发与同步专题](#ch37)

---

