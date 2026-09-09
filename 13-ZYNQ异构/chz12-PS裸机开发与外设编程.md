---
title: "PS裸机开发与外设编程"
date: 2025-09-09
category: "ZYNQ异构"
tags: ["ZYNQ", "裸机", "GPIO", "UART", "中断", "定时器"]
description: "PS裸机开发入门、Hello ZYNQ、GPIO/UART/中断/定时器外设编程"
---

# PS裸机开发与外设编程

> PS裸机开发入门、Hello ZYNQ、GPIO/UART/中断/定时器外设编程

## 目录

1. [[#PS 裸机开发入门：Hello ZYNQ|PS 裸机开发入门：Hello ZYNQ]]
2. [[#PS 外设编程：GPIO / UART / 中断 / 定时器|PS 外设编程：GPIO / UART / 中断 / 定时器]]

---

## 第7章 PS 裸机开发入门：Hello ZYNQ
从这一章起，你开始驱动 ARM 硬核 —— 理解 XSA、BSP、ps7_init 三件套，跑通第一个串口程序。

**🎯 学习目标**
- 掌握「Vivado 建 BD → 导出 XSA → Vitis 建平台与应用」标准流程
- 理解 FSBL / ps7_init 在裸机启动中的角色
- 通过 UART1 输出 Hello World，建立软硬件交叉验证习惯

### 7.1 裸机开发工具链全景（2020.2 版本变化）
2020.x 起，老 SDK 被 **Vitis 统一 IDE** 取代。概念对应关系：

| 旧 SDK 时代 | Vitis 2020.2 | 说明 

| Hardware Platform (.hdf) | Platform Project（来自 .xsa） | XSA = Vivado 导出的硬件描述包（含BD、约束、ps7_init） 

| BSP | Platform Project 内的域（Domain：standalone） | standalone 即裸机 BSP，含驱动库与 xparameters.h 

| Application Project | Application Project | 你的 main.c，引用平台头文件与库 

### 7.2 Vivado 侧：创建含 PS 的最小系统

- 新建工程 `ps_hello`，同第6章选择 xc7z020clg484-1。
- **Create Block Design**（IP Integrator），在画布空白处点击 + 添加 IP：`ZYNQ7 Processing System`。
- 点击上方绿色横幅 **Run Block Automation**，勾选 Apply Board Preset？—— 领航者提供官方板卡预设文件则勾选；没有就手动配置：
  
    **PS-PL Configuration**：暂不勾选任何 AXI 口（最小系统）；
    - **Peripheral I/O Pins**：勾选 UART1（引脚按板卡 MIO 规划自动/手动指定）、SD0（TF 卡，为后续章节预留）、QSPI；
    - **Clock Configuration**：Input frequency 33.333MHz（PS_CLK 查原理图），保持默认 PLL 配置（CPU 767MHz、DDR 533MHz）；
    - **DDR Configuration**：Controller Type 选 DDR3，按板卡手册填容量 1024MB、位宽 32bit、时序参数（正点原子资料提供现成配置截图照抄即可）。
  
- **F6 Validate Design**（Ctrl+S 保存），无错误后右键 BD → **Generate Output Products** → Global（纯PS无需综合BD）。
- 菜单 **File → Export → Export Hardware**，勾选 Include bitstream（本例无 PL 逻辑可不勾），导出 `ps_hello.xsa`。

### 7.3 Vitis 侧：平台与应用

- Vivado 菜单 **Tools → Launch Vitis**，指定工作区路径（无中文空格）。
- **File → New → Platform Project**：名称 `ps_hello_platform`，XSA 选择刚导出的文件。完成创建后点 **Build Platform**——产物是 standalone 域的 BSP 库。
- **File → New → Application Project**：名称 `hello_uart`，关联上述平台，Domain 选 *standalone (ps7_cortexa9_0)*，模板选 **Hello World** 或 Empty Application(C)。
- 点击锤子图标编译，产物在 `hello_uart/src` 同级 Debug 目录：`hello_uart.elf`。

### 7.4 代码：UART1 打印 + 寄存器直读体验
```
#include <xparameters.h>      /* 自动生成：所有外设基地址/中断号速查表 */
#include <xuartps.h>           /* UART 驱动 API */
#include <xil_printf.h>        /* 轻量 printf，不依赖完整 libc */
#include <sleep.h>

int main(void)
{
    int status;
    XUartPs uart;

    /* 初始化 UART1 —— 基地址由 xparameters.h 提供 */
    XUartPs_Config *cfg = XUartPs_LookupConfig(XPAR_XUARTPS_1_DEVICE_ID);
    if (cfg == NULL) return XST_FAILURE;
    status = XUartPs_CfgInitialize(&uart, cfg, cfg->BaseAddress);
    if (status != XST_SUCCESS) return XST_FAILURE;

    XUartPs_SetBaudRate(&uart, 115200);

    while (1) {
        xil_printf("Hello ZYNQ! CPU freq = %d Hz\r\n",
                   XPAR_CPU_CORTEXA9_CORE_CLOCK_FREQ_HZ);
        /* 直读私有定时器计数寄存器，体验"寄存器就在那里"的感觉 */
        u32 cnt = *(volatile u32 *)0xF8F00604;   /* CPU private timer counter */
        xil_printf("private timer count = 0x%08x\r\n", cnt);
        sleep(1);
    }
    return 0;
}
```
打开 MobaXterm 连接串口（115200 8N1），接下来把程序跑起来。

### 7.5 关键机制：JTAG 裸机为什么需要 ps7_init？
芯片刚上电时，**DDR 控制器未初始化、PLL 未配置、MIO 复用未设定**——任何访问 DDR 的代码都会挂死。Vivado 导出 XSA 时会生成 `ps7_init.tcl/.c/.h`，它就是一份「按正确顺序写 SLCR/DDR/GPIO 寄存器」的初始化脚本：

| 场景 | 谁负责初始化 | 说明 

| Vitis 中 JTAG 调试裸机 ELF | System Debugger 自动先执行 ps7_init.tcl | Debug Configurations 里可见 "ps7_init" 步骤，勿删 

| SD/QSPI 产品化启动 | FSBL（First Stage Boot Loader） | FSBL 本质 = ps7_init 的 C 版 + 加载 bitstream + 跳转下一镜像，第12章详解 

| 只跑 OCM 小程序 | 可跳过 | 不碰 DDR 时可省略初始化（高级玩法） 

💡 运行方式二选一
**A. 直接运行**：右键应用 → Run As → Launch on Hardware（相当于下载即运行）。
**B. 调试运行**：Debug As → Launch on Hardware，可在 main() 设断点单步——现在就试试在第14行打断点，观察 `cfg->BaseAddress` 的值是否等于 0xE0001000（UART1 基地址），把第2章的地址表变成亲眼所见。

### 7.6 程序内存布局初探
双击工程的 `lscript.ld`（链接脚本）：standalone 默认把代码放在 **DDR 低地址 0x100000** 起，栈堆在其上分配；若把区域改成 OCM（0xFFFC0000），整个程序就能脱离 DDR 运行——这是理解「FSBL 为什么放 OCM」的最好实验。

### 常见问题 FAQ（避坑指南）
Q1：串口完全没有输出？① 板卡 console 接的是 UART**1**，而模板默认打印走 stdout 映射——确认 Platform 里 UART 选择与硬件一致；② 波特率不符（改过 PLL 后默认可能不是115200）；③ 代码跑飞在 DDR 初始化前（调试器没执行 ps7_init——检查 Debug 配置）；④ TX/RX 接反（用外部 USB-TTL 时）。

Q2：修改了 Vivado 设计重新导出 XSA，Vitis 里怎么更新？右键 Platform Project → **Update Hardware Specification** 选择新 XSA，然后重新 Build Platform 与应用。**不要**新建第二个平台工程，否则两套 xparameters.h 容易张冠李戴。

Q3：xil_printf 打印浮点数乱码？xil_printf 为节省空间不支持 %f。需要浮点打印时链接完整 newlib 并用 sprintf/snprintf 组合，或在 Platform 设置中开启相应库选项（增大体积）。

Q4：Vitis 编译报错找不到 xparameters.h？应用的 C/C++ Build 引用了平台 include 路径，通常自动配置。手动检查：Properties → Paths and Symbols → Includes 应包含 `<platform>/export/<platform>/include`。多数情况是先建应用后补建平台导致的，重建应用即可。

**🧪 动手实验 L7-1：让地址表活起来**
① 在断点处依次查看 `*(volatile u32*)0xF8F00000`（SLCR ID）、GPIO 基址 0xE000A000 处内容，对照 UG585 确认模块签名；② 把链接脚本内存区改为 OCM 重新编译运行，验证程序仍能工作并思考原因；③ 用 `xil_printf` 打印 L2 Cache 大小相关宏，浏览 `xparameters.h` 找出 GIC、私有定时器的宏名规律。

**📝 思考题**
- ps7_init 与 FSBL 功能重叠，为什么 JTAG 场景不用完整 FSBL？（提示：启动介质、加载对象、速度）
- 如果两个应用分别要在核0和核1上运行（AMP），链接脚本需要注意什么？
- 阅读 hello.c 模板的汇编启动流程（Debug 单步到 main 前），说明 _start → main 之间发生了什么。

[← 上一篇第6章 第一个FPGA工程：纯PL流水灯](#ch06)
[下一篇 →第8章 PS外设编程](#ch08)

---

## 第8章 PS 外设编程：GPIO / UART / 中断 / 定时器
掌握裸机四大件，你就能读懂绝大多数 ZYNQ 裸机例程 —— 并为理解 Linux 驱动打下寄存器级直觉。

**🎯 学习目标**
- 区分 MIO / EMIO / AXI GPIO 三种 GPIO 形态并正确选型
- 使用 xgpiops / xscugic / xscutimer 完成输入输出、中断、定时
- 建立「外设 = 基地址 + 寄存器集 + 中断号」的统一心智模型

### 8.1 GPIO 三种形态对比

| 形态 | 归属 | 数量 | 优点 | 适用 

| MIO GPIO | PS IOP，54 根固定引脚 | 54 | 无需 PL、上电即可用 | LED、按键、控制信号 

| EMIO GPIO | PS GPIO 经 PL 引出 | 64 组 | 引脚位置灵活（PL 管脚） | MIO 不够用/引脚在 PL 区域 

| AXI GPIO IP | PL 逻辑 | 任意位宽 | 可定制（双通道、中断、位可独立配置） | 与自定义逻辑同域的 IO 

💡 选型口诀
纯 PS 信号找 MIO；引脚必须落在 PL 管脚上用 EMIO；需要和 PL 自定义逻辑「住在一起」或要位级中断，用 AXI GPIO（第9章实战）。

### 8.2 EMIO 点灯 + MIO 按键（xgpiops）
**Vivado 侧**：双击 ZYNQ7 PS 核 → MIO Configuration → GPIO → 勾选 *EMIO GPIO (Width) = 1*；引出 `GPIO_0` 端口，右键 Make External，并在 XDC 中约束到某个 LED 引脚；Generate Output Products + Export Hardware（**勾选 Include bitstream**，因为这次有 PL 内容）。

```
# XDC 中约束 EMIO 引脚（端口名自动为 GPIO_0_tri_io[0]）
set_property -dict {PACKAGE_PIN H17 IOSTANDARD LVCMOS33} [get_ports {GPIO_0_tri_io[0]}]
```
```
#include <xgpiops.h>
#include <xparameters.h>
#include <xil_printf.h>
#include <sleep.h>

#define EMIO_LED   54          /* EMIO 从 54 开始编号（0~53 是 MIO）*/
#define MIO_KEY    50          /* 按键所在 MIO 号：查板卡手册！     */

int main(void)
{
    XGpioPs gpiops;
    XGpioPs_Config *cfg = XGpioPs_LookupConfig(XPAR_XGPIOPS_0_DEVICE_ID);
    XGpioPs_CfgInitialize(&gpiops, cfg, cfg->BaseAddress);

    XGpioPs_SetDirectionPin(&gpiops, EMIO_LED, 1);      /* 输出 */
    XGpioPs_SetOutputEnablePin(&gpiops, EMIO_LED, 1);
    XGpioPs_SetDirectionPin(&gpiops, MIO_KEY, 0);       /* 输入 */

    int cnt = 0;
    while (1) {
        XGpioPs_WritePin(&gpiops, EMIO_LED,
                         XGpioPs_ReadPin(&gpiops, MIO_KEY)); /* 按下点亮 */
        xil_printf("key=%d cnt=%d\r\n",
                   XGpioPs_ReadPin(&gpiops, MIO_KEY), cnt++);
        usleep(200000);
    }
    return 0;
}
```

### 8.3 中断系统：GIC 三类中断源

| 类型 | ID 范围 | 例子 

| SGI 软件中断 | 0~15 | 核间通信（IPI） 

| PPI 私有外设中断 | 27~31 | 每核私有定时器(29)、看门狗(30) 

| SPI 共享外设中断 | 32~95 | UART1=82、GPIO=52、QSPI=51、**IRQ_F2P=61~68/84~91（PL→PS）** 

中断编程固定四步：**① 异常向量初始化（Xil_ExceptionInit）→ ② GIC 初始化并 Connect 外设 → ③ 使能外设自身中断源 → ④ 总开关 Xil_ExceptionEnable**。

### 8.4 实战：私有定时器 500ms 中断 + EMIO GPIO 中断按键
```
#include <xscutimer.h>
#include <xscugic.h>
#include <xgpiops.h>
#include <xil_exception.h>

#define TIMER_DEVICE_ID  XPAR_XSCUTIMER_0_DEVICE_ID
#define INTC_DEVICE_ID   XPAR_SCUGIC_SINGLE_DEVICE_ID
#define TIMER_IRPT_ID    XPS_SCU_TMR_INT_ID        /* 29 */
#define GPIO_IRPT_ID     XPS_GPIO_INT_ID           /* 52 */
#define EMIO_KEY         54
#define CNT_500MS        (XPAR_SCUTIMER_CLOCK_FREQ_HZ / 2 - 1)

static XScuTimer  timer;
static XScuGic    intc;
static XGpioPs    gpiops;
static volatile int tick = 0, key_cnt = 0;

void timer_handler(void *cb)                       /* 中断服务函数：短平快 */
{
    XScuTimer_ClearInterruptFlag(&timer);
    tick++;
    XGpioPs_WritePin(&gpiops, 55, tick & 1);       /* EMIO LED 翻转 */
}

void key_handler(void *cb)
{
    XGpioPs_InterruptDisable(&gpiops, EMIO_KEY);   /* 关源→清标志→处理→开源 */
    XGpioPs_InterruptClear(&gpiops, EMIO_KEY);
    key_cnt++;
    XGpioPs_InterruptEnable(&gpiops, EMIO_KEY);
}

int main(void)
{
    /* ---- GIC ---- */
    XScuGic_Config *gcfg = XScuGic_LookupConfig(INTC_DEVICE_ID);
    XScuGic_CfgInitialize(&intc, gcfg, gcfg->CpuBaseAddress);
    Xil_ExceptionInit();
    Xil_ExceptionRegisterHandler(XIL_EXCEPTION_ID_INT,
        (Xil_ExceptionHandler)XScuGic_InterruptHandler, &intc);

    /* ---- 定时器 ---- */
    XScuTimer_Config *tcfg = XScuTimer_LookupConfig(TIMER_DEVICE_ID);
    XScuTimer_CfgInitialize(&timer, tcfg, tcfg->BaseAddress);
    XScuGic_Connect(&intc, TIMER_IRPT_ID,
                    (Xil_ExceptionHandler)timer_handler, &timer);
    XScuTimer_EnableInterrupt(&timer);             /* 外设级使能 */
    XScuTimer_LoadTimer(&timer, CNT_500MS);
    XScuTimer_AutoReload(&timer);
    XScuTimer_Start(&timer);

    /* ---- GPIO 中断（下降沿触发按键）---- */
    XGpioPs_Config *pcfg = XGpioPs_LookupConfig(XPAR_XGPIOPS_0_DEVICE_ID);
    XGpioPs_CfgInitialize(&gpiops, pcfg, pcfg->BaseAddress);
    XGpioPs_SetDirectionPin(&gpiops, EMIO_KEY, 0);
    XGpioPs_SetInterruptType(&gpiops, EMIO_KEY, XGPIOPS_IRQ_TYPE_EDGE_FALLING);
    XGpioPs_InterruptClear(&gpiops, EMIO_KEY);
    XGpioPs_InterruptEnable(&gpiops, EMIO_KEY);
    XScuGic_Connect(&intc, GPIO_IRPT_ID,
                    (Xil_ExceptionHandler)key_handler, &gpiops);
    int bank = 0, pin = 0;
    XGpioPs_GetBankPin(EMIO_KEY, &bank, &pin);   /* 换算 Bank 号与 Pin 号 */
    XGpioPs_IntrEnable(&gpiops, bank, (1 << pin));

    /* ---- 总开关 ---- */
    Xil_ExceptionEnableMask(XIL_EXCEPTION_ALL);
    Xil_ExceptionEnable();

    while (1) {
        if (key_cnt) { xil_printf("key pressed: %d\r\n", key_cnt); key_cnt = 0; }
    }
    return 0;
}
```
📌 关于上面省略号处
GPIO 的 Bank 中断使能需要先由 `XGpioPs_GetBankPin()` 换算 Bank 号与 Pin 号（EMIO54 属于 Bank4? 实际按库返回值处理），再 `XGpioPs_IntrEnable(&gpiops, bank, 1<<pin)`。完整可编译代码请以随板例程为准 —— 这里展示的是**调用顺序骨架**，这正是面试与排障时最重要的东西。

### 8.5 裸机外设编程统一心法

- `xparameters.h` 里查三件套：**DEVICE_ID、BASEADDRESS、INTR ID**；
- `Xxx_LookupConfig()` + `Xxx_CfgInitialize()` 完成实例绑定；
- 配置寄存器级参数（波特率、方向、触发沿、装载值）；
- 若用中断：GIC Connect → 外设使能 → 总开关，ISR 内「关源-清标志-处理-开源」；
- 轮询 or 中断的取舍：低速率调试用轮询（简单可靠），实时响应用中断，大数据用 DMA。

### 常见问题 FAQ（避坑指南）
Q1：中断一次都不触发？按「四级使能」逐层检查：① 外设自身中断使能位；② GIC 对应 ID 使能（XScuGic_Enable 或 Connect 自动）；③ CPU 接口使能（Xil_ExceptionEnable）；④ 触发条件真的发生（用 ILA/示波器确认信号边沿）。任何一级缺失都静默无反应。

Q2：中断只触发一次？ISR 里忘记清除外设的 pending 标志。GIC 层面 XScuGic_Acknowledge 已由框架处理，但外设级标志必须手动清（如 XScuTimer_ClearInterruptFlag）。未清除则 GIC 不会再上报。

Q3：EMIO 输出始终无电平变化？① 新 bitstream 没有重新下载（EMIO 路径经过 PL！）；② XDC 约束端口名与 BD 引出端口不一致；③ Direction/OutputEnable 没设置；④ 板卡该 LED 低有效，写 1 反而灭。

Q4：printf 在中断里偶尔死机？xil_printf 非重入且轮询 UART 较慢，ISR 内打印可能与其他上下文冲突。ISR 只置标志/写缓冲，打印留给主循环 —— 这条纪律在 Linux 驱动里同样成立（printk 在中断上下文同样受限）。

**🧪 动手实验 L8-1：可交互秒表**
组合本章技能：私有定时器产生 10ms 系统节拍；按键 KEY_A 启动/暂停计数，KEY_B 清零；LED 以 4bit 二进制显示秒数低4位；串口实时打印 `mm:ss.t`。要求全部逻辑基于中断标志位 + 主循环状态机，ISR 内不打印。

**📝 思考题**
- 为什么 EMIO 的 GPIO 编号从 54 开始？读 xgpiops 驱动源码找到编号换算函数。
- 两个中断同时到达（定时器与按键），GIC 如何决定先后？如何在代码里让按键优先级更高？
- 把 8.4 的定时器换成 AXI Timer（PL 内 IP），中断号会变成什么？为什么？（提示：IRQ_F2P）

[← 上一篇第7章 PS裸机开发入门](#ch07)
[下一篇 →第9章 AXI总线与自定义IP设计](#ch09)

---

