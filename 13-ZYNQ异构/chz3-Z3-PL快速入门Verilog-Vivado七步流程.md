---
title: "第Z3章 PL 快速入门：Verilog 精要与 Vivado 七步流程"
part: "[[P13-MOC]]"
chapter: "Z3"
tags:
  - domain/fpga
  - topic/hdl
  - topic/simulation
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[chz2-Z2-ZYNQ7020架构全景]]"
related:
  - "[[chz4-Z4-PS裸机与PS-PL协同AXI-Lite-DMA]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第Z3章 PL 快速入门：Verilog 精要与 Vivado 七步流程

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[chz2-Z2-ZYNQ7020架构全景]] | → [[chz4-Z4-PS裸机与PS-PL协同AXI-Lite-DMA]]

## 🎯 学习目标
- [ ] 掌握 Verilog 精要子集：always 块/assign/时序与组合逻辑/参数化
- [ ] 独立完成 Vivado 七步流程并让板上 LED 按预期频率闪烁
- [ ] 理解综合器视角：代码如何映射为 LUT/FF/BRAM

## Z3.1 Verilog 最小语法集
不需要成为 FPGA 专家，只需要会写「能让 LED 闪的 Verilog」。先完成 C→Verilog 的概念迁移（三条铁律：一个信号只在一个 always 驱动；组合 always 敏感列表用 `@(*)`；分支补全否则推断锁存器）：

| Verilog 概念 | C 类比(不精确但助记) | 关键区别 |
|--------------|----------------------|----------|
| wire | 导线(无存储) | 只能被 assign 连续赋值驱动 |
| reg | 变量(有存储) | 只能在 always 中赋值；综合后可能是 FF 或组合逻辑 |
| always @(posedge clk) | "在每个时钟上升沿执行" | **所有此类 always 并行运行！** |
| <= (非阻塞) / = (阻塞) | 时序专用 / 组合专用 | 同块内 <= 同时生效(旧值)；= 顺序立即生效 |
| parameter | #define | 可在实例化时覆盖 |

## Z3.2 Vivado 七步流程（每步做什么+验收标准）
| # | 步骤 | 操作 | 验收标准 |
|---|------|------|----------|
| 1 | 创建工程 | File→New Project→RTL Project→选 xc7z020clg400-2 | 工程树无红叉 |
| 2 | 添加/编写 RTL | Add Sources→Design Source→粘贴 led_blink.v | Syntax Check 无错 |
| 3 | 添加约束(XDC) | Add Constraints→绑定引脚和时钟频率 | 引脚名与原理图一致 |
| 4 | 行为仿真 | Run Simulation→Behavioral Simulation | 波形符合预期(LED 周期翻转) |
| 5 | 综合 Synthesis | Flow Navigator→Run Synthesis | 无 Critical Warning；查 Utilization 报告 |
| 6 | 实现 Implementation | Run Implementation(布局布线) | 时序报告 WNS≥0(无违例) |
| 7 | 生成比特流+烧写 | Generate Bitstream→Hardware Manager→Program Device | 板上 LED 以预期频率闪烁 ✓ |

## Z3.3 XDC 约束要点（引脚逐个 set_property PACKAGE_PIN 绑定，查正点原子原理图）
```tcl
create_clock -period 10.000 -name sys_clk [get_ports clk]   # 100MHz 主时钟
set_property PACKAGE_PIN A18 [get_ports {clk}]
set_property IOSTANDARD LVCMOS33 [get_ports *]              # 电平标准全显式声明
```

## Z3.4 关键代码一：LED 点灯
```verilog
module led_blink(
    input  wire clk, rst_n,   // clk=100MHz 板载时钟；rst_n 低电平复位
    output reg  led           // 在 always 中赋值故声明为 reg
);
    reg [26:0] cnt;           // 数到 67_108_863 翻转一次 ≈ 0.67s @100MHz
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)                     begin cnt <= 0;    led <= 0;   end
        else if (cnt == 27'd67_108_863) begin led <= ~led; cnt <= 0;   end
        else                            cnt <= cnt + 1'b1;
    end
endmodule
```

