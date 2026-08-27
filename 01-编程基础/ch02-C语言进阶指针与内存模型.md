---
title: "第2章 C 语言进阶：指针与内存模型"
tags:
  - domain/fundamentals
  - topic/c-language
  - topic/memory-model
difficulty: 3
est_minutes: 25
part: "[[P1-MOC]]"
chapter: 2
prerequisites: ["[[ch01-导学与能力地图]]"]
related: ["[[ch06-链接器与内存布局]]", "[[ch15-内存问题排查三板斧]]", "[[ch58-字符设备驱动hello-drv到并发安全]]"]
has_lab: true
cssclasses: [wide-page]
---
# 第2章 C 语言进阶：指针与内存模型

> [!info] 导航
> ⏱ 25min | ★★★☆☆ | 前置 [[ch01-导学与能力地图]] | → [[ch06-链接器与内存布局]] [[ch15-内存问题排查三板斧]]

## 🎯 学习目标

- [ ] 画出任意 C 程序的内存五段布局
- [ ] 掌握指针四层功力：解引用/二级指针/函数指针/void*
- [ ] 识别 90% 的未定义行为(UB)陷阱

## 内存五段布局

```
高地址 ┌── 栈 Stack（局部变量，向下生长）
       │      ↓ ↓ ↓
       │   （空洞）
       │      ↑ ↑ ↑
       │── 堆 Heap（malloc 向上生长）
       ├── .bss（未初始化全局/static，启动清零）
       ├── .data（已初始化全局，初值存Flash）
       ├── .rodata（const/字符串常量）
低地址 └── .text（机器码+向量表）
```

## 指针四层功力

| 层 | 内容 | 典型应用 |
|----|------|----------|
| L1 | 解引用与算术 `p++` 移动 sizeof(type) | 寄存器映射 |
| L2 | 二级指针/数组退化 | 多维数组传参 |
| L3 | 函数指针=回调机制之母 | 驱动 file_operations |
| L4 | void* 泛型+strict aliasing | memcpy/协议解析 |

## 关键字深挖

| 关键字 | 正确语义 | 高频坑 |
|--------|----------|--------|
| volatile | 每次真实访存 | 不提供原子性！不保证顺序！ |
| const | 只读修饰 | 放 Flash 取决于链接脚本 |
| static | 文件内私有 | 三种用法不可混淆 |

## UB 清单（编译器合法谋杀）

- 有符号溢出 → 编译器假定不发生删除分支
- 移位 ≥ 位宽 → 结果不可预测
- 解引用空/野指针 → HardFault/SIGSEGV
- strict aliasing 违规 → -O2 下数据错乱

> [!danger] 对策三板斧
> `-Wall -Wextra -Werror` + `-fsanitize=undefined,address` + Code Review 对照清单

## 排故速查

| 现象 | 根因 | 对策 |
|------|------|------|
| 加打印就好了 | 时序变化掩盖竞态 | -O0/-O2 对比+LA 实测 |
| 结构体成员读到乱码 | 缺 packed 或端序不一致 | offsetof 逐一核对 |
| 中断标志主循环看不到 | 缺 volatile | 反汇编确认 load 是否被优化 |

## ❓ FAQ

**Q: volatile 和锁的关系？**
volatile 管「可见性」，锁管「原子性」，屏障管「顺序性」——三者互不替代。

---

🏷️ #c-language #memory #ub | 🔗 [[ch03-C工程化预处理与定点数]] ← **本章** → [[ch04-CPP嵌入式子集与RAII]] | 📚 [[P1-MOC]]
