---
title: "附录B 工具命令速查卡"
tags:
  - topic/toolchain
  - topic/debugging
description: "全库高频命令速查：GCC/GDB/OpenOCD/probe-rs/Linux/iproute2/can-utils/i2c-tools/ESP-IDF/git，按使用频率组织的肌肉记忆清单"
created: 2025-01-15
---
# 附录B · 工具命令速查卡

> 按使用频率排序的肌肉记忆清单。建议打印贴墙或做成 IDE snippet；命令均在表格内以反引号包裹，含管道符处已转义。

## 编译烧写调试（GCC 工具链）

| 命令 | 作用 | 备注 |
|------|------|------|
| `arm-none-eabi-size fw.elf` | 查看 text/data/bss 总览 | Flash/RAM 预算第一步 |
| `arm-none-eabi-nm --size-sort -r fw.elf \| head` | 大符号 TOP 排行 | 找内存大户 |
| `arm-none-eabi-objdump -dS fw.elf > fw.asm` | 源码混合反汇编 | 定位优化行为差异利器 |
| `arm-none-eabi-readelf -d app \| grep NEEDED` | 列动态依赖 | 排查库缺失 |
| `addr2line -e fw.elf 0x08001234` | 地址 → 源码行号 | Oops/HardFault 反解必备 |
| `gcc -E main.c \| less` | 只看宏展开结果 | 验证宏与条件编译 |
| `make V=s` / `make -j8` / `make flash` | 详细日志 / 并行编译 / 烧写 | 构建三连 |

## GDB 高频

| 命令 | 作用 | 备注 |
|------|------|------|
| `target remote :3333` → `monitor reset halt` → `load` | 连接探针、复位停机、下载 | OpenOCD 标准起手式 |
| `b main ; c ; n/s ; bt full ; info locals` | 断点、继续、单步、全栈帧回溯、局部变量 | 日常调试主循环 |
| `watch *(uint32_t*)0x20001a3c` | 数据断点抓踩内存 | 变量被谁改了就 watch 谁 |
| `x/16xw addr ; p/x var ; disassemble func` | 查内存 / 查变量 / 反汇编 | 十六进制视图定位越界 |
| `set follow-fork-mode child ; info threads ; thread N` | 跟随 fork 子进程、列线程、切线程 | Linux 多进程/多线程场景 |

## OpenOCD 与 probe-rs

| 命令 | 作用 | 备注 |
|------|------|------|
| `openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -c "program fw.elf verify reset exit"` | 一条命令烧写+校验+复位+退出 | 脚本化烧录首选 |
| `probe-rs download --chip STM32F407ZGTx fw.elf` | 现代烧写工具下载固件 | 无需 cfg 文件 |
| `probe-rs rtt --chip STM32F407ZGTx` | RTT 日志直读 | 不占用 UART |

## Linux 设备树 · 总线 · 模块

| 命令 | 作用 | 备注 |
|------|------|------|
| `dtc -I fs /proc/device-tree > cur.dts` | 导出运行态设备树为源码 | 对照 dts 改动是否生效 |
| `lsmod` / `modinfo xx.ko` | 已加载模块列表 / 模块信息 | insmod/rmmod/modprobe 三兄弟 |
| `lspci -tvvv` | PCI 树状拓扑详情 | PCIe 排障入口 |
| `lsusb -t` | USB 树状拓扑 | 看枚举速率与层级 |
| `i2cdetect -y -r 1` | 扫描 I2C 总线 1 上设备地址 | 总线锁死时全地址 UU/`--` |
| `gpiodetect` / `gpioinfo gpiochip0` | 列 GPIO 控制器 / 行明细 | 新字符设备接口 gpiod |
| `gpioset gpiochip0 17=1` | 命令行拉高引脚 | 快速验证硬件回路 |

## 性能与追踪