## Z3.5 关键代码二：按键消抖（机械抖动 ms 级，先同步再滤波）
```verilog
module key_debounce(
    input  wire clk, rst_n, key_in,   // clk=100MHz；rst_n 低有效；key_in 按下为低
    output reg  key_pulse             // 消抖后的按下单拍脉冲
);
    localparam N = 20;                // 2^20 / 100MHz ≈ 10ms 消抖窗口
    reg [N-1:0] cnt;  reg key_s0, key_s1, key_state;
    always @(posedge clk or negedge rst_n)      // 两级同步防亚稳态
        if (!rst_n) begin key_s0 <= 1'b1; key_s1 <= 1'b1; end
        else        begin key_s0 <= key_in; key_s1 <= key_s0; end
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin cnt <= 0; key_state <= 1'b1; key_pulse <= 1'b0; end
        else if (key_s1 != key_state) begin   // 电平跳变，开始计时
            if (&cnt) begin                   // 稳定满 ~10ms 才采纳
                key_state <= key_s1;
                if (!key_s1) key_pulse <= 1'b1;   // 下降沿发单拍脉冲
            end else cnt <= cnt + 1'b1;
        end else cnt <= 0;                    // 抖动则重新计时
    end
endmodule
```

## Z3.6 仿真 testbench 骨架
```verilog
`timescale 1ns / 1ps
module tb_led_blink();
    reg clk = 1'b0, rst_n;  wire led;
    led_blink uut(.clk(clk), .rst_n(rst_n), .led(led));   // 例化 DUT
    always #5 clk = ~clk;                  // 100MHz：周期 10ns
    initial begin rst_n = 0; #100 rst_n = 1; end   // 复位释放
    initial #200_000 $finish;              // 仿真时长按需截取
endmodule
```

## Z3.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| "inferred latch" 警告 | 读 Synthesis 日志 Warning 区 | 补全 if/else 与 case default | 警告消失 |
| WNS<0 时序违例 | Report Timing Summary 看关键路径 | 加一级流水或降频 | WNS≥0 |

## Z3.8 实测数据表（典型值）
| 工程 | LUT(典型值) | FF(典型值) | 说明 |
|------|-------------|------------|------|
| 仅 led_blink | ~10 | ~28 | 27bit 计数器+输出寄存 |
| led_blink + key_debounce 合计 | ~30 | ~55 | 占 xc7z020 容量 <0.1% |

## Z3.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| Synthesis 报 multi-driven net | 同一信号被两个 always 驱动 | grep 所有 assign 和 always 找重复赋值源 |
| 综合出 latch(推断锁存器) | if 缺 else 分支或 case 缺 default | 查 "inferred latch" 告警并补全分支 |
| 时序违例(WNS<0) | 路径延迟超时钟周期 | Report Timing Summary 查关键路径；降频或加流水线 |
| LED 不闪/仿真过但上板异常 | 引脚约束错/XDC 未加载/复位极性反/未验真实时序 | 确认 XDC 已 Include 并量复位电平；补做综合后仿真 |

## Z3.10 部署注意事项
1. XDC 必须加入工程且 Set as Target——多份约束并存时只有目标约束生效。
2. IOSTANDARD 全显式声明(LVCMOS33)；JTAG 烧写掉电即失，量产走 QSPI 固化；交付版移除 ILA 调试核。

> [!example]- 🧪 动手实验 LZ3-1：从零到 LED 闪烁全流程（90 分钟）
> **步骤**：① 按 Z3.2 七步完成 led_blink 工程；② 改计数器阈值观察频率变化；③ 添加第二个 LED 双灯交替；④ ILA 在线抓内部波形。**验收**：LED 以预期频率闪烁 + 一张 ILA 波形截图。

## Z3.11 进阶话题
- 流水线(pipeline)：长组合路径切段插寄存器，换吞吐提 Fmax。
- 亚稳态与两级同步器：一切异步输入（按键/传感器）必经处理。
- parameter 化设计 + SystemVerilog always_ff/always_comb：意图显式化便于 lint。

> [!warning]- ❓ FAQ
> **Q1：reg 一定是触发器吗？阻塞与非阻塞能混用吗？** reg 只是可过程赋值的语法对象，写在组合 always 里综合成纯逻辑；同一 always 内禁止混用——口诀：时序 <=，组合 =。
> **Q2：为什么仿真通过上板却异常？** 行为仿真不含真实布线延迟与亚稳态，补做综合后时序仿真并逐条复查 XDC。

> [!question] 📝 思考题
> 1. 把 led_blink 计数器终值改为 27'd4_999_999，LED 翻转周期变为多少？
> 2. 若两个 always 同时给 cnt 赋值，综合阶段会报什么错误？按键消抖为何先打两拍再比较？

---
🏷️ #domain/fpga #topic/hdl #topic/simulation | 🔗 [[chz2-Z2-ZYNQ7020架构全景]] ← **本章** → [[chz4-Z4-PS裸机与PS-PL协同AXI-Lite-DMA]] | 📚 [[P13-MOC]]
