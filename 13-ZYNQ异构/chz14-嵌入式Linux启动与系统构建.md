---
title: "嵌入式Linux启动与系统构建"
date: 2025-09-09
category: "ZYNQ异构"
tags: ["ZYNQ", "Linux", "U-Boot", "内核", "PetaLinux", "rootfs"]
description: "Linux开发环境、启动流程深度剖析、U-Boot编译移植、BOOT.BIN制作、内核编译、设备树基础、PetaLinux全流程、根文件系统与BusyBox"
---

# 嵌入式Linux启动与系统构建

> Linux开发环境、启动流程深度剖析、U-Boot编译移植、BOOT.BIN制作、内核编译、设备树基础、PetaLinux全流程、根文件系统与BusyBox

## 目录

1. [[#嵌入式 Linux 开发环境准备|嵌入式 Linux 开发环境准备]]
2. [[#启动流程深度剖析|启动流程深度剖析]]
3. [[#U-Boot 编译移植与 BOOT.BIN 制作|U-Boot 编译移植与 BOOT.BIN 制作]]
4. [[#内核编译与设备树基础|内核编译与设备树基础]]
5. [[#PetaLinux 全流程实战|PetaLinux 全流程实战]]
6. [[#根文件系统与 BusyBox|根文件系统与 BusyBox]]

---

## 第11章 嵌入式 Linux 开发环境准备
补齐 Linux 操作基本功 + 建立「宿主机 ⇄ 目标机」的交叉开发工作流。

**🎯 学习目标**
- 掌握嵌入式开发必需的 Linux 命令最小集
- 理解交叉编译三元组与 sysroot 概念
- 搭好 NFS/TFTP 快速迭代工作流（后续每章都在用）

### 11.1 给裸机工程师的 Linux 速成包
只需以下命令就能支撑本课程，遇到再查手册即可：

| 类别 | 命令 | 一句话说明 

| 文件 | `ls -la / cp -r / mv / rm -rf` | 列表（含隐藏）/ 复制 / 移动 / 删除（危险，看清路径） 

| `find . -name "*.c" | xargs grep -n "foo"` | 全工程搜索代码的黄金组合 

| `tar czf x.tgz dir / tar xzf x.tgz` | 压缩打包 / 解压 

| `df -h / du -sh *` | 磁盘剩余 / 目录占用（PetaLinux 排空间必备） 

| 文本 | `cat / less / head / tail -f / echo "a" > f / nano|vim` | 查看、追加、编辑；`tail -f /var/log/syslog` 盯日志 

| 进程 | `ps aux / top / kill -9 PID / jobs fg bg` | 查看与终止；Ctrl+C 终止前台任务 

| 权限 | `chmod +x f / chown user:grp f / sudo` | 可执行位、属主、临时提权 

| 网络 | `ping / ip a / ssh user@host / scp f host:path` | 连通性、地址、远程登录、远程拷贝 

| 构建 | `make / cmake .. && make -j8` | 课程所有第三方库都靠它编译 

⚠️ 新手三大坑
① **大小写敏感**：`Hello.c` 与 `hello.c` 是两个文件；② **换行符**：Windows 的 CRLF 会让 shell 脚本报 `\r: command not found`，VSCode 右下角切换为 LF；③ **别用 root 日常操作**：误删系统目录没有后悔药。

### 11.2 交叉开发模型

| 概念 | 解释 | 本课程对应 

| 宿主机 Host | 跑编译器的机器 | Ubuntu 虚拟机（x86_64） 

| 目标机 Target | 运行产物的机器 | ZYNQ 板卡（armv7-a） 

| 交叉编译器 | 在 A 架构上生成 B 架构代码的工具链 | `arm-xilinx-linux-gnueabi-gcc`（PetaLinux SDK 提供） 

| 三元组 Triplet | arch-vendor-os[-libc] 描述目标环境 | cortexa9t2hf-neon-xilinx-linux-gnueabi（t2hf=thumb2硬浮点） 

| sysroot | 目标机头文件+库的镜像目录，供链接期使用 | SDK 安装后生成，gdb 远程调试也要它（第24章） 

📌 铁律
给板卡编的一切程序都必须用**交叉编译器**。误用本机 gcc 编译出的 ELF 在板卡上报 `Exec format error`。验证方法：`file a.out` 应显示 *ARM / EABI5*。

### 11.3 安装 PetaLinux SDK（独立于工程的工具链）
```
# 工程构建成功后导出 SDK（第15章会做）；也可直接用 PetaLinux 自带链路。
# 安装到 ~/work/sdk：
./petalinux-sdk.sh ./ -d "~/work/sdk"        # 交互确认后解压安装
source ~/work/sdk/environment-setup-cortexa9t2hf-neon-xilinx-linux-gnueabi
$CC --version                                 # arm-xilinx-linux-gnueabi-gcc
echo 'int main(){return 0;}' > t.c && $CC t.c -o t && file t
#   t: ELF 32-bit LSB executable, ARM, EABI5 ... dynamically linked
```

### 11.4 两大快速迭代工作流（背下来）
#### ① TFTP 拉内核
```
# Ubuntu: 把编译产物丢进 TFTP 目录
cp images/zImage images/*.dtb /tftpboot/
# 板卡 U-Boot 串口下：
setenv serverip 192.168.2.20; setenv ipaddr 192.168.2.30
setenv bootargs 'console=ttyPS0,115200 root=/dev/nfs nfsroot=192.168.2.20:/home/user/work/rootfs rw ip=192.168.2.30'
tftpboot 0x10000000 zImage && tftpboot 0x11000000 system.dtb
bootz 0x10000000 - 0x11000000
```
#### ② NFS 挂根文件系统
上面 bootargs 中 `root=/dev/nfs` 已指定：内核起来后不挂 SD 卡，而是把 Ubuntu 的 `~/work/rootfs` 当作自己的根目录。**从此改应用 = 改 Ubuntu 里一个文件 = 板卡立即生效**，无需反复烧卡——这是嵌入式 Linux 效率的分水岭。

### 11.5 主机侧辅助工具清单

- 终端复用：`tmux`（断线不丢现场）；
- Windows↔VM 文件互通：VSCode Remote-SSH 直接编辑虚拟机内代码（首推）或 samba 共享；
- 代码阅读：VSCode + C/C++ 插件，打开 `apps/` 与内核源码目录分别建 workspace；
- 版本管理：每个实验一个 Git 仓库，commit message 写清「改了什么、为什么」。

### 常见问题 FAQ（避坑指南）
Q1：source 环境脚本后 $CC 还是空的？environment-setup 脚本必须在 bash 下 source（不能 sh），且不要嵌套 source 多个 SDK。检查 `echo $0` 是不是 bash；另外脚本会设置 OECORE 相关变量，新开终端需重新 source。

Q2：scp 到板卡报 Permission denied？目标路径无写权限或未开 SSH。rootfs 默认 root 无密码时部分 sshd 拒绝 root 登录：临时用非 root 用户，或在镜像配置里允许 PermitRootLogin（仅限实验网）。

Q3：虚拟机休眠恢复后时间错乱导致 make 报时钟警告？安装 open-vm-tools 并开启时间同步；一次性修正：`sudo hwclock -s` 或 ntpdate。make 的 "Clock skew detected" 即此因。

**🧪 动手实验 L11-1：交叉开发链路验收**
① 安装 SDK 并用 file 命令确认产物为 ARM ELF；② 写 hello.c 打印参数个数与 argv 内容，交叉编译后拷入 `~/work/rootfs/usr/bin/`（现在可以先放普通目录占位）；③ 在 Ubuntu 中练习 find|xargs 组合，统计 PetaLinux 安装目录下有多少个 `*.bb` 配方文件。

**📝 思考题**
- 为什么不能直接在板卡上装 gcc 自编译？（提示：资源、速度、依赖管理三方面）
- t2hf 中 hard-float 与 soft-float 的区别是什么？混用两种 ABI 编译的库会发生什么？
- NFS root 时如果拔掉网线，系统会出现什么现象？这对产品化部署意味着什么？

### 11.6 深潜：Shell 脚本十分钟上手（自动化从这里开始）
课程后半段大量使用脚本（烧卡、打包、回归测试），这里给出支撑你读懂并改写它们的全部语法：

```
#!/bin/bash                       # shebang：指定解释器
set -euo pipefail                 # 出错即退/未定义变量报错/管道任环节点失败即败 —— 脚本安全三件套

BOARD_IP=${1:-192.168.2.30}       # 第一个参数，缺省值
APP=$2

echo "[1] build..."
make -j$(nproc) || { echo "build failed"; exit 1; }   # || 分支 + {} 组合

for f in *.ko; do                  # for 循环通配
    scp "$f" root@$BOARD_IP:/usr/bin/    # 引号包裹防空格炸裂
done

if grep -q "ARM" <(file $APP); then   # 进程替换 + 条件判断
    echo "cross-compiled OK"
fi

function deploy() {                # 函数与返回值
    ssh root@$BOARD_IP "killall plc_runtime; insmod $1"
    return $?                      # 0 成功惯例
}
deploy plc_led.ko
echo "exit=$?"                     # 上条命令返回码：0真 非0假
```

### 11.7 深潜：Makefile 与 CMake 最小集

| Makefile 要素 | 示例 | 说明 

| 规则三件套 | `target: deps<br><TAB>command` | 命令行前必须是 TAB 不是空格（第一大坑） 

| 自动化变量 | $@ 目标 / $^ 全部依赖 / $< 第一个依赖 | - 

| 伪目标 | `.PHONY: clean all` | 防止同名文件干扰 

| 变量与展开 | `CC ?= gcc` / `:= 立即 = 递归` | ?= 允许命令行覆盖 

```
# CMake 交叉编译模板 toolchain.cmake（SDK 环境下亦可省略此步）
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR arm)
set(tools ~/work/sdk/sysroots/x86_64-oesdk-linux/usr/bin/arm-xilinx-linux-gnueabi)
set(CMAKE_C_COMPILER   ${tools}/arm-xilinx-linux-gnueabi-gcc)
set(CMAKE_CXX_COMPILER ${tools}/arm-xilinx-linux-gnueabi-g++)
set(CMAKE_SYSROOT      ~/work/sdk/sysroots/cortexa9t2hf-neon-xilinx-linux-gnueabi)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
# 用法：cmake -DCMAKE_TOOLCHAIN_FILE=../toolchain.cmake ..
```

### 11.8 深潜：二进制体检工具箱（排障必备八件套）

| 命令 | 回答的问题 | 高频用法 

| file | 什么架构/链接方式？ | 确认交叉产物 ARM EABI5；误用本机编译立现 

| readelf -h/-l/-d | 入口地址/程序头/动态依赖 | `readelf -d app | grep NEEDED` 查缺哪些 so；interpreter 看 ld-linux 路径 

| nm / nm -D | 符号表（未 strip 时） | 查 Undefined 符号定位缺库；-D 只看导出 

| objdump -d | 反汇编 | 配合 addr2line 定位崩溃 PC（25章） 

| ldd | 运行期能否找到所有库 | 主机模拟检查；板上可用 ldd 或 readelf 替代 

| size | text/data/bss 各多大 | 评估 OCM 放不放得下 

| strings | 内嵌字符串 | 快速确认版本串/路径是否编进去了 

| strip | 瘦身发布 | 保留带符号副本供 gdb（24章纪律） 

### 11.9 深潜：Git 最小工作流（个人研发也必须）
```
git init && git add -A && git commit -m "feat: plcio lib skeleton"
git switch -c feat-dma-ring        # 功能分支
# ...开发...
git add -p                          # 分块暂存，只提交相关改动
git commit -m "fix(dma): align buffer to cache line"
git log --oneline --graph -12       # 回顾历史
git tag v0.1-plc-m3                 # 里程碑打标（对应课程 M1~M6）
git diff v0.1 --stat                # 版本间差异概览
```
💡 .gitignore 基础模板（嵌入式工程）
`*.o *.ko *.cmd *.elf.tmp .cache/ build/ runs/ *.bit?(按需) *.log` —— 但 **.bit/.elf 若属交付物则入库**；原则：源码必进，中间产物不进，最终交付物打 tag 存 release。

[← 上一篇第10章 PS+PL协同设计综合实验](#ch10)
[下一篇 →第12章 启动流程深度剖析](#ch12)

---

## 第12章 启动流程深度剖析
嵌入式工程师的分水岭：能不能对着一屏串口输出，立刻判断系统死在哪一级。本章给你这张「排障地图」。

**🎯 学习目标**
- 完整掌握 BootROM → FSBL → U-Boot → Kernel → 用户态 五级链条
- 理解 BOOT.BIN 的构成与 bootgen 打包机制
- 能根据串口现象秒级定位启动失败阶段

### 12.1 五级火箭总览

① BootROM128KB 固化代码采样 BOOT 引脚读首镜像→OCM
② FSBLOCM 内运行ps7_init 时钟/DDR加载bit+U-Boot
③ U-BootDDR 内运行env/bootcmd载内核+DTB
④ Linux Kernel解析设备树驱动 initcall挂载 rootfs
⑤ 用户态init/systemd服务脚本login / 应用
- 

存储介质QSPI Flash / SD/eMMCBOOT.BIN · zImage · dtb · rootfs
PL bitstream 加载时机FSBL 经 PCAP 写入 PL（PCAP 模式）或开发期由 PCAP/JTAG 单独下载
JTAG 启动模式特例BootROM 空转等待，全部由主机接管：Vitis/XSCT 逐个加载 fsbl→bit→elf
每一级的「交接物」：ROM→FSBL：控制权 + OCM；FSBL→U-Boot：初始化好的 DDR + PCAP 完成的 PL；
U-Boot→Kernel：内存中的 zImage/dtb + bootargs；Kernel→init：就绪的驱动框架与根文件系统。

图12-1 ZYNQ Linux 启动五级链

### 12.2 第①级：BootROM（不可修改的地基）

芯片内部固化，上电后 CPU0 从 `0xFFFF0000` 开始执行；核1 自旋等待被唤醒（Linux SMP 时才启动）。
- 读取 MIO 上的 **BOOT_MODE[4:0]** 电平决定启动设备：`QSPI / NOR / NAND / SD(eMMC) / JTAG` —— 对应板上拨码开关。
- 从介质**固定偏移**读取 boot 镜像头（字节数、目标地址、执行入口、镜像数），把第一个镜像（必须是 FSBL）搬进 **OCM** 并跳转。
- JTAG 模式下 BootROM 不读任何介质，等待主机通过 JTAG 下发一切 —— 调试救砖的最后手段。

### 12.3 第②级：FSBL 与 BOOT.BIN 打包
FSBL（First Stage Boot Loader，通常由 Vitis 模板生成）在 OCM 里依次完成：

```
/* FSBL main() 逻辑骨架（简化）*/
ps7_init();                    /* 执行 ps7_init.c：PLL/时钟/MIO/DDR 初始化 */
LoadBitstreamFromFlash();      /* 若 boot.bin 含 .bit → 经 DevC/PCAP 配置 PL */
FsblHandoffJtagExit();         /* 关闭 DAP */
HandoffAddress = 读镜像表中下一个条目(如 u-boot.elf 入口);
FuncPtr = HandoffAddress; FuncPtr();   /* 跳交控制权 */
```
**BOOT.BIN 由 bootgen 按 BIF 描述打包**：

```
/* boot.bif —— 镜像清单 */
all:
{
    [bootloader] fsbl.elf        /* 必须第一，带 bootloader 属性 */
    design_1_wrapper.bit         /* PL 比特流（可选） */
    u-boot.elf                   /* 第三阶段 */
}
/* 命令行打包 */
bootgen -image boot.bif -arch zynq -o BOOT.BIN -w on
```
⚠️ 三个高频翻车点
① `[bootloader]` 标记丢失 → BootROM 无法识别首镜像；② 改了 PL 设计忘记更新 .bit 进 BIF → 板子跑的还是旧逻辑；③ FSBL 与 XSA 版本不配套 → DDR 参数错乱，随机死机。

### 12.4 第③级：U-Boot —— 万能瑞士军刀
U-Boot 运行于 DDR，提供交互 shell（倒计时按任意键进入）。核心概念只有两个环境变量：

| 变量 | 职责 | 示例 

| `bootcmd` | 自动启动时执行什么 | `run sdboot / run jtagspi / tftp+bootz 序列` 

| `bootargs` | 传给内核的命令行 | `console=ttyPS0,115200 root=/dev/mmcblk0p2 rw rootwait` 

```
# U-Boot 常用调试命令速查
printenv                     # 查看全部环境变量
setenv ipaddr 192.168.2.30 && setenv serverip 192.168.2.20
tftpboot 0x10000000 zImage   # 网络加载内核
mmcinfo && fatls mmc 0:1     # 查看 SD 卡 FAT 分区文件
md 0xE0001000 10             # 直读寄存器(UART1)，裸机直觉延续
sf probe 0 && sf read ...    # QSPI 操作
saveenv                      # 保存环境变量到 flash
reset                        # 复位
```

### 12.5 第④级：内核启动关键节点

- 自解压 → 使能 MMU/cache → **earlycon** 极早期打印；
- 根据 r2 寄存器传入的 **设备树(DTB)** 匹配机器、枚举外设；
- 按链接段顺序执行各驱动 `initcall`（你未来写的 platform 驱动在此 probe）；
- 挂载 rootfs（NFS 或块设备），找 PID 1；
- 打印 *"Run /sbin/init as init process"* 进入用户态。

### 12.6 第⑤级：用户态初始化
PetaLinux 默认 sysvinit + BusyBox：`/etc/inittab` 决定运行级别与 getty；`/etc/rcS.d/S*` 顺序执行服务脚本（第34章我们把 PLC 服务加进这里）；systemd 发行版则由 unit 文件管理。登录提示出现 = 五级火箭全部点火成功。

### 12.7 启动排障地图（背下来！）

| 串口现象 | 死亡阶段 | 排查方向（按概率排序） 

| 完全无任何输出 | ①之前 | 供电/拨码模式错误（最常见）/串口选错UART或波特率/BootROM找不到有效镜像（QSPI空白） 

| FSBL banner 后停止 | ①→② | .bit 损坏导致 PCAP 卡住 / 下一镜像缺失 / DDR 初始化参数错 

| U-Boot 倒计时后卡死 | ③→④ | zImage 未加载成功（tftp/mmc 路径错）/ bootargs 错误 

| Starting kernel... 后黑屏 | ④早期 | console=ttyPS0 写成 ttyPS1 或 ttyS0（Top 错误！）/ DTB 与实际硬件不符 / earlycon 可用于确认是否真死 

| Kernel panic - not syncing: VFS | ④末尾 | root= 路径不存在（分区号错）/ NFS 导出未生效 / 缺根文件系统内容 

| 有 login 却登不上 | ⑤ | /etc/passwd shadow 异常 / inittab 无 getty / 控制台权限 

### 常见问题 FAQ（避坑指南）
Q1：为什么 FSBL 必须放 OCM 且是第一个镜像？此刻 DDR 尚未初始化，唯一可用的 RAM 是 OCM；BootROM 的搬运目标地址也固定为 OCM 起点。这是硬件契约，所有 Zynq 平台一致。

Q2：能不用 U-Boot 直接引导内核吗？技术上可行（FSBL 直接跳 zImage 或用 Falcon Mode），但会失去网络加载、多方案启动、交互救援能力。教学与产品默认保留 U-Boot。

Q3：PL 的 bitstream 能不能晚一点再加载？可以。方案A：从 boot.bin 中移除 .bit，系统起来后由应用经 `/dev/fpga0`（fpgamanager）或 devcfg 驱动加载；好处是升级逻辑无需动 BOOT.BIN。本课程 PLC 采用 FSBL 阶段加载，简单可靠。

**🧪 动手实验 L12-1：绘制自己的启动时序图**
用 SD 卡正常启动一次 PetaLinux（第15章完成后补做亦可），开启串口时间戳（MobaXterm 支持 timestamp），记录每级 banner 出现时刻，计算：BootROM→FSBL、FSBL→U-Boot、U-Boot→login 各耗时。然后故意制造三种故障（改错 console 参数 / 拔掉 SD / 清空 QSPI），对照 12.7 地表写出诊断结论。

**📝 思考题**
- 双核 A9 在 BootROM 与 FSBL 阶段分别处于什么状态？核1 是何时、由谁唤醒的？
- 如果要求「按键 S1 按住时强制进入 JTAG 救援模式」，应该在 FSBL 还是 U-Boot 实现？为什么？
- 对比 NFS root 与 eMMC root 在研发期与量产期的优缺点，给出你的选型策略。

### 12.8 深潜：一份真实启动日志逐行精讲 ★
下面是 SD 卡启动的典型串口输出（节选），**逐行读懂它 = 排障能力质变**：

```
Xilinx First Stage Boot Loader               ← ②FSBL banner（编译时间戳可核对版本）
Release 2020.2  ...
PMU? no——PS 已初始化完毕，以下为 FSBL 行为日志：
Loading image at 0x08000000 ...              ← 正在搬运下一镜像(U-Boot)到DDR
Successfully loaded FPGA image.              ← .bit 经 PCAP 写入 PL 成功
Handoff Address = 0x10000000                 ← 跳交控制权地址=U-Boot入口

U-Boot 2020.01-g... (Jan 01 2024)            ← ③U-Boot banner
DRAM: 1 GiB                                  ← DDR 自检容量
Flash: 32 MiB                                ← QSPI 探测成功
MMC:   sdhci@e0100000: 0                     ← TF卡控制器枚举
In: serial Out: serial Err: serial           ← 三路标准IO绑定到UART1
Net:   eth0: ethernet@e000b000               ← GEM0 网卡(注意与板卡实际口对应)
Hit any key to stop autoboot: 0              ← bootdelay 倒计时
reading zImage ... OK                        ← bootcmd 第一步：FAT 读内核
## Loading kernel from FIT Image? no——bootz 直启：
Starting kernel ...                          ← ④交接！之后是内核接管

Booting Linux on physical CPU 0x0            ← 内核第一行（解压后）
Linux version 5.4.0-xilinx...                ← 版本串与主机构建信息
CPU: ARMv7 Processor [413fc090] ...          ← A9 识别、特性寄存器
Memory: 1023768K available                   ← memblock 统计后可用内存
clocksource/arch_timer? (省略大量子系统初始化)
Serial: AMBA PL011 UART driver? → xuartps    ← 你的 console 驱动上线
...
Run /sbin/init as init process               ← ⑤内核谢幕，用户态登场
INIT: version 2.88 booting                   ← busybox init 开始跑 rcS
Starting network: eth0 ... udhcpc? 或静态IP  ← 服务逐个启动
PetaLinux System? login prompt:              ← getty 就绪
navigator login:
```

| 日志特征 | 所处阶段 | 卡住时的怀疑点 

| 无任何输出 | ①之前/① | 供电·拨码·波特率·BootROM找不到有效镜像（12.7地表） 

| FSBL banner 后停 | ②→③ | .bit损坏(PCAP挂)/下一镜像缺失/DDR参数错 

| Starting kernel 后黑屏 | ④早期 | console=ttyPS0 参数错(Top1!)/DTB不匹配 → 加 earlycon 抢救 

| panic: VFS unable to mount | ④末 | root= 分区号错/NFS导出未生效 

### 12.9 深潜：安全启动（Secure Boot）概念链

- **目标**：确保 BOOT.BIN 未被篡改且来自授权方 —— 防克隆+防植入；
- **机制三层**：① **签名**：bootgen 用 RSA-2048 私钥对各分区签名，BootROM 用公钥哈希（烧录在 eFUSE 的 PPK hash）验证；② **加密**：AES-256-GCM 对 bitstream/分区加密，密钥存 eFUSE 或 OCM（BBRAM）；③ **eFUSE 一次性编程**锁死安全策略；
- **工程现实**：启用前先在开发期用未加固流程稳定量产逻辑；eFUSE 编程不可逆，操作前务必双签审批。学习层面掌握「信任根 Root of Trust → 逐级验签」模型即可迁移到任何 SoC。

### 12.10 深潜：FSBL 内部阶段表 与 XIP 概念

| FSBL 阶段 | 动作 | 失败现象 

| P1 平台初始化 | 执行 ps7_init：MIO/PLL/DDRC 时序训练 | 无后续任何日志；LED 心跳异常 

| P2 镜像解析 | 读 boot 头部表，遍历分区属性(O_EXEC/O_BOOTLOADER…) | "Invalid Boot Header" 

| P3 PL 配置 | PCAP 写 .bit，等待 PCAP_DONE 置位 | 卡死在 "Loading FPGA..." 

| P4 下一镜像加载 | FAT/裸区读取 U-Boot 至 DDR | "Can't read image" 

| P5 交接 | 关 DAP/JTAG 安全设置→函数指针跳转 | 直接跳过③banner 

**XIP（eXecute In Place）**：QSPI 支持 memory-mapped 直读执行，U-Boot SPL 可配置从 QSPI XIP 运行以省拷贝时间；代价是 SPI 带宽限制执行速度。理解 XIP 有助于读懂部分产品的「快速上电」设计。

[← 上一篇第11章 嵌入式Linux开发环境准备](#ch11)
[下一篇 →第13章 U-Boot编译移植与BOOT.BIN制作](#ch13)

---

## 第13章 U-Boot 编译移植与 BOOT.BIN 制作
亲手编译三级火箭的第三级，并组装出第一个完全自制的 BOOT.BIN。

**🎯 学习目标**
- 独立完成 Xilinx U-Boot 2020.2 的配置与编译
- 掌握 bootgen 打包 BOOT.BIN 的完整手工流程
- 会用 U-Boot 命令行完成网络启动与 Flash 固化

### 13.1 获取源码
```
mkdir -p ~/work/src && cd ~/work/src
git clone https://github.com/Xilinx/u-boot-xlnx.git
cd u-boot-xlnx && git checkout xilinx-v2020.2    # 与工具链严格同版本
```

### 13.2 配置与编译
```
source ~/work/sdk/environment-setup-cortexa9t2hf-neon-xilinx-linux-gnueabi
cd ~/work/src/u-boot-xlnx
make ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- distclean
make ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- xilinx_zynq_virt_defconfig
make ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- -j$(nproc)
# 产物：u-boot / u-boot.elf / u-boot.bin / tools/mkimage
```

### 13.3 移植三板斧（面向领航者）
Xilinx 公版 defconfig 已包含 Zynq PS 全部通用驱动（串口/MMC/网口/QSPI），「移植」实际只做三件事：

- **设备树适配**：U-Boot 使用与内核同一份板级 DTS 思路。复制 `arch/arm/dts/zynq-zc702.dts` 改名 `zynq-navigator.dts`，按板卡修改：UART1 引脚、SD 控制器使能、网口 PHY 地址（RTL8211E 通常 addr 0x01，读原理图确认）、QSPI flash 型号与大小。在 `arch/arm/dts/Makefile` 注册新 dtb。
- **默认环境变量**：编辑 `configs/xilinx_zynq_virt_defconfig` 追加：
```
CONFIG_BOOTDELAY=1
CONFIG_BOOTCOMMAND="run sd_qspiboot"
CONFIG_BOOTARGS="console=ttyPS0,115200 earlycon=uart,mmio,0xe0001000"
```
- **提示符等个性化**：`CONFIG_SYS_PROMPT="navigator> "` —— 别小看它，多板混用时防呆。

重新 `make` 后用 `u-boot.elf` 参与打包。

### 13.4 组装 BOOT.BIN（手工全流程）
准备三件材料：

| 文件 | 来源 | 说明 

| `fsbl.elf` | Vitis 平台工程 `<platform>/fsbl/fsbl.elf` | 必须与当前 XSA 配套 

| `design_1_wrapper.bit` | Vivado 实现产物 | 含 PL 逻辑（可省略） 

| `u-boot.elf` | 本章 13.2 编译产物 | - 

```
# boot.bif
all:
{
        [bootloader] fsbl.elf
        design_1_wrapper.bit
        u-boot.elf
}
# 打包（Windows Vivado 命令行或 Linux 均有 bootgen）
bootgen -image boot.bif -arch zynq -o BOOT.BIN -w on
```

### 13.5 SD 卡启动验证
```
# Ubuntu 下给 TF 卡分区：p1 FAT32(≥64MB, boot) p2 ext4(rootfs)
sudo mkfs.vfat -F 32 /dev/sdb1 && sudo mkfs.ext4 /dev/sdb2
cp BOOT.BIN /media/$USER/boot/            # FAT 分区根目录即可
# 插卡 → 拨码 SD → 上电 → MobaXterm 应看到你的新提示符
```
在 U-Boot 里手动网络引导内核（第14章编好后回填此步骤）：

```
setenv serverip 192.168.2.20 && setenv ipaddr 192.168.2.30
setenv bootargs console=ttyPS0,115200 root=/dev/nfs nfsroot=192.168.2.20:/home/user/work/rootfs rw ip=192.168.2.30::192.168.2.1:255.255.255.0:navigator:eth0:off
tftpboot 0x10000000 zImage && tftpboot 0x11000000 navigator.dtb
bootz 0x10000000 - 0x11000000
```

### 13.6 固化到 QSPI（产品化路径）
```
# 方式一：U-Boot 命令行自更新
fatload mmc 0 ${loadaddr} BOOT.BIN
sf probe 0 50000000
sf erase 0x0 0x2000000
sf write ${loadaddr} 0x0 ${filesize}
# 方式二：Vitis → Xilinx Program Flash，选 BOOT.BIN 与 fsbl.elf，Offset 0
```

### 常见问题 FAQ（避坑指南）
Q1：编译报 openssl/bounds.h 相关错误？缺主机依赖：`sudo apt install libssl-dev bison flex swig python3-dev`。另确认 gcc 主机版本不过新导致的告警转错误时，可加 `KCFLAGS=-Wno-error` 应急。

Q2：U-Boot 卡在 "DRAM:" 不动？典型 DDR 参数错误 —— 你的 DTS/U-Boot 用了别家的 DDR 时序。回到第7章确认 PS DDR 配置与板卡一致，FSBL 与 U-Boot 必须使用**同一份 XSA 生成**。

Q3：saveenv 报错没有存储介质？环境变量保存位置未配置（默认可能指向 SPI）。defconfig 中启用 `CONFIG_ENV_IS_IN_SPI_FLASH` 并指定 offset（避开 BOOT.BIN 占用的前几 MB），或干脆用 `CONFIG_ENV_IS_NOWHERE` 每次由脚本注入。

**🧪 动手实验 L13-1：一键网络开发环境**
把 13.5 的手动命令固化为 U-Boot 默认行为：bootdelay=1，bootcommand 先尝试 tftp 取 `zImage/navigator.dtb` 成功即 bootz，失败回落 SD 卡。验收标准：上电 10 秒内无需人工干预进入 NFS root 的 Linux。

**📝 思考题**
- BIF 中三个镜像的排列顺序可以调换吗？为什么 bootloader 标记必须存在？
- 设计一个「双系统备份」方案：QSPI 存主系统，SD 存备份，主系统连续 3 次启动失败自动切备份。（提示：U-Boot 计数变量 + saveenv）
- mkimage 生成的 uImage 与直接 bootz 加载的 zImage 有何区别？本课程为何选 bootz？

### 13.7 深潜：U-Boot 高频命令全集速查

| 类别 | 命令 | 用途/要点 

| 信息类 | `bdinfo / version / coninfo` | 板级参数(时钟/内存基址)、版本、串口列表 

| `printenv [name]` | 查看环境变量；`env default -f -a; saveenv` 恢复出厂 

| `iminfo ${loadaddr}` | 校验镜像头(legacy uImage/FIT)完整性 

| 加载类 | `tftpboot addr file` | TFTP 下载（需先设 ipaddr/serverip） 

| `fatload/ext4load mmc 0:1 addr path` | 按文件系统类型从 SD 卡读文件 

| `sf probe 0; sf read/write/erase` | QSPI 全套操作；地址勿覆盖 BOOT.BIN 区 

| `usb start; usb storage? fatload usb 0:1` | U 盘读取（需内核侧同样支持） 

| 内存类 | `md/mw addr [val]` | 显示/写内存（.b .w .l 后缀选宽度）——寄存器调试神器 

| `cp/cmp/crc32` | 拷贝/比较/CRC 校验（验证烧写结果） 

| `itest/expr?` | 脚本条件判断（配合 hush shell 写启动逻辑） 

| 设备树与启动 | `fdt addr ${fdt_addr}; fdt print /model` | 运行期解析/修改 DTB（如临时改 console 再 bootz）★调试利器 

| `bootz kaddr - daddr` | 启 zImage+DTB（本课程）；**bootm** 启 legacy uImage/FIT；**booti** 启 Image(aarch64) 

| `bootm <fit>#conf-xc7z020.dtb? conf@1` | FIT 多配置选择（多板一镜像方案基础） 

| 维护类 | `fastboot / ums 0 mmc 0` | 把 SD 卡当 U 盘挂给 PC（ums）—— 免拔卡改文件 ★ 

| `reset / poweroff? sleep / test` | - 

### 13.8 深潜：boot.scr 与 distro 自动启动链
硬编码 bootcmd 灵活性差，业界用**脚本镜像**：`mkimage -A arm -T script -C none -d boot.cmd boot.scr`，U-Boot 里 `load mmc 0:1 ${scriptaddr} boot.scr && source ${scriptaddr}`。脚本内可用 if 判断介质存在性依次尝试（SD→USB→网络），这就是 *distro_bootcmd* 的思想 —— 多启动源自动回退。你的产品若需「主系统损坏自动切救援系统」，在 boot.scr 层实现计数器+saveenv 即可落地。

### 13.9 深潜：U-Boot 驱动模型(DM) 与新板 checklist

- 2014+ 的 U-Boot 采用 **DM 设备模型**：uclass(类)+driver+device tree 三层，驱动声明 `U_BOOT_DRIVER(xxx)`，与内核风格趋同 —— 移植经验可部分迁移；
- 新板移植 checklist（按序）：① 复制最接近的 DTS 并改名注册 Makefile → ② defconfig 打开所需 uclass(MMC/NET/SPI) → ③ 板级头文件(旧式)或 CONFIG 默认 env → ④ DDR 参数核对（最高优先级！）→ ⑤ 编译上电逐段验证 banner。

[← 上一篇第12章 启动流程深度剖析](#ch12)
[下一篇 →第14章 内核编译与设备树基础](#ch14)

---

## 第14章 内核编译与设备树基础
设备树是嵌入式 Linux 的「硬件普通话」—— 学会它，你的驱动才有舞台。

**🎯 学习目标**
- 独立完成 Linux 5.4 (xilinx-v2020.2) 的配置与编译
- 掌握设备树语法核心：节点/属性/phandle/层级覆盖
- 会用 menuconfig 为 PLC 篇预置 UIO 等关键内核特性

### 14.1 获取、配置、编译
```
cd ~/work/src
git clone https://github.com/Xilinx/linux-xlnx.git
cd linux-xlnx && git checkout xilinx-v2020.2

source ~/work/sdk/environment-setup-cortexa9t2hf-neon-xilinx-linux-gnueabi
make ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- xilinx_zynq_defconfig
make ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- menuconfig   # 微调
# PLC 篇必开选项（搜索路径：/ 键）
#   Device Drivers → Userspace I/O drivers →
#     [*] Userspace I/O platform driver with generic IRQ handling (CONFIG_UIO_PDRV_GENIRQ)
#   Device Drivers → GPIO Support → Xilinx GPIO support (CONFIG_GPIO_XILINX)
#   Kernel hacking → Compile-time checks ... printk 调试等级按需
make ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- -j$(nproc) zImage dtbs
make ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- modules
make ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- \
     INSTALL_MOD_PATH=~/work/rootfs modules_install   # 模块装进NFS根目录
```

| 产物 | 路径 | 去向 

| zImage | `arch/arm/boot/zImage` | TFTP 目录 / SD 卡 FAT 分区 

| DTB | `arch/arm/boot/dts/zynq-*.dtb` | 同上，bootz 第二参数 

| 模块 .ko | `$INSTALL_MOD_PATH/lib/modules/<ver>/` | NFS 根文件系统 

### 14.2 设备树语法十五分钟精通
设备树(DT)是一份描述「板上有什么硬件」的数据结构，**驱动代码不再硬编码地址/中断，全部由 DT 提供**。核心语法：

```
/dts-v1/;
#include "zynq-7000.dtsi"        /* SoC 级公共描述(PS 全部外设) */

/ {
    model = "ALIENTEK Navigator ZYNQ7020";
    compatible = "alientek,navigator", "xlnx,zynq-7000";

    chosen {                       /* 启动参数入口 */
        bootargs = "console=ttyPS0,115200 earlycon";
        stdout-path = "serial1:115200n8";
    };

    memory@0 {
        device_type = "memory";
        reg = <0x0 0x40000000>;    /* 1GB DDR */
    };

    /* 板载 LED：复用内核通用 gpio-leds 驱动 */
    leds {
        compatible = "gpio-leds";
        led0 {
            label = "pl_led0";
            gpios = <&gpio0 54 GPIO_ACTIVE_HIGH>;   /* EMIO54 */
            default-state = "off";
        };
    };

    /* 用户自定义节点示例：软PLC硬件描述（第28章将扩展） */
    plc_io@43c10000 {
        compatible = "demo,plc-io-v1";      /* 驱动匹配的关键字！ */
        reg = <0x43c10000 0x1000>;          /* 基地址 + 大小 */
        interrupt-parent = <&intc>;
        interrupts = <0 29 4>;              /* SPI 类型, GIC号29+32偏移规则见下 */
        clocks = <&clkc 15>;                /* FCLK0 */
    };
};
```

| 概念 | 说明 | 速记 

| compatible | 驱动匹配字符串，platform 驱动的 of_match_table 与之比对 | 「厂商,型号」惯例 

| reg | 寄存器地址窗口；单元格数由父节点 `#address-cells/#size-cells` 决定 | PS 外设通常 <base size> 

| interrupts | <type number flags>：0=SPI 共享中断；number=GIC ID−32；flags=触发沿 | PL 中断61→写29 

| phandle 引用 | `&label` 指向其他节点（gpio0 是 dtsi 里 PS GPIO 的标签） | 跨节点连线靠它 

| status | "okay" 启用 / "disabled" 关闭 —— dtsi 默认关闭的板级打开它即可 | 最常用的覆盖手法 

💡 学习捷径
不要凭空背语法。执行 `dtc -I dtb -O dts system.dtb > all.dts` 把现有 DTB 反编译成全文，对照 UG585 地址表逐节点读懂 PS 描述 —— 一晚上胜过读十篇博客。运行期则看 `/proc/device-tree/`。

### 14.3 板级 DTS 的正确姿势：覆盖而非重写
公版 `zynq-7000.dtsi` 已把 UART/GEM/SD/QSPI 等全部定义好（多数 status=disabled）。板级文件只做三件事：**打开需要的（status="okay"）、填板级参数（PHY地址/flash型号）、追加板载器件（led/按键/自定义IP）**。第18章的 platform 驱动实验将直接消费你今天写的 `plc_io` 节点。

### 14.4 启动自编内核
```
cp arch/arm/boot/zImage arch/arm/boot/dts/zynq-navigator.dtb /tftpboot/
# U-Boot 下重复第13章 bootz 流程；进入系统后验证：
uname -r                      # 你的版本串
ls /proc/device-tree/model    # 应输出板名
uname -r                      # 你的版本串
ls /proc/device-tree/model    # 应输出板名
cat /proc/device-tree/plc_io@43c10000/compatible
# 应输出 demo,plc-io-v1 —— 设备树已生效
```

### 常见问题 FAQ（避坑指南）
Q1：改了 DTS 重新生成 dtb，板上却毫无变化？① U-Boot 加载的还是旧 dtb 文件名（tftpboot 缓存了同名旧文件）；② bootz 命令第二参数忘了更新；③ PetaLinux 工程里改的是 `components/plnx_workspace/...` 自动生成区而非 `project-spec/meta-user/recipes-bsp/device-tree/files/system-user.dtsi`（正确位置）——构建时会被覆盖。

Q2：节点写了 compatible 却没有驱动匹配，系统会怎样？什么也不发生：内核遍历设备树找不到对应驱动就静默跳过（dmesg 无报错）。这正是 DT 的解耦之美 —— 硬件描述先行，驱动后补。排查时用 `ls /sys/bus/platform/devices/` 与 dmesg | grep probe。

Q3：menuconfig 搜索到的 CONFIG 名与 .config 里对不上？搜索结果会显示「依赖链」，若依赖的父选项未开，该选项不可见。按提示先打开依赖项再回搜。保存后 diff .config.old .config 确认生效。

**📝 思考题**
- 为什么 Zynq 的 PL 自定义 IP 中断号在 DT 里要写「GIC ID − 32」？写出 IRQ_F2P 第0根(61)对应的 interrupts 三元组。
- 对比「寄存器硬编码在驱动里」与「从 DT reg 属性读取」两种写法的可移植性差异。
- 如果两个自定义 IP 节点的 reg 地址窗口重叠，会发生什么？内核有工具能发现这类冲突吗？（提示：/proc/iomem）

### 14.5 深潜：内核启动日志逐段精读 ★
```
[    0.000000] Booting Linux on physical CPU 0x0
[    0.000000] Linux version 5.4.0-xilinx (gcc 9.2.0)   ← 版本+编译器指纹
[    0.000000] CPU: ARMv7-MIDR=413fc090 ...NEON FPU?     ← 特性位解析
[    0.000000] Machine model: ALIENTEK Navigator        ← 来自 DT root 的 model
[    0.000000] Memory policy: Data cache writealloc
[    0.000000] Zone ranges: DMA normal highmem           ← 内存分区布局
[    0.000004] psci? no——Zynq 用 smp_ops/scu
[    0.000xxx] Clocks: CPU767 DDR533 IO100?              ← PLL 结果打印(PCW核对点)
[    0.1xxxxx] console [ttyPS0] enabled                  ← 控制台驱动接管(此前是earlycon)
[    0.2xxxxx] Calibrating delay loop... 1526.88 BogoMIPS← 频率旁证(≈767MHz/5)
[    0.3xxxxx] gpio-xilinx? / zynq-gpio e000a000: ...    ← 设备逐个 probe 的证据流
[    0.4xxxxx] macb e000b000 eth0: Cadence GEM rev ...
[    0.5xxxxx] mmc0: SDHCI controller on e0100000
[    1.2xxxxx] VFS: Mounted root (nfs filesystem) on device 0:11
[    1.3xxxxx] devtmpfs: mounted / Freeing unused kernel memory: 1024K
[    1.4xxxxx] Run /sbin/init as init process            ← 内核使命完成
```
精读要点：① **时间戳跳变处**往往藏着慢设备（如 PHY 自协商 ~1-3s）；② probe 失败通常只打一行 warn 不致命，用 `initcall_debug` 可强制每条 initcall 打印耗时；③ "Freeing unused kernel memory" 标志 `__init` 段释放 —— 内核把一次性初始化函数放特殊段的资源智慧。

### 14.6 深潜：Kconfig 与内核构建语法最小集
```
# drivers/plc/Kconfig
menuconfig PLC_SUPPORT
    tristate "PLC IO engine support"          # y/m/n 三态
    default n
    depends on ARM || COMPILE_TEST            # 依赖条件
    select UIO if !CHARDEV_PLC                # 自动选中依赖项
    help
      Say Y to build-in, M for module.

# drivers/plc/Makefile
obj-$(CONFIG_PLC_SUPPORT) += plc_io.o        # y→编入 vmlinux；m→模块
plc_io-y := plc_core.o plc_irq.o             # 多文件组成一个模块
```

### 14.7 深潜：initcall 分级机制与调试法

- 链接脚本把 `core_initcall…late_initcall`(0~7级) 的函数指针集中成数组段；启动时 do_initcalls() 顺序遍历 —— **这就是"驱动无需手动注册即可 probe"的底层机关**；
- 调试：`initcall_debug=1` 加入 cmdline → 每条 initcall 前后打印名字与耗时，慢启动元凶无所遁形（配合39章 ftrace 更佳）；
- `module_init()` 在编入内建时映射为 device_initcall(6级) —— 同一份代码双形态的魔法所在。

### 14.8 深潜：符号导出、模块参数与版本魔数
```
EXPORT_SYMBOL(plc_register_client);        /* 供其他模块调用 */
EXPORT_SYMBOL_GPL(plc_internal_helper);    /* 仅GPL模块可用——许可证防火墙 */

static int period_ms = 10;
module_param(period_ms, int, S_IRUGO|S_IWUSR);   /* insmod x.ko period_ms=20 */
MODULE_PARM_DESC(period_ms, "scan period in ms");

MODULE_LICENSE("GPL");   /* 缺失则 taint kernel 'P' 且禁用 GPL-only 符号 */
/* vermagic 校验：uname版本+SMP+抢占模型必须一致(17章Q1根因) */
/* modinfo x.ko 查看 vermagic/parm/author 全套元数据 */
```

### 14.9 深潜：设备树 Overlay（动态改树）
PL 逻辑可重载（fpga manager），硬件描述也应能动态更新 —— 这就是 overlay：

```
# 编译：需要主 dtb 提供符号表(-@ 编译选项)
dtc -@ -I dts -O dtb -o plc_overlay.dtbo plc_overlay.dts
# 运行期经 configfs 应用：
mkdir /sys/kernel/config/device-tree/overlays/plc
cat plc_overlay.dtbo > /sys/kernel/config/device-tree/overlays/plc/dtbo
cat /sys/kernel/config/device-tree/overlays/plc/status   # applied ✓
```
典型场景：FPGA 重载新 bitstream 后，用不同 overlay 挂接新的自定义 IP 节点 —— 实现「硬件热插拔」。注意 PetaLinux 默认需开启 CONFIG_OF_OVERLAY 与 symbols 支持。

### 14.10 深潜：earlycon 与 console 双阶段

- **earlycon**（如 `earlycon=uart8250,mmio32,0xe0001000? 对Zynq为 earlycon=xlnx,mmio?` 实际写法 `earlyprintk` 或 DT chosen/stdout-path）在内存管理未就绪时用**轮询直写寄存器**输出 —— 它能活过 MMU 开启前后最凶险的窗口；
- 正式 console（ttyPS0）由 uart 驱动 probe 后注册接管，两者并存期日志会重复 —— 属正常现象；
- 排障口诀：**"Starting kernel 后黑屏必加 earlycon"**，它能把死亡时间从「黑屏」精确到具体行。

[← 上一篇第13章 U-Boot编译移植与BOOT.BIN制作](#ch13)
[下一篇 →第15章 PetaLinux全流程实战](#ch15)

---

## 第15章 PetaLinux 全流程实战
有了第12~14章的手工功底，现在让 PetaLinux 把整条流水线自动化 —— 这才是工业项目的日常工具。

**🎯 学习目标**
- 掌握 PetaLinux 工程创建→配置→定制→构建→打包全链路
- 学会 system-user.dtsi / app / module 三类定制的标准姿势
- 理解其 Yocto 本质，会查日志定位构建失败

### 15.1 PetaLinux 的本质
PetaLinux 是包在 **Yocto/OpenEmbedded** 外面的工程管理器：你只维护「配置 + 少量配方(recipe)」，它负责拉源码、打补丁、编译 U-Boot/内核/rootfs、最终用 bootgen 打包。**它不替代知识，只替代重复劳动** —— 所以第二篇先手工后自动的路线是对的。

### 15.2 创建工程并导入硬件
```
source /opt/pkg/petalinux/2020.2/settings.sh
cd ~/work/plnx
petalinux-create --type project --template zynq --name plnx_demo
cd plnx_demo

# 预下载加速（强烈建议，见4.4）：编辑 project-spec/meta-user/conf/petalinuxbsp.conf 追加：
#   DL_DIR = "/home/user/work/downloads"
#   SSTATE_DIR = "/home/user/work/sstate"

petalinux-config --get-hw-description ~/work/fpga/ps_plc/xsa_dir/
# 菜单：Linux Components → u-boot / kernel 版本确认 2020.2
#       Image Packaging → Root filesystem type 先选 EXT4(SD卡默认)
#       Yocto Settings → 确认 sstate/downloads 生效
```

### 15.3 四层配置入口速查

| 要改什么 | 命令 | 落盘位置 

| 硬件级(PCW)：DDR/时钟/MIO | 回 Vivado 改 BD 重新导 XSA | -（PetaLinux 只消费） 

| U-Boot 行为 | `petalinux-config -c u-boot` | user config 片段叠加公版 

| 内核特性 | `petalinux-config -c kernel` | config 片段（diff 可见） 

| 根文件系统软件包 | `petalinux-config -c rootfs` | petalinuxbsp.conf/user-rootfsconfig 

| 设备树增补 | 直接编辑文件（见15.4） | meta-user/recipes-bsp/device-tree/files/system-user.dtsi 

### 15.4 设备树定制标准姿势（PLC 篇反复使用）
```
/* 文件：project-spec/meta-user/recipes-bsp/device-tree/files/system-user.dtsi */
/include/ "system-conf.dtsi"
#include <dt-bindings/gpio/gpio.h>

/ {
    /* 第14章写的 plc_io 节点在这里落地 */
    plc_io@43c10000 {
        compatible = "demo,plc-io-v1";
        reg = <0x43c10000 0x1000>;
        interrupt-parent = <&intc>;
        interrupts = <0 29 4>;          /* IRQ_F2P[0] = GIC61 */
    };

    /* 关闭板卡上不存在的外设，避免无谓 probe */
    /delete-node/ &nand0;
};

/* 对已有节点做小改动：追加属性即可覆盖 */
&gem1 {
    status = "okay";
    phy-mode = "rgmii-id";
    phy-handle = <&eth_phy>;
```
⚠️ 不要改自动生成区
`components/plnx_workspace/` 与 `build/` 下的一切都会被重建覆盖。所有手改只允许落在 `project-spec/meta-user/` 内 —— 这是 PetaLinux 给用户划的自留地。

### 15.5 加自己的应用与内核模块
```
# 应用（C 模板，开机可执行文件放进镜像）
petalinux-create -t apps --template install -n plcapp --enable
#   替换 project-spec/meta-user/recipes-apps/plcapp/files/plcapp.c 后：
petalinux-build -c plcapp

# 内核模块（out-of-tree .ko，随镜像安装）
petalinux-create -t modules -n plcio_drv --enable
#   源码在 project-spec/meta-user/recipes-modules/plcio_drv/files/

# rootfs 勾选常用包（menuconfig 里按 y）
petalinux-config -c rootfs
#   Filesystem Packages → misc-utils → gdbserver 开启（第24章要用）
#   → network → lighttpd 开启（第33章 Web 监控要用）
#   tcf-agent 建议关闭（省资源）
```

### 15.6 构建、打包、烧写一条龙
```
petalinux-build                          # 全量构建
ls images/linux/
#   zImage  system.dtb  system.dts  BOOT.BIN(fsbl+fpga+u-boot)
#   image.ub(FIT: kernel+dtb+rootfs)  rootfs.ext4  rootfs.tar.gz ...

# 方式A：SD 卡完整系统（FAT放BOOT.BIN+image.ub，ext4解包rootfs）
cp images/linux/{BOOT.BIN,image.ub} /media/$USER/boot/
sudo dd if=images/linux/rootfs.ext4 of=/dev/sdb2 conv=fsync
# 或 sudo mkfs.ext4 /dev/sdb2 && 挂载后解压 rootfs.tar.gz

# 方式B：NFS 开发模式（日常推荐）
petalinux-config                         # Root FS type → NFS
petalinux-build
sudo rm -rf ~/work/rootfs/* && sudo tar xzf images/linux/rootfs.tar.gz -C ~/work/rootfs
# U-Boot bootargs 用第11章 NFS 参数即可
```

### 15.7 高频命令速查表

| 场景 | 命令 

| 只重编内核 | `petalinux-build -c kernel` 

| 只重打包 BOOT.BIN | `petalinux-package --boot --format BIN --fsbl images/linux/zynq_fsbl.elf --fpga images/linux/*.bit --u-boot --force` 

| 查看某包编译日志 | `build/tmp/work/<arch>/<pkg>/<ver>/temp/log.do_compile.*` 

| 清理单包 | `petalinux-build -c <pkg> -x do_clean` 

| 导出 SDK 给应用开发 | `petalinux-build --sdk && images/linux/sdk.sh` 

| QSPI 固化三件套 | `petalinux-package --boot --fsbl ... --fpga ... --u-boot && Program Flash` 

### 常见问题 FAQ（避坑指南）
Q1：首次构建超过 3 小时正常吗？无 sstate 时属正常（Yocto 从零编几百个包）。务必配好离线 sstate/downloads（4.4节），二次构建同配置通常 <30 分钟。增量构建只动你改过的包。

Q2：构建报错 ERROR: ... Taskhash mismatch 或 do_fetch 失败？do_fetch 多为网络问题——确认 DL_DIR 离线包路径正确或挂代理。Taskhash 类错误常见于混用了不同版本缓存：清理该包 do_clean 后重建。

Q3：启动时刷屏 "macb ff0e0000.ethernet eth0: unable to generate target frequency"？或 eeprom 警告？Xilinx 板级 EEPROM/MAC 相关告警在第三方板上是噪音，可安全忽略；真正要关注的是 gem1 PHY 是否 up（dmesg | grep eth）。PHY 地址不对则链路永远 down —— 回 DTS 修 reg。

Q4：如何确认我的 dtsi 改动真的进了最终 DTB？`dtc -I dtb -O dts images/linux/system.dtb | less` 直接搜你的 compatible 字符串。养成「改树必验证」的习惯。

**🧪 动手实验 L15-1：完整交付一台 NFS 开发机**
从空目录开始：建工程→导 XSA→开 gdbserver/lighttpd→加 plcapp（打印版本循环）→NFS 模式构建导出→U-Boot 引导进入系统。验收：① `which gdbserver lighttpd` 存在；② `plcapp` 手动运行正常；③ 在 Ubuntu 里改一行 plcapp 源码重新 build 后，板上重启应用即见新输出（体会 NFS 工作流效率）。

**📝 思考题**
- 对比手工链路（13~16章）与 PetaLinux：哪些环节它帮你自动化了？哪些仍必须你懂原理才能配对？
- 为什么 meta-user 里的配方能覆盖官方同名配方？BitBake 的优先级机制是什么？
- 若产品要求断网产线也能完整复现构建，你需要准备哪几样东西？（提示：sstate/downloads/源码镜像/XSA）

### 15.8 深潜：BitBake 配方(.bb)解剖与 bbappend 叠加
```
# myapp_1.0.bb —— 一个配方的完整骨架
SUMMARY = "PLC runtime application"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade6..."

SRC_URI = "file://plc_runtime.c \
           file://plc.conf"                    # 从 files/ 取源
S = "${WORKDIR}"                                # 解包工作目录

do_compile() {
    ${CC} ${CFLAGS} plc_runtime.c -o plc_runtime
}
do_install() {
    install -d ${D}${bindir}                    # D=目标根目录暂存区
    install -m 0755 plc_runtime ${D}${bindir}
    install -d ${D}${sysconfdir}/plc
    install -m 0644 plc.conf ${D}${sysconfdir}/plc/
}
FILES_${PN} += "${sysconfdir}/plc"              # 声明产物归属(打包进主包)
```
**bbappend 追加修改官方配方**（不碰上游）：如 `lighttpd_%.bbappend` 里 `FILESEXTRAPATHS_prepend := "${THISDIR}/files:"` + `SRC_URI += "file://my-lighttpd.conf"` + do_install_append 覆盖配置 —— 这是「改第三方行为」的标准姿势，升级版本不受影响。

### 15.9 深潜：内核/U-Boot 补丁与 devtool 工作流

- **静态补丁**：`SRC_URI += "file://0001-add-plc-dts.patch"` 放 meta-user 对应 .bbappend —— 构建时自动 quilt 应用；
- **交互式开发（推荐）**：`devtool modify linux-xlnx` → 在 build/workspace 源码树直接改 → 编译验证 → `devtool finish linux-xlnx meta-user` 自动生成补丁回填 layer。这条链路把「改内核」变成可审计的 patch 序列。

### 15.10 深潜：镜像定制与包管理
```
# petalinuxbsp.conf 或自定义 image recipe：
CORE_IMAGE_EXTRA_INSTALL += "gdbserver lighttpd modbus? libmodbus can-utils i2c-tools \
                             vim strace tcpdump python3-pymodbus? openssh-sftp-server"
# 包名查询：build/tmp/deploy/... 或 bitbake -s | grep xxx
# 精简方向：移除 tcf-agent/openssh 换 dropbear、去 man/locale、用 musl? (PetaLinux默认glibc)
```

| 构建失败场景 | 首查位置 | 典型修法 

| do_fetch 失败 | 网络/DL_DIR 路径 | 离线包就位或代理；URL 校验 md5 更新 

| do_compile 错误 | temp/log.do_compile 末尾 30 行 | 缺头文件→DEPENDS 加依赖包；gcc 版本警告转错误→KCFLAGS 

| do_rootfs 冲突 | log.do_rootfs "conflicts" | 互斥包二选一（如 dropbear vs openssh-server） 

| 镜像缺文件 | workdir/packages-split | FILES_${PN} 未声明安装路径 

[← 上一篇第14章 内核编译与设备树基础](#ch14)
[下一篇 →第16章 根文件系统与BusyBox](#ch16)

---

## 第16章 根文件系统与 BusyBox
内核只是地基，「房子」是根文件系统。本章手工搭一个最小系统 —— 从此 init 脚本、开机自启对你再无秘密。

**🎯 学习目标**
- 理解 FHS 目录规范与最小可启动 rootfs 的组成
- 亲手编译 BusyBox 并构建能登录 shell 的迷你根文件系统
- 掌握 PetaLinux 下添加开机自启应用的标准做法

### 16.1 最小根文件系统的骨架

| 路径 | 必须内容 | 缺失后果 

| /sbin/init（或 /init） | PID 1 用户态第一进程 | Kernel panic - not syncing: No init found 

| /dev/console | 控制台设备节点（mknod c 5 1） | init 起来了但无声无息 

| /lib/*.so* | 动态链接器 ld-linux + libc（若非静态编译） | 所有程序报 not found（其实是缺解释器） 

| /etc/inittab | 定义 sysinit/getty/shutdown 行为 | init 默认行为不可控 

| /bin /sbin /usr | BusyBox 提供全部命令 | 无 shell 可用 

### 16.2 编译 BusyBox（静态版最适合教学）
```
cd ~/work/src
git clone https://git.busybox.net/busybox && cd busybox
# 或下载 1_31_stable 分支压缩包
make defconfig ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi-
make menuconfig   # Settings → Build static binary (no shared libs) 勾选
make ARCH=arm CROSS_COMPILE=arm-xilinx-linux-gnueabi- -j$(nproc)
make CONFIG_PREFIX=~/work/rootfs-mini install
# 产物：rootfs-mini/{bin,sbin,usr} + linuxrc，全是符号链接指向 busybox
```

### 16.3 补齐让它「活」起来的四件事
```
# ~/work/rootfs-mini 内：
mkdir -p dev proc sys etc/init.d tmp var home/root

① 设备节点（NFS root 时由内核 devtmpfs 自动挂载，手工版先建占位）
sudo mknod -m 666 dev/console c 5 1

② /etc/inittab —— busybox init 的剧本
::sysinit:/etc/init.d/rcS
::respawn:-/bin/login -f root        # 免密直登（实验用）
::restart:/sbin/init
::ctrlaltdel:/sbin/reboot

③ /etc/init.d/rcS —— 开机脚本入口
#!/bin/sh
mount -t proc none /proc
mount -t sysfs none /sys
mount -t devtmpfs none /dev 2>/dev/null
hostname navigator
echo "mini rootfs ready!"

④ /etc/passwd 与 group（login 需要）
root:x:0:0:root:/home/root:/bin/sh
```
```
chmod +x ~/work/rootfs-mini/etc/init.d/rcS
# NFS 导出该目录，U-Boot 用 nfsroot=/home/user/work/rootfs-mini 引导
# 看到提示符的一刻，你就拥有了一个 100% 自己构建的 Linux！
```

### 16.4 动态链接版的关键步骤（贴近实际产品）
静态编译体积大且放弃 glibc 生态。动态版的正确操作：

```
file bin/busybox          # 确认 dynamically linked
readelf -d bin/busybox    # NEEDED 列表：libm/libc...
# 从 SDK sysroot 拷贝运行时库（注意保留软链！）：
SDK=~/work/sdk/sysroots/cortexa9t2hf-neon-xilinx-linux-gnueabi
cp -a $SDK/lib/ld-linux-armhf.so.3* rootfs-mini/lib/
cp -a $SDK/lib/libc.so.*     rootfs-mini/lib/
cp -a $SDK/lib/libm.so.*     rootfs-mini/lib/
# 缺什么补什么：板卡上报 "not found" 的程序逐个 readelf 分析
```

### 16.5 PetaLinux 世界里的对应关系

| 手工概念 | PetaLinux/Yocto 实现 

| BusyBox init + inittab | 默认同款；可在 `petalinux-config -c rootfs → Image Settings` 定制 

| 往 /usr/bin 放程序 | `petalinux-create -t apps` 配方自动安装 

| rcS 里加启动命令 | 配方继承 `update-rc.d` 类，自动生成 S 链接（见下） 

| 拷贝 .ko/.so | modules/rootfs 配方管理依赖，绝不手拷 

```
# 让 plcapp 开机自启：编辑其配方 .bb 追加
inherit update-rc.d
INITSCRIPT_NAME = "plcapp.sh"
INITSCRIPT_PARAMS = "start 99 5 ."
SRC_URI += "file://plcapp.sh"
do_install_append() {
    install -d ${D}${sysconfdir}/init.d
    install -m 0755 ${WORKDIR}/plcapp.sh ${D}${sysconfdir}/init.d/
}
# plcapp.sh 内：case start) /usr/bin/plcapp & ;; stop) ... esac
# 重新 petalinux-build 后，板上 /etc/rc5.d/S99plcapp.sh 出现即成功
```

### 16.6 根文件系统载体选型

| 形态 | 介质 | 读写能力 | 场景 

| NFS 目录 | 网络 | 全读写 | 研发期首选（本课程主线） 

| ext4 | eMMC/SD 分区 | 全读写+日志 | 通用量产 

| squashfs | QSPI/eMMC | 只读 | 固件防篡改、OTA 主分区 

| jffs2/ubifs | NOR/NAND | 可读写、掉电安全 | 裸 flash 方案 

| initramfs | 并入内核镜像 | 内存盘 | 救援系统、快速起跳后 pivot_root 

### 常见问题 FAQ（避坑指南）
Q1：启动停在 "Run /sbin/init as init process" 之后没动静？init 已运行但输出无处去：检查 /dev/console 是否存在、内核 bootargs console 是否正确、inittab 是否有 respawn 条目。三查之后基本必中。

Q2：板上执行程序报 "-sh: ./app: not found" 但文件明明存在？九成是缺动态链接器：ld-linux 找不到时报的就是 not found。readelf -l app | grep interpreter 看请求路径是否存在于你的 rootfs。

Q3：根目录只读无法写入？squashfs 天生只读；ext4 则可能因异常断电进入只读保护。dmesg 看 EXT4-fs error，修复需 e2fsck；产品设计上建议数据写独立分区。

**🧪 动手实验 L16-1：双系统对比**
① 完成 16.2~16.3 的 mini rootfs 并通过 NFS 引导登录；② 在其中加入一个 C 写的自绘 `mytop`（读 /proc/stat 显示CPU占用），静态编译放入验证；③ 对照 PetaLinux 生成的 rootfs.tar.gz，找出三个你 mini 版没有但生产必需的目录/机制（如 /var/log、udev/mdev 热插拔），写下它们的作用。

**📝 思考题**
- PID 1 为什么特殊？如果 init 进程被 kill 会发生什么？
- 设计 OTA 升级方案：squashfs 主分区 A/B 双备份 + uboot 计数切换，画出分区表。
- 为什么嵌入式设备普遍用 busybox init 而不是 systemd？什么时候值得换 systemd？

### 16.7 深潜：initramfs 与 pivot_root（固件升级/救援的基石）
initramfs = 打进内核或独立加载的微型内存根文件系统，用途：①挂载真根前完成驱动/解密/网络配置；②**OTA 升级器**（在内存系统里安全改写 eMMC 分区）；③救援壳。手工制作：

```
mkdir -p cpio/{bin,dev,proc,sys,usr/bin}
cp busybox cpio/bin/ && ln -s ../bin/busybox cpio/sbin/init? # busybox init 或自写脚本
cat > cpio/init <<'EOF'
#!/bin/busybox sh
mount -t proc none /proc; mount -t sysfs none /sys
mount /dev/mmcblk0p2 /mnt && exec switch_root /mnt /sbin/init
EOF
chmod +x cpio/init
(cd cpio && find . | cpio -o -H newc | gzip) > rootfs.cpio.gz
# U-Boot: tftpboot ${ramdisk_addr} rootfs.cpio.gz
# bootz ${kaddr} ${ramdisk_addr}:${filesize} ${dtb_addr}   ← 第二参数带ramdisk!
```

### 16.8 深潜：热插拔 mdev vs udev

| 维度 | mdev(BusyBox) | udev(systemd/eudev) 

| 体积 | ~KB 级 | MB 级+依赖 

| 规则语法 | 简化版 /etc/mdev.conf | 完整 match/action 体系 

| 适用 | 无桌面嵌入式（本课程默认） | 桌面/复杂热插拔 

```
# /etc/mdev.conf 示例：SD卡分区自动挂载
mmcblk[0-9]p[0-9]  0:6  660  @/bin/sh -c 'mkdir -p /media/$MDEV && mount /dev/$MDEV /media/$MDEV'
# 内核侧需 CONFIG_UEVENT_HELPER + echo /sbin/mdev > /proc/sys/kernel/hotplug（或netlink模式）
```

### 16.9 深潜：账号、口令与远程访问加固

- **/etc/passwd 字段**：user:x:UID:GID:comment:home:shell —— x 表示口令在 shadow；**/etc/shadow** 存哈希+时效策略（字段含义面试常考）；
- 生成口令哈希：`mkpasswd -m sha-512` 或 openssl passwd -6，替换 shadow 中 'x'？注意 shadow 里才是哈希；
- 远程访问三档：口令 ssh（最弱）→ **密钥登录**（dropbear -s 禁口令，authorized_keys 放 /etc/dropbear）→ 证书+跳板（企业级）；
- 最小授权：专用 plcuser 跑业务，root 仅运维；sudoers 白名单命令。

### 16.10 深潜：开机自检与环境自愈脚本
```
#!/bin/sh
# S97selfcheck —— 开机体检，失败进入安全态
fail=0
[ -c /dev/uio0 ]            || { echo "uio0 missing"; fail=1; }
ping -c1 -W1 192.168.2.20 >/dev/null || echo "warn: host unreachable"
mountpoint -q /media/data   || mount /dev/mmcblk0p3 /media/data || fail=1
if [ $fail -eq 1 ]; then
    logger -t selfcheck "SAFE MODE"
    /usr/bin/plc_runtime --safe-mode &     # 只允许读输入+全关输出
    exit 0
fi
/etc/init.d/S99plc start
```
设计思想：**自检失败不等于停机，而是降级到已知安全状态** —— 与 34 章看门狗、44 章安全输出态一脉相承。

[← 上一篇第15章 PetaLinux全流程实战](#ch15)
[下一篇 →第17章 字符设备驱动开发](#ch17)

---

