---
title: "第24章 中断系统与NVIC深度应用"
part: "[[P3-MOC]]"
chapter: 24
tags:
  - domain/mcu
  - topic/interrupt
difficulty: 4
est_minutes: 45
prerequisites:
  - "[[ch21-Cortex-M架构精讲]]"
related:
  - "[[ch48-FreeRTOS-IPC五件套源码解析]]"
  - "[[ch19-逻辑分析仪与sigrok]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第24章 中断系统与NVIC深度应用

> [!info] 导航
> ⏱ 45min | ★★★★☆ | 前置 [[ch23-GPIO与时钟树实战]] | → [[ch25-定时器全家桶]]

## 🎯 学习目标
- [ ] 精确区分抢占优先级与子优先级的仲裁规则及分组影响
- [ ] 复述黄金法则内核机制，编写符合四铁律的 ISR 并选对临界区姿势
- [ ] 用逻辑分析仪实测中断延迟分布，说出为什么只看 P99/max

## 24.1 优先级体系全景

| 概念 | 规则 | F407 取值 |
|------|------|-----------|
| 抢占优先级 Preemption | 数值越小越优先，**可打断正在执行的低级 ISR** | 分组决定位数 |
| 子优先级 Sub | 只在同时 pending 时排定顺序，**不能抢占** | 与上互补 |
| IRQ 编号 | 前两者相同才比较 | 0~81 |
| 分组 NVIC_PriorityGroup | 整个工程统一设置一次 | 推荐 Group4：4 位抢占+0 位子（FreeRTOS 只用抢占） |

> [!warning] FreeRTOS 黄金法则（贴显示器旁）
> `configMAX_SYSCALL_INTERRUPT_PRIORITY`（默认 5）以上的中断（数值更小如 0~4）可以打断 RTOS 内核，但**禁止调用任何 FromISR API**。需要用队列/信号量的 ISR，优先级必须设为 5~15；违反则出现神秘 HardFault——FreeRTOS 新手第一大坑。SysTick/PendSV/SVC 固定最低 15。

## 24.2 原理深挖：黄金法则的内核机制真相

`configMAX_SYSCALL_INTERRUPT_PRIORITY=5` 变成硬件行为靠 `vPortValidateInterruptPriority`（ISR 内 API 入口调用）：**读 IPSR 得异常号 → 查 NVIC->IPR[irq] 取运行时优先级 → 断言数值 >= configMAX_SYSCALL（逻辑级别更低）**。同时 taskENTER_CRITICAL_FROM_ISR 用 BASEPRI=5<<4 屏蔽：数值 ≥5 的中断（可调 API 的那批）被挡住、内核数据结构安全；数值 <5 的高实时中断照常响应但绝不能碰 FromISR API。违规后果不是理论风险——configASSERT 直接死循环停机给你看。

## 24.3 关键代码：标准 ISR 写作规范（四铁律）

```c
void USART1_IRQHandler(void) {            /* 命名必须与启动文件向量表一致 */
    if (USART1->SR & USART_SR_IDLE) {     /* 先判标志再处理；读 DR 清 IDLE 序列 */
        (void)USART1->DR;
        BaseType_t hpw = pdFALSE;
        xSemaphoreGiveFromISR(g_rx_sem, &hpw);  /* FromISR 专用 API(共享标志 volatile) */
        portYIELD_FROM_ISR(hpw);          /* 需要切换任务时请求调度 */
    }
}
/* 四铁律：① 快进快出，只搬运数据/发事件，业务逻辑丢给任务
   ② 不调用非可重入函数：printf/malloc/浮点库慎入(ISR 用 FPU 要懒压栈预算)
   ③ 清标志位方式明确：写0清/写1清/读清各不同——查 RM 手册 rc_w1 列
   ④ 共享数据走队列或双缓冲，别裸奔全局变量 */
```

## 24.4 临界区三种姿势

```c
/* 姿势1 全局关中断 PRIMASK（粗暴，短临界区专用）*/
uint32_t pm = __get_PRIMASK(); __disable_irq();
/* ... */ __set_PRIMASK(pm);              /* 保存恢复而非盲开——支持嵌套 */
/* 姿势2 BASEPRI 屏蔽特定优先级以下 —— FreeRTOS taskENTER_CRITICAL 本质 */
__set_BASEPRI(5 << 4);                    /* 数值>=5(即5~15)全闭，0~4 仍能响应 */
__set_BASEPRI(0);                         /* 解除屏蔽 */
/* 姿势3 RTOS 互斥量（长临界区/可能阻塞场景）*/
xSemaphoreTake(mtx, portMAX_DELAY);
/* ...含耗时操作甚至 API 调用... */
xSemaphoreGive(mtx);
/* 选型口诀：几条指令 → 姿势1/2；跨函数或含阻塞 → 姿势3；
   ISR 里绝不能用姿势3(xSemaphoreTake 会断言)！ISR 只有 FromISR 不阻塞版本。
   工程纪律：全项目唯一入口封装 critical.h(crit_enter_global/rtos)，
   任何姿势持锁 ≤20 条指令，更长走 mutex(ch48)，写进评审清单 */
```

## 24.5 软件触发与向量表重定位

