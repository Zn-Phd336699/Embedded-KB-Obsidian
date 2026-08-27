---
title: "第49章 FreeRTOS 内存管理：heap_1~5 与任务栈检测"
part: "[[P5-MOC]]"
chapter: 49
tags:
  - domain/rtos
  - topic/memory
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch48-FreeRTOS-IPC五件套源码解析]]"
related:
  - "[[ch15-内存问题排查三板斧]]"
  - "[[ch06-链接器与内存布局]]"
  - "[[chsa-S1安全架构与SecureBoot实战]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第49章 FreeRTOS 内存管理：heap_1~5 与任务栈检测

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch48-FreeRTOS-IPC五件套源码解析]] | → [[ch50-FreeRTOS中断管理与Tickless低功耗]]

## 🎯 学习目标
- [ ] 说清 heap_1~5 五方案的机制、开销与适用场景，能按项目约束选型
- [ ] 用 xPortGetMinimumEverFreeHeapSize 搭建堆使用率/碎片率的周期监控与告警
- [ ] 解释 heap_4 相邻合并算法的边界情况，并亲手复现一次碎片化
- [ ] 建立任务栈「编译期—运行期—硬件期」三层防护体系，掌握静态创建全家桶

## 49.1 五方案对照表：选型先于编码
FreeRTOS 把内存管理做成五个可插拔方案（`portable/MemMang/heap_x.c`），二选一编译进工程。理解每个的取舍比背 API 重要十倍：

| 方案 | 算法 | 释放 | 碎片 | 适用 |
|------|------|------|------|------|
| heap_1 | 只分配不释放 | ❌ | 无（从不复用） | 初始化后不再分配的系统 |
| **heap_4 ★主流** | 首次适应+相邻空闲块合并 | ✅ | 可缓解 | 通用项目默认选择 |
| heap_2 | 最佳适应，不合并 | ✅ | 易碎 | 仅等尺寸分配场景（已少用） |
| heap_3 | 包装 libc malloc | ✅ | 取决于 libc | 想用 newlib 线程安全的场合 |
| **heap_5** | heap_4+多段非连续内存 | ✅ | 同 4 | 芯片有多块 RAM（F407 主SRAM+CCM） |

```c
/* heap_5 必须先定义区段表再启动调度器 */
HeapRegion_t xRegions[] = {
    { (uint8_t*)0x20000000UL, 112*1024 },   /* 主SRAM */
    { (uint8_t*)0x10000000UL, 64*1024  },   /* CCM */
    { NULL, 0 }
};
vPortDefineHeapRegions(xRegions);
/* 注意：DMA 不能碰 CCM(ch06) —— 按用途分区或封装双池实例 */
```

## 49.2 堆健康监控器：让运维先于用户看到问题
```c
typedef struct{ size_t free,ever_min,total; uint32_t frag_pct; } heap_stat_t;
heap_stat_t heap_snapshot(void){
    heap_stat_t s;
    s.total = configTOTAL_HEAP_SIZE;
    s.free  = xPortGetFreeHeapSize();
    s.ever_min = xPortGetMinimumEverFreeHeapSize();  /* 历史最低水位=真实峰值需求 */
    /* 碎片率近似：最大可分配连续块 / 总空闲 */
    s.frag_pct = 100 - 100*max_free_block()/s.free;  // 需改 heap_x.c 加遍历钩子
    return s;
}
/* 巡检策略：每分钟采样 → ever_min<15%total 或 frag>40% 时 LOGE 并上报云端 */
```

## 49.3 heap_4 合并算法的边界情况
空闲块链按地址排序，释放时查前驱后继做三向合并：
```text
插入算法(pvInsertBlockIntoFreeList)三问：
  ① 后邻是空闲？ → 当前块吞并后块(尺寸相加)
  ② 前邻是空闲？ → 前块吞并当前块
  ③ 都不是 → 按地址序插表 —— 共四种分支：前+后 / 仅前 / 仅后 / 不合并
碎片场景：A/B/C 各100B 相邻分配；释放 B 后申请 150B 放不进洞继续找尾部 → 洞留存；
  若释放 A+C 而 B 还活着无法合并 → 外部碎片实锤。
对策排序：固定尺寸改池 > 分级尺寸池 > heap_5 分区隔离 > 重启兜底。
```
核心结论：**碎片只在「相邻」处才能愈合**——隔一个已分配块的洞永远留着，这是碎片实验的理论根基。

## 49.4 任务栈三层防护体系
1. **编译期**：每任务栈深按「`-fstack-usage` 最坏调用链 × 1.5」初估，写进任务创建表并注释依据；
2. **运行期**：`uxTaskGetStackHighWaterMark(NULL)` 巡检 + `configCHECK_FOR_STACK_OVERFLOW=2`（栈底 0xA5A5A5A5 魔数+栈指针边界双检）；溢出回调 `vApplicationStackOverflowHook` 里打印任务名后安全停机；
3. **硬件期**：MPU 给每任务栈底设哨兵页（ch21.5），溢出瞬间触发 MemManage 而不是静默踩别人。

