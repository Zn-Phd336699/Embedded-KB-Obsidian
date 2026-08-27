---
title: "第39章 U-Boot移植与网络开发模式"
part: "[[P4-MOC]]"
chapter: 39
tags:
  - domain/soc
  - topic/bootloader
  - topic/network
difficulty: 3
est_minutes: 45
prerequisites:
  - "[[ch38-SoC启动链深度剖析]]"
related:
  - "[[ch40-内核适配与设备树dts语法-pinctrl-overlay]]"
  - "[[chsd-S4-量产工程产测工装与老化]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第39章 U-Boot移植与网络开发模式

> [!info] 导航
> ⏱ 45min | ★★★☆☆ | 前置 [[ch38-SoC启动链深度剖析]] | → [[ch40-内核适配与设备树dts语法-pinctrl-overlay]]

## 🎯 学习目标
- [ ] 以参考板 defconfig 为基线编译定制 U-Boot，说出关键配置项与产物差异
- [ ] 搭建 TFTP+NFS 黄金开发环，把「改一行代码」的验证周期压到秒级
- [ ] 解释 bootz 交接协议（寄存器/dtb/bootargs）与 distro boot 思想
- [ ] 用 ums/fastboot 完成救砖与批量烧写场景

## 39.1 编译与移植要点

```bash
git clone https://source.denx.de/u-boot/u-boot.git && cd u-boot
make mx6ull_14x14_evk_defconfig        # 以NXP EVK为基线起步(ALPHA板同源)
make menuconfig                        # 按需增删驱动
make -j$(nproc) CROSS_COMPILE=arm-linux-gnueabihf-
# 产物： u-boot-dtb.imx (i.MX含IVT头) / u-boot.itb(RK FIT格式)
# 移植新板套路：找同系列最近亲板 → copy defconfig+dts → 改 dts 外设
#             → Kconfig/Makefile 注册板名 → 迭代调串口输出
```

## 39.2 黄金开发环组件表

| 组件 | 主机配置(Ubuntu) | 用途 |
|------|------------------|------|
| TFTP | `apt install tftpd-hpa`；目录 /srv/tftp 权限 777 | 快速加载 kernel/dtb/U-Boot 本体 |
| NFS | `nfs-kernel-server`；exports 配 rw,sync,no_subtree_check,no_root_squash | 根文件系统免烧写迭代 |
| 静态IP | 板端 serverip/ipaddr/netmask/gateway 环境变量固化 | 省去 DHCP 等待 |

## 39.3 关键代码：U-Boot 侧黄金命令序列

```bash
setenv autoload no; dhcp
setenv serverip 192.168.1.100
tftpboot ${loadaddr} zImage ; tftpboot ${fdt_addr} imx6ull-alpha.dtb
setenv bootargs 'console=ttymxc0,115200 root=/dev/nfs ip=dhcp nfsroot=${serverip}:/opt/nfs/rootfs,v3,tcp'
bootz ${loadaddr} - ${fdt_addr}
# saveenv 固化后：上电按任意键中断 → run netboot 即进最新内核
# 内核侧配合：modules_install INSTALL_MOD_PATH=NFS目录下的rootfs
```

## 39.4 环境变量与 distro boot

env 默认存于 eMMC 特定扇区（冗余双份防损坏），printenv/setenv/saveenv 三兄弟日常伺候。distro_bootcmd 思想：按 boot_targets 顺序(sd/mmc/usb/pxe/nfs)自动寻找 boot.scr/extlinux.conf——主线发行版(Armbian/Debian)都遵循此约定，于是同一块板可以多系统共存切换：

```text
extlinux.conf 示例：
label local
  kernel /vmlinuz-6.1
  fdt /dtb/sun8i-h3.dtb
  append root=/dev/mmcblk0p2 rootwait console=ttyS0,115200
```

## 39.5 原理深挖：bootz 的交接协议（U-Boot→Kernel 到底传了什么）

```text
bootz 内核入口前，CPU 世界只剩三样东西：
① 寄存器约定：r0=0 / r1=machine_type(ARM32)；AArch64 用 x0~x3(dtb 指针)
② dtb 地址：设备树是唯一的「硬件说明书」传递物
③ bootargs 字符串：通过 dtb 的 /chosen 节点注入
关闭动作清单：MMU/Cache 关、中断关、DMA 停 —— 内核期望「裸机+dtb」
推论：U-Boot 里改了时钟不同步 dtb → 内核按 dtb 算的外设频率全错
```

## 39.6 U-Boot 高阶技能速记

- `ums 0 mmc 1`：把板上 eMMC 当 U 盘插主机直接读写——救砖/批量预装神器；
- `fastboot udp`：网络 fastboot，配合主机 `fastboot flash` 批量产线；
- FIT 镜像(itb)：kernel+dtb+ramdisk 多合一，逐组件 RSA 签名（安全启动基础）；
- `bootm start/loados/.../run` 分步引导：调试内核入口参数时逐步观察寄存器交接。