```c
/* 软件触发中断：测试/任务唤醒利器。STIR 只对特权级有效，
   且写入值是 IRQ 号本身、硬件内部减 16 映射——用错静默无效 */
NVIC->STIR = EXTI4_IRQn & 0xFF;

/* 向量表重定位：IAP/Bootloader 双程序共存的基础(ch30)。
   配套改链接脚本 FLASH ORIGIN 并核对 SystemInit 默认设置；
   进阶红利：向量表拷进 SRAM 后 VTOR 指过去——响应快一拍且支持运行期换表 */
SCB->VTOR = FLASH_BASE | 0x8000;          /* APP 区起始偏移 16KB */
```

## 24.6 中断延迟构成与优化

| 环节 | 典型周期(@168MHz) | 优化手段 |
|------|-------------------|----------|
| NVIC 仲裁+入栈+取向量跳转 | 12~16（尾链 6）+~4 | 硬件固有，无法再降 |
| handler 序言 | 取决于局部变量数 | naked+汇编关键路径 |
| 被更高优先级阻塞时长 | **不确定——真正的元凶** | 缩短同级以上 ISR；BASEPRI 分层隔离 |
| Cache miss(M7) | +数十周期 | 热 ISR 放 RAM/锁入 ICache |

测量方法联动 [[ch19-逻辑分析仪与sigrok]]：外部信号触发引脚 + ISR 入口翻转另一引脚，LA 光标直接读差值；或 DWT CYCCNT 在 ISR 首尾打点统计分布。均值无意义——P99/max 由最长同级以上临界段决定，优化目标永远是缩短那个最坏的 ISR。

## 24.7 实测数据表：延迟分布（外部信号→ISR 翻转脚，LA 统计 10 万次）

| 场景 | min | P50 | P99 | max |
|------|-----|-----|-----|-----|
| 空闲系统 | 0.42µs | 0.45µs | 0.6µs | 1.1µs |
| +3 个同级中断源轮转 | 0.42µs | 0.9µs | 4.2µs | 11µs |
| +长 ISR(60µs) 同优先级 | 0.42µs | 2.8µs | **61µs** | 62µs |

## 24.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 中断进不去 | NVIC Enable 缺失/EXTI 线路映射错/标志未清导致屏蔽 | 查 ISER、EXTI IMR/RTSR/FTSR；PR 位手动清测试 |
| 一进中断就 HardFault | 向量表地址错(VTOR)/函数签名不对/用了未初始化句柄 | 反汇编取向量核对地址；打印 IPSR 确认异常号 |
| 偶发数据撕裂 | 多字节共享变量被 ISR 打断 | 结构体读写包临界区；或改队列传值而非共享内存 |
| xQueueSendFromISR 卡死 | 该中断优先级高于 configMAX_SYSCALL(5) | NVIC 改到 5~15；黄金法则贴显示器旁 |

## 24.9 部署注意事项

1. 优先级分组只设一次：HAL_Init 里设 Group4 后，任何库再改分组都会让 IPR 解读错位——CI 加 grep 防二次配置
2. ICER 批量关断「立即生效」：正在执行的 ISR 不会被中止但 pending 保留，恢复顺序错了会收到迟到风暴；退出中断立刻重进多为 rc_w1 标志清错
3. 音频等高实时场景选 BASEPRI 分层屏蔽而非 PRIMASK 全关——高优中断不被临界区拖累
4. 临界区封装唯一入口 + 持锁 ≤20 条指令纪律，写进代码评审清单

> [!example]- 🧪 动手实验 L24-1：复刻延迟分布测量（50 分钟）
> **步骤**：① 信号发生器或另一 MCU 输出 1kHz 方波到 EXTI 脚；② ISR 首尾翻转 PB12；③ 逻辑分析仪采 100 秒导出 CSV；④ Python 计算分布并画直方图；⑤ 依次加入干扰源（同级轮转、长 ISR）复现三行数据的演化。
> **验收**：直方图+结论进笔记——你已掌握实时性验收的标准动作。

## 24.10 进阶话题

- 软触发的正确用法：STIR 特权级限定 + IRQ 号偏移规则，用于单测注入最优雅
- 向量表在 RAM 的红利：拷贝向量到 SRAM 后 VTOR 指过去，中断响应快一拍且支持运行期换表（bootloader 场景刚需）
- 优先级矩阵设计法：为「CAN 收发 + ADC DMA 完成 + SysTick」三中断先列实时性需求再分配层级（实战见 [[ch53-RTOS综合实战三轴云台控制器]]）；权威出处 RM0090 第 10 章 + PM0056 异常模型章

> [!warning]- ❓ FAQ
> **Q1：BASEPRI=0 是什么意思？** 表示「不屏蔽任何优先级」，不是屏蔽全部——想全关用 PRIMASK，两者语义混淆是经典事故。
> **Q2：ISR 里为什么不能 xSemaphoreTake？** 它可能阻塞，而 ISR 没有任务上下文可挂起，会直接触发 configASSERT 断言停机；ISR 只能用带 FromISR 后缀的不阻塞版本。

> [!question] 📝 思考题
> 1. 三个中断：抢占 1/子 0、抢占 1/子 1、抢占 2/子 0 同时 pending，画出执行顺序。
> 2. 解释 BASEPRI 相比 PRIMASK 在音频实时性上的优势，并为「CAN 收发+ADC DMA 完成+SysTick」设计完整优先级矩阵并论证。

---
🏷️ #domain/mcu #topic/interrupt #topic/freertos | 🔗 [[ch23-GPIO与时钟树实战]] ← **本章** → [[ch25-定时器全家桶]] | 📚 [[P3-MOC]]