## 49.5 静态创建全家桶（无堆系统）
```c
/* 安全关键/内存紧张项目的标准姿势：一切静态 */
StaticTask_t xTCB; StackType_t uxStack[512];
TaskHandle_t h = xTaskCreateStatic(vTaskSensors,"sens",512,NULL,5,uxStack,&xTCB);
configASSERT(h != NULL);   /* 静态法失败即返回NULL，断言早死早超生 */
StaticQueue_t qcb; uint8_t qbuf[8*sizeof(evt_t)];
QueueHandle_t q = xQueueCreateStatic(8,sizeof(evt_t),qbuf,&qcb);
/* 收益：RAM 占用编译期完全确定、无运行时分配失败路径 —— 认证类项目必选 */
```

## 49.6 SMP 双核环境注意事项
- 单核 heap_4 的临界区在 SMP 上必须换成跨核自旋锁保护；自写 `max_free_block()` 遍历钩子同样持锁执行——否则双核并发分配会破坏空闲链；
- ESP-IDF 场景建议用 heap_caps 按 DMA/internal/SPIRAM 能力分池，比裸 heap_5 更工程化；
- 栈高水位与溢出检查逐任务独立、与核无关；用 `xTaskCreateStaticPinnedToCore` 固定关键任务核归属。

## 49.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| ever_min 一路下滑 | vPortGetHeapStats 周期采样画曲线 | 热点路径去堆化、收敛分配尺寸 | 曲线走平且 ≥25% total |
| frag_pct 偏高 | 自实现 max_free_block() 遍历钩子 | 固定尺寸改池、heap_5 分区隔离 | frag < 20% |
| 任务栈水位过低 | uxTaskGetStackHighWaterMark 巡检 | 按最坏链×1.5 重算栈深 | 水位 ≥ 栈深 25% |

## 49.8 实测数据表：三种分配策略长期表现（72h 压力脚本）
| 策略 | P50 分配耗时 | 72h 后最大连续块 | 失败次数 |
|------|--------------|------------------|----------|
| heap_4 随机尺寸(64~1K) | 0.9µs | 38% 初始 | 17 |
| heap_4 定长(256B) | 0.8µs | 100%(无碎片) | 0 |
| 静态对象池 256B | **0.3µs** | 恒定 | 0(池满显式返回) |

## 49.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 运行数天后分配失败 | 碎片化累积(heap_4 无法跨块合并) | 看 frag_pct 曲线；固定尺寸对象改池化；重启兜底+上报 |
| CCM 区分配导致 DMA 死等 | heap_5 未分区/分配落错区 | 打印返回地址区间核对；DMA 专用池分离 |
| 栈溢出 hook 抓到的名字不对 | 溢出破坏 TCB 链导致误报 | MPU 哨兵页精确抓现行；hook 尽量只读寄存器现场 |

## 49.10 部署注意事项
1. ISR 内禁止动态分配是铁律——预分配 ISR 私有缓冲区；
2. `configAPPLICATION_ALLOCATED_HEAP` 把 ucHeap 放指定段（ld 控制）——CCM/SRAM 分区管理的官方入口；
3. v10+ 项目优先用 `vPortGetHeapStats()`，别重复造监控钩子；
4. heap_3 场景必须实现 newlib 的 `_sbrk` 并检查 `&_end` 上限，否则 printf 一来就踩堆；
5. 认证类项目全静态创建，让 RAM 占用在编译期完全确定。

> [!example]- 🧪 动手实验 L49-1：复现并消灭一次碎片化（55 分钟）
> **步骤**：① 写随机尺寸 malloc/free 压力脚本跑 12h，记录 xPortGetMinimumEverFreeHeapSize 曲线；② 观察最大连续块衰减趋势；③ 把热点尺寸改为对象池重跑对比；④ 输出前后对比图。**验收**：能向团队证明「为什么这个模块必须去堆化」——碎片曲线从衰减变为水平。

## 49.11 进阶话题
- **栈与堆同区的风险**：默认 ld 里 heap 紧贴 bss、stack 在顶——相撞即灾难，RAM 预算表+MPU 双保险别省；
- **开源精读定位**：`portable/MemMang/heap_4.c` 全文仅约 300 行，值得逐行读一遍；
- **对照范本**：Zephyr k_heap(sys_heap) 是比 FreeRTOS 更现代的桶式分配器；Knuth《Dynamic Storage Allocation》是 buddy/slab 思想源头。

> [!warning]- ❓ FAQ
> **Q1：等尺寸请求下 heap_2 反而无碎片？** 是——所有块同尺寸时最佳适应总能命中且永不产生内部残洞，如定长报文缓冲池；但只要混入异构尺寸就会碎片化，通用场景仍选 heap_4。
> **Q2：为什么 ever_min 就是「真实峰值需求」？** 它记录系统运行以来堆剩余量的最低点，总堆减去它即历史最高同时占用量——比任何瞬时采样都更接近最坏情况。

> [!question] 📝 思考题
> 1. 推导「固定尺寸请求下 heap_2 反而无碎片」的条件，举一个真实外设场景。
> 2. 为 heap_4 增加 max_free_block() 遍历钩子，注意它与并发分配的临界区关系。
> 3. 设计「RAM 预算表」模板：把 bss/heap/各任务栈/队列缓冲逐行列出并留审计列。

---
🏷️ #domain/rtos #topic/memory | 🔗 [[ch48-FreeRTOS-IPC五件套源码解析]] ← **本章** → [[ch50-FreeRTOS中断管理与Tickless低功耗]] | 📚 [[P5-MOC]]