## 39.7 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| tftp 卡在 T T T 重试 | 抓包 UDP69 与动态端口 | ufw allow tftp；tftpd-hpa --secure 目录权限 | 文件秒级传完 |
| DHCP 拖慢每次上电 | 抓包看 DHCP 往返耗时 | 固化 ipaddr/serverip/netmask/gateway | 上电到可 tftp 无等待 |
| NFS 挂载失败 | showmount -e 核对导出项 | exports 显式 v3,tcp；no_root_squash 测试期开启 | mount 成功且 root 可写 |

## 39.8 实测数据表：三种内核加载方式迭代效率（改一行驱动重测）

| 方式 | 单次循环耗时 | 适用 |
|------|--------------|------|
| TFTP 内核 + NFS 根 ★ | ~35s(含重启) | 日常开发主力 |
| USB OTG ums 直写 eMMC | ~4min(整盘) | 验证真实量产布局 |
| kexec 快速换核(已运行系统) | ~8s | 内核高频调试黑科技 |

## 39.9 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| tftp 卡在 T T T 重试 | 主机防火墙 UDP69/动态端口拦截 | ufw allow tftp；检查 --secure 目录权限 |
| NFS root 挂载后 VFS panic | exports 路径/root_squash/协议版本 | showmount -e 核对；显式 v3；测试期开 no_root_squash |
| saveenv 后重启丢失 | env 存储介质配置(CONFIG_ENV_*)与硬件不符 | defconfig 里 ENV_IS_IN_MMC/OFFSET 核对分区表 |
| 新板串口无 U-Boot 输出 | console 引脚复用没配/晶振频率宏错 | SPL 阶段 debug uart 宏(CONFIG_DEBUG_UART_BASE) |

## 39.10 部署注意事项

1. env 冗余：CONFIG_ENV_OFFSET_REDUND 双份环境变量——升级中掉电不丢 bootargs；手工救砖用 `env default -a; saveenv` 一键复位；
2. saveenv 固化静态 IP 与 netboot 序列，产线/开发两套 env 用脚本切换；
3. pxe/dhcp 自动发现是机房批量设备零接触部署的入口；
4. U-Boot 阶段看门狗：CONFIG_WDT 且 SPL 启动即喂——否则 DDR 训练慢的板子会被 ROM 开的 WDG 咬死；
5. ums/fastboot 的产线用法延伸见 [[chsd-S4-量产工程产测工装与老化]]。

> [!example]- 🧪 动手实验 L39-1：搭建黄金环并实测迭代效率（60 分钟）
> **步骤**：① 主机配 tftpd+nfs-server，exports 加 no_root_squash；② U-Boot 写入 ipaddr/serverip 并 saveenv；③ 自制最小 busybox rootfs 放 NFS 目录；④ 完成 tftpboot+bootz 全链启动登录；⑤ 改一个内核 printk 重编走完整流程计时。
> **验收**：拿到你环境里真实的「改码→看到打印」周期数，并与 eMMC 烧录法对比出倍率。

## 39.11 进阶话题

- fitImage 的 config 选择：一个 itb 打包多组 kernel+fdt，bootm 用 `#conf-xx.dtb` 后缀选配置——一镜像多硬件变体的官方方案；
- pxe 分支可从网络拉取启动配置——零接触部署的协议基础；
- extlinux/boot.scr 约定是 Armbian/OpenWrt 镜像通用性的根因（参见 [[ch92-P6-OpenWrt定制路由器全志H3]]）；
- 扩展阅读：U-Boot `doc/develop/bootstd.rst`(distro boot 权威描述)；内核文档 `Documentation/arm/booting.rst`(交接契约原文)；Buildroot `board/*/post-image.sh`(自动打包启动介质的套路)。

> [!warning]- ❓ FAQ
> **Q1：为什么 no_root_squash 只建议测试期开启？**
> 它保留 NFS 客户端 root 身份，开发期免权限干扰；生产环境暴露它等于把宿主目录交给 root 随意改写。
> **Q2：为什么 kexec 比 TFTP+NFS 还快一个数量级？**
> 免去 U-Boot/DDR 再初始化与网络传输，直接在已运行系统内换核，只付出内核自身解压与 initcalls 时间。

> [!question] 📝 思考题
> 1. 设计「U-Boot 一键恢复出厂」按钮逻辑：哪个阶段检测按键最可靠？
> 2. 估算 NFS vs eMMC 的内核模块加载延迟差，给出量化测试方案。
> 3. 为 FIT 增加 dtb 子集选择机制：同一内核适配三种屏的启动策略。

---
🏷️ #domain/soc #topic/bootloader #topic/network | 🔗 [[ch38-SoC启动链深度剖析]] ← **本章** → [[ch40-内核适配与设备树dts语法-pinctrl-overlay]] | 📚 [[P4-MOC]]
