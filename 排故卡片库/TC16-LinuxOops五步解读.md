---
title: "TC16 串口喷出 Oops 寄存器现场，驱动莫名崩溃"
tags:
  - troubleshooting
  - linux/kernel-debug
severity: high
frequency: common
source: "[[ch64-内核调试Oops解读debugfs-kdump]]"
date: 2025-01-15
---
# TC16 Linux Oops 五步定位法

## 现象
控制台突然打印 `Unable to handle kernel paging request` 与 pc/lr 寄存器区，随后 panic 或任务被杀；典型触发：模块首次访问设备、高并发下的偶发野指针。

## 环境与适用范围
适用 ARM Cortex-A Linux（i.MX6/RK/全志），内核开 CONFIG_KALLSYMS，且保有与线上一致、带 `-g` 的 vmlinux/.ko。不适用用户态 segfault（走 core dump 分析路径）。

## 取证过程
1. 完整留存现场：串口或 dmesg 抓全 Oops 文本（勿只截首行）；生产机预设 panic_on_oops=1 + kdump 自动留 vmcore。
2. 读关键字段：pc（出错指令）、lr（返回地址）、Comm（出事进程）、Call trace 调用链，判断处于进程还是中断上下文。
3. 地址归属：`cat /proc/modules` 取各模块基址，判断出错地址属于 vmlinux 还是某个 .ko。
4. 符号化：vmlinux 地址直接 addr2line；模块地址减去基址得 .ko 内偏移再 addr2line，必要时 objdump -d 核对出错指令。
5. 回到源码行：按 addr2line 输出的 file:line，结合寄存器值推断非法指针来源（如 NULL+偏移 ⇒ 某结构体指针未初始化）。
6. 归因分类：空指针/野指针/UAF/竞态/访问未映射外设（bus error），整理最小复现步骤。

## 根因
CPU 访存或取指命中非法虚拟地址，触发 Data/Prefetch Abort，内核异常入口打印现场后 die()/panic。PC/LR 只是案发现场，真凶常在上游的赋值与释放处。

## 修复方案
```bash
  # 取模块基址，确定 PC 落在哪
  cat /proc/modules | grep mydrv        # 0xbf000000
  # 模块内偏移 = PC - 基址，符号化到源码行
  addr2line -e mydrv.ko -f -C 0x1a2c    # 输出 src/foo.c:88
  # vmlinux 范围地址直接解析；反汇编核对指令
  addr2line -e vmlinux -f -C 0xc01a2f3c
  objdump -d mydrv.ko | less
```

## 预防措施
- 指针解引用前判空；copy_from_user/get_user 返回值必查
- timer/workqueue/tasklet 与模块卸载之间用 del_timer_sync/cancel_work_sync 收口竞态
- 测试版开启 KASAN/UBSAN，把内存错误消灭在上游
- vmlinux/System.map/.ko 按发布版本归档，保证事后可符号化
- panic_on_oops=1 与 kdump 常态化，现场不丢

## 关联
- 源章节：[[ch64-内核调试Oops解读debugfs-kdump]]
- 相关章节：[[ch05-ARM汇编与反汇编排障]] [[ch12-GDB深度实战]] [[ch15-内存问题排查三板斧]]