| 命令 | 作用 | 备注 |
|------|------|------|
| `top -H -p PID` | 按线程视图观察指定进程 | 定位吃 CPU 的线程 |
| `pidstat 1` / `vmstat 1` / `iostat -x 1` | 进程/内存/IO 每秒采样 | 三板斧粗定位 |
| `perf top -g` | 实时热点函数（带调用图） | 先看再录 |
| `perf record -F99 -a -g -- sleep 10` → `perf report` | 全系统采样 10 秒后出报告 | 低频采样降开销 |
| `strace -c -f ./app` | 系统调用统计汇总 | `-f` 跟随子进程 |
| `ltrace ./app` | 库函数调用跟踪 | 动态库级排障 |
| `trace-cmd record -e sched sleep 5` → `kernelshark trace.dat` | 抓调度事件并可视化 | ftrace 图形前端 |
| `systemd-analyze blame` / `critical-chain` | 启动耗时排行 / 关键链路 | 开机提速抓手 |

## 网络与总线工具

| 命令 | 作用 | 备注 |
|------|------|------|
| `ip -br a` | 地址简要视图 | iproute2 取代 ifconfig |
| `ss -tlnp` | 监听端口与进程映射 | 取代 netstat |
| `ethtool eth0` | 网口速率/双工/链路状态 | 物理层先排查 |
| `tcpdump -i eth0 -w cap.pcap host 1.2.3.4 and port 502` | 抓包存盘供 Wireshark 分析 | 过滤条件前置减体积 |
| `candump can0` | 监听 CAN 总线报文 | can-utils 入门第一命令 |
| `cansend can0 123#DEADBEEF` | 发送标准帧测试 | ID#数据十六进制 |
| `iw dev wlan0 station dump` | 查看关联站点链路信息 | 信号强度/速率 |
| `wpa_cli status` | wpa_supplicant 当前状态 | WiFi 认证排障 |

## 内核取证

| 命令 | 作用 | 备注 |
|------|------|------|
| `dmesg -Tw` | 实时内核日志带可读时间戳 | 挂一个终端常开 |
| `cat /proc/interrupts` | 中断计数分布 | 验证中断触发与 CPU 亲和 |
| `cat /sys/kernel/debug/gpio` | GPIO 占用全景 | 谁抢走了这个脚 |
| `devmem 0x0209C000` | 用户态裸读寄存器 | 对照参考手册验证配置 |
| `echo c > /proc/sysrq-trigger` | 主动 panic | 测试 kdump/ramoops 链路 |

## ESP-IDF 与仪器肌肉记忆

| 命令/动作 | 作用 | 备注 |
|-----------|------|------|
| `idf.py build flash monitor` | 构建→烧写→串口监视一条龙 | `Ctrl+]` 退出 monitor |
| `idf.py menuconfig` / `size-components` / `confserver` | 图形配置 / 分组件体积 / 配置下载服务器 | size-components 查膨胀 |
| `esptool.py flash_id` / `--port COM5 erase_flash` | 读 Flash 信息 / 全片擦除 | 变砖救急手段 |
| ESP32 混杂模式 sniffer | `esp_wifi_set_promiscuous(true)` 输出 rtap 给 Wireshark | 空口抓包分析 |
| 示波器 | Comp 探头补偿 → Normal 触发+电平 → Single 单次抓事件 | 先补偿再测量 |
| 逻辑分析仪 | PulseView 选 fx2lafw → ≥6× 总线速率采样 → Add decoder | 采样率不足必误码 |
| 频谱仪 | TinySA sweep+maxhold 扫信道占用；NanoVNA 先校准再测 S11 | 不校准的数据没有意义 |

## Git 与工程化微清单

| 命令/约定 | 作用 | 备注 |
|-----------|------|------|
| `git log --oneline --graph --all -20` | 分支图概览最近提交 | 日常回顾 |
| `git diff HEAD~1 --stat` | 上次提交改动统计 | 评审前自查 |
| `git bisect start/good/bad/reset` | 二分定位引入 Bug 的提交 | 自动化测试配合更佳 |
| `git submodule update --init --recursive` | 拉齐全部子模块 | 克隆后第一步 |
| CI 三件套门禁 | `-Werror` 构建 + Unity 主机测试 + cppcheck warning=error | 合并不达标即拦截 |

---
🏷️ #appendix #reference | 📚 [[附录-MOC]]
