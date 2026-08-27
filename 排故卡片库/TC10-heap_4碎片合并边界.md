---
title: "空闲内存充足却分配不出连续大块"
tags:
  - troubleshooting
  - rtos/memory
severity: medium
frequency: occasional
source: "[[ch49-FreeRTOS内存管理heap与栈检测]]"
date: 2025-01-15
---
# TC10 heap_4 碎片合并边界与复现实验

## 现象
`xPortGetFreeHeapSize()` 显示剩余充足，`pvPortMalloc()` 却返回 NULL；触发条件：长期不规则 malloc/free 把堆切成大量被存活块隔断的小空洞。

## 环境与适用范围
FreeRTOS heap_4（带相邻空闲块合并）；heap_5 同理。以静态分配为主、堆只做一次性初始化的项目不适用。

## 取证过程
1. 打印总空闲值，再尝试递增大小的连续分配，估算「最大可连续分配块」。
2. 读 `xPortGetMinimumEverFreeHeapSize()` 看历史最低水位是否触底过。
3. 运行下方实验代码构造交替分配模式，稳定复现碎片化失败。
4. 给 pvPortMalloc/vPortFree 加统计桩，输出各尺寸块的分布直方图。

## 根因
heap_4 释放时只检查物理相邻块是否空闲来合并：两个大空洞中间哪怕隔着 64 字节存活小块就永不合并。边界细节：块头含对齐填充、pxEnd 哨兵块防止越过堆尾合并、双重释放会把同一块两次链入空闲表造成链表环且不被检测。

## 修复方案
```c
/* 碎片复现实验：空闲总量够，最大连续块不够 */
void fragmentation_demo(void)
{
    void *big[8], *pad[8];
    for (int i = 0; i < 8; i++) {
        big[i] = pvPortMalloc(512);      /* 大块 */
        pad[i] = pvPortMalloc(64);       /* 垫片隔断合并路径 */
    }
    for (int i = 0; i < 8; i++)
        vPortFree(big[i]);               /* 只放大块 */

    /* 此时空闲 ≈ 8*512+余量，却被 8 个 64B 垫片切成孤岛 */
    void *need = pvPortMalloc(2048);
    if (need == NULL) {
        /* 空闲充足却分配失败 → 碎片问题复现 */
    }
}
```

## 预防措施
- 固定尺寸对象用静态池/对象池，杜绝高频 malloc/free 循环
- 分配尺寸归一到少数几个档位，减少异形小洞
- 长稳测试同时盯 MinimumEverFree 和「最大可分配块」双指标
- 需要多块物理内存区域时迁移到 heap_5 并规划 region
- 怀疑双重释放时换带魔数校验的自定义分配器过渡排查

## 关联
- 源章节：[[ch49-FreeRTOS内存管理heap与栈检测]]
- 相关章节：[[ch15-内存问题排查三板斧]]、[[chs3-SO3-RTOS多任务系统调优]]
