---
title: "第52章附录 reL4 快速上手指南"
part: "[[P5-MOC]]"
chapter: 52
tags:
  - domain/rtos
  - topic/microkernel
  - topic/sel4
  - topic/devops
difficulty: 2
est_minutes: 20
prerequisites:
  - "[[ch52a-seL4基本介绍与设计原则]]"
related:
  - "[[ch52b-reL4异步微内核设计与实现]]"
  - "[[ch52e-reL4内核实现启动SMP与MCS]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第52章附录 reL4 快速上手指南

> [!info] 导航
> ⏱ 20min | ★★☆☆☆ | 前置 [[ch52a-seL4基本介绍与设计原则]] | 实践篇

## 🎯 学习目标
- [ ] 搭建 reL4 开发环境（Docker / 本地）
- [ ] 使用 rel4-cli 工具构建和运行 reL4
- [ ] 运行 sel4test 测试套件验证内核正确性
- [ ] 运行 monolithic kernel 测试

## 一、开发环境

### 1.1 Docker 环境（推荐）

reL4 提供 Docker 镜像，包含所有编译依赖：

```bash
# 拉取镜像
docker pull rel4team/rel4-dev:latest

# 启动容器
docker run -it --rm \
  -v $(pwd):/workspace \
  rel4team/rel4-dev:latest \
  /bin/bash
```

### 1.2 本地环境

需要安装：
- Rust 工具链（nightly）
- `cargo-binutils`、`cargo-xbuild`
- QEMU（aarch64 / riscv64）
- CMake、ninja
- 交叉编译工具链（aarch64-linux-gnu / riscv64-unknown-elf）

```bash
# 安装Rust nightly
rustup install nightly
rustup component add rust-src llvm-tools-preview

# 安装cargo工具
cargo install cargo-binutils cargo-xbuild
```

### 1.3 LXC 环境

也可使用 LXC 容器隔离开发环境，避免污染本地系统。

## 二、rel4-cli 工具

`rel4-cli` 是 reL4 提供的命令行工具，简化构建和运行流程。

```bash
# 查看帮助
rel4-cli --help

# 构建 reL4 内核（aarch64）
rel4-cli build --arch aarch64

# 构建并在 QEMU 中运行
rel4-cli run --arch aarch64 --platform qemu

# 清理构建产物
rel4-cli clean
```

## 三、运行 sel4test

sel4test 是 seL4 官方的测试套件，用于验证内核实现的正确性。reL4 兼容 sel4test。

```bash
# 构建 sel4test
rel4-cli test sel4test --arch aarch64

# 在 QEMU 中运行
rel4-cli run sel4test --arch aarch64
```

测试覆盖：
- 能力操作（Copy/Mint/Delete/Revoke）
- IPC 通信（同步/异步）
- 内存管理（untyped/retype）
- 调度与优先级
- 中断处理
- SMP 多核

## 四、运行 Monolithic Kernel 测试

reL4 还支持在微内核之上运行宏内核服务（如 ArceOS）的测试：

```bash
# 构建 monolithic kernel 测试
rel4-cli test monolithic --arch aarch64

# 运行
rel4-cli run monolithic --arch aarch64
```

## 五、支持的平台

| 架构 | 平台 | 状态 |
|------|------|------|
| AArch64 | QEMU virt | ✅ 完整支持 |
| AArch64 | 树莓派4 | ✅ 支持 |
| RISC-V | QEMU virt | ✅ 完整支持 |
| RISC-V | HiFive Unmatched | 🔶 部分支持 |

> [!note] 架构支持
> reL4 同时支持 aarch64 和 riscv64，组件化设计使得架构相关代码与通用逻辑清晰分离。

## 六、开发调试

### 6.1 调试输出

reL4 内核通过串口输出调试信息，QEMU 中默认重定向到 stdio。

### 6.2 GDB 调试

```bash
# 启动 QEMU GDB server
qemu-system-aarch64 -s -S ...

# 另一个终端连接
aarch64-linux-gnu-gdb \
  -ex "target remote :1234" \
  -ex "file build/kernel.elf"
```

## 七、延伸阅读

- reL4 架构设计：[[ch52c-reL4架构设计组件化内核]]
- 内核实现细节：[[ch52e-reL4内核实现启动SMP与MCS]]
- ArceOS 移植：[[ch52f-ArceOS微内核移植实战]]
- 官方文档：[reL4 Docs](https://rel4team.github.io/zh/)

> [!info] 参考来源
> 本文整理自 [reL4 官方文档 - 快速开始与环境配置](https://rel4team.github.io/zh/docs/quick_start/)。
