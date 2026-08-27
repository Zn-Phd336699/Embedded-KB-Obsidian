---
title: "第35章 正点原子 I.MX6U ALPHA 平台详解"
part: "[[P4-MOC]]"
chapter: 35
tags:
  - domain/soc
  - topic/bootloader
difficulty: 3
est_minutes: 28
prerequisites:
  - "[[ch34-ARM-A架构与国产SoC选型地图]]"
related:
  - "[[ch39-U-Boot移植与网络开发模式]]"
  - "[[chsd-S4-量产工程产测工装与老化]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第35章 正点原子 I.MX6U ALPHA 平台详解

> [!info] 导航
> ⏱ 28min | ★★★☆☆ | 前置 [[ch34-ARM-A架构与国产SoC选型地图]] | → [[ch36-RK平台ATK-DLRK3568-RK3588-Luckfox]]
## 🎯 学习目标
- [ ] 盘点 i.MX6ULL 资源与 ALPHA 板载外设映射
- [ ] 字节级说清 IVT/DCD 结构与拨码开关三种启动方式
- [ ] 跑通出厂镜像并搭好串口+NFS 网络开发环境
- [ ] 说清 HAB 安全启动五步流程与 eMMC/NAND 版本取舍
## 35.1 平台资源速览

| 类别 | 资源 | 备注 |
|------|------|------|
| CPU | 单核 Cortex-A7 @800MHz + NEON | 无 GPU 版本(6ULL)，6UL 带 GPU |
| 存储 | 256KB OCRAM / 512MB DDR3 / 8GB eMMC 或 256MB NAND（两版板） | eMMC 版推荐 |
| 显示 | RGB888 LCD 控制器 + 电容触摸 GT9147 | Qt/LVGL 上屏实验载体 |
| 通信 | 2×Ethernet(FEC) / 2×CAN / 8×UART / 2×USB OTG / SDIO WiFi 位 | 双网口做路由实验 |
| 音频 | SAI + WM8960 codec + 麦克风/耳机座 | ALSA 驱动学习素材 |
| 调试 | JTAG 座 + USB 转 TTL(CH340) + 出厂烧好系统 | 零门槛起步 |
## 35.2 启动方式与 IVT/DCD 字节级结构

```text
拨码开关 BOOT_MODE(i.MX6ULL)：
  00 从 BootROM 按 eFuse/引脚配置选择 → SD卡/eMMC/NAND/QSPI/USB
  01 Serial Download(USB OTG1) → mfgtool/uuu 强刷模式 ★救砖神器
  10 内部 boot 模式
镜像组成(.imx)：[IVT 头][BootData][DCD 配置数据(DDR 初始化寄存器表!)]...[U-Boot]
IVT(Boot 头, 32 字节)：header(0xD2 标签) | entry(入口地址) | dcd_ptr | boot_data_ptr | self
  —— entry 指 U-Boot 入口；dcd_ptr 指 DDR 配置表；boot_data_ptr 指加载地址/长度；self 指 IVT 自身
DCD(Device Configuration Data)：一串「写寄存器命令」表 [tag=0xCC][len][CCM_CCGR0 地址][值]...
烧写位置规则：SD 卡偏移 1KB(0x400) 放 IVT —— dd 写错偏移=不启动
DCD 写错 = DDR 参数不对 = 启动即死 —— 移植新 DDR 颗粒的第一雷区
拼装用 imx-mkimage/mkimage；DDR 参数由 NXP 官方 ddr_stress_tester 校准脚本输出
排查口诀：上电无输出先 hexdump 卡首 2KB 确认 IVT 在位且 entry 合理
```
## 35.3 第一次开机与 NFS 网络开发环境

```bash
# ① 拨码 SD 卡启动插出厂卡，串口 /dev/ttyUSB0 @115200：U-Boot 倒计时→内核滚动→root 登录即成功
setenv ipaddr 192.168.1.50; setenv serverip 192.168.1.100; ping 192.168.1.100   # ② 网络三件套验通(ch39 黄金环)
# ③ NFS 根文件系统挂载（免反复烧写 eMMC）：
setenv bootargs 'console=ttymxc0,115200 root=/dev/nfs nfsroot=192.168.1.100:/opt/nfs/rootfs,v3,tcp ip=dhcp'
# ④ 主机准备：Ubuntu 20.04 + arm-linux-gnueabihf-gcc + tftpd-hpa + nfs-kernel-server
```
## 35.4 三种根文件系统部署对比（实测）

| 方式 | 迭代一次改动耗时 | 适用阶段 |
|------|------------------|----------|
| NFS 根(ch39) | <5 秒(改文件即生效) | 驱动/应用开发期 ★主力 |
| eMMC 直烧(rootfs.ext4) | ~3 分钟(uuu 整盘) | 联调稳定后验证启动链 |
| SquashFS 只读+overlay | ~4 分钟 | 量产形态演练([[ch57-根文件系统构建只读overlayfs]]) |
## 35.5 HAB 安全启动实操五步

| 步骤 | 操作 | 工具/命令 |
|------|------|-----------|
| ① 生成密钥对 | HAB Code Signing Tool(CST) 生成 4 组 SRK 公私钥对 | `hab4_pki_tree.sh -kt rsa -len 4096` |
| ② 烧写 SRK 哈希 | SRK Table(公钥指纹)烧入 eFuse——**不可逆！先在评估板演练** | `srktool -f srk.fuse_bin` + uuu 写 fuse |
| ③ 签名镜像 | CSF 文件描述验证范围 → CST 生成 CSF 二进制附加到 IVT 后 | `cst --o csf.bin < csf_template.txt` |
| ④ 关闭 open config | BT_FUSE_SEL 等 fuse bit 置位后 ROM 强制验签 | 量产前最后一步；开发期保留调试签名通道 |
| ⑤ 救砖预案 | Serial Download 模式(USB OTG)不受 HAB 影响——保底恢复通道 | `uuu auto.uuu` 强刷完整镜像 |
## 35.6 eMMC 版 vs NAND 版差异

| 维度 | eMMC 版(ALPHA DDR3) | NAND 版(ALPHA DDR3L) |
|------|---------------------|-----------------------|
| 存储介质 | 8GB eMMC(MMC 5.0) | 256MB NAND(SLC, 8bit) |
| 启动方式 | BOOT_CFG→eMMC SDIO 接口 | BOOT_CFG→NAND GPMI 接口 |
| BSP 差异 | 设备树 mmc 别名+分区表 | 设备树 gpmi-nand 节点+MTD 分区 |
| rootfs 格式 | ext4/squashfs(推荐) | UBIFS(NAND 必选，含坏块管理) |
| 寿命预期 | P/E 千~万级，控制器管理 | SLC 10 万级但容量极小 |
| 适用场景 | **绝大多数产品 ★推荐** | 成本极限压缩的小固件产品 |
## 35.7 关键代码：产线 uuu 批量烧录脚本

```bash
#!/bin/bash
# uuu_auto_flash.sh —— 一键全盘烧录+校验(SN=$1 MAC=$2)
SN=$1; MAC=$2
# ① 设备进入 Serial Download 模式(拨码 01 + USB 连接)
uuu -v -b emmc_all imx-boot-imx6ull.bin rootfs.ext4.gz.wic || exit 1
# ② 重启后 SSH 注入 SN/MAC
sleep 30; ssh root@192.168.1.1 "echo $SN > /etc/device_sn; ifconfig eth0 hw ether $MAC"
# ③ 触发自检并读回结果
ssh root@192.168.1.1 "/usr/bin/selftest" | tee result_$SN.log
grep -q "ALL PASS" result_$SN.log && echo "PASS" >> trace.log || echo "FAIL" >> trace.log
echo "$SN done at $(date)" >> trace.log
# ④ 台账闭环：trace.log 是产测追溯的唯一事实源(联动 [[chsd-S4-量产工程产测工装与老化]])
```
## 35.8 参数调试技巧

| 场景 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 首次点亮 | 串口 115200 观察 U-Boot 倒计时 | 拨码位置/出厂卡 | root 登录提示出现 |
| NFS 免烧写迭代 | bootargs 加 nfsroot v3,tcp | 主机 exports 与防火墙 | 改文件 <5s 生效 |
| 移植新 DDR 颗粒 | ddr_stress_tester 跑校准 | 重生成 DCD 表 | 校准全档通过 |
## 35.9 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 上电完全无输出 | 拨码错位/eMMC 无镜像/电源键未开 | 切 USB 模式用 uuu 刷出厂镜像验证硬件健康 |
| U-Boot 卡在 DDR 校准输出后 | DCD 与颗粒不匹配 | 换官方对应容量版 uboot-imx；重跑 stress tester |
| NFS 挂载 RPC timeout | 主机防火墙/nfs 未起/网段隔离 | showmount -e localhost 自检；ufw allow 2049 |
| LCD 花屏或偏色 | 设备树 panel timing 不匹配 | 对照屏规格书改 pixclk/hsync/vsync(dts) |
## 35.10 部署注意事项

1. 除非 BOM 极限压缩否则选 eMMC 版：寿命稳、容量大、坏块由控制器管理；
2. SRK 哈希烧入 eFuse **不可逆**——先在评估板完整演练，开发期保留调试签名通道，open config 的关闭放在量产前最后一步；
3. Serial Download(USB OTG) 不受 HAB 影响，是一切救砖方案的保底通道；
4. 6ULL vs 6UL 一句话：ULL 砍 GPU 换更低功耗与价格——纯控制网关选 ULL，带简单 GUI 才需要 UL/6DX。

> [!example]- 🧪 动手实验 L35-1：解剖一份出厂 .imx 镜像（40 分钟）
> **步骤**：① 取官方 u-boot-dtb.imx；② `xxd -l 64` 读头部，核对 0xD2 标签与 entry/dcd 指针；③ 按 dcd_ptr 偏移 dump 出 DCD 表前几条，对照 CCM 寄存器地址解释含义；④ 用 mkimage 类工具交叉验证。
> **验收**：产出一张标注了四个指针含义的 hex 截图，能口头复述 ROM 取镜像顺序——IVT 从此不再神秘。
## 35.11 进阶话题四则

- **HAB 安全启动**：SRK 表+CSF 签名让 ROM 验 U-Boot——量产防刷机的双刃剑；
- **USB Serial Download 的产线价值**：uuu 脚本一键全盘烧录+校验回读，S4 产测工装的软件基础；
- **出厂镜像分析手法**：IVT→DCD→U-Boot→内核的分段解剖法通用于所有 i.MX 项目；
- **双网口拓扑**：ALPHA 板 FEC 双口天然适合 WAN/LAN 路由实验，与家用路由概念同构。

> [!warning]- ❓ FAQ
> **Q1：为什么 i.MX 把 DDR 初始化放 DCD 而不是 SPL？** ROM 直接消费 DCD，无需二级加载即可点亮 DRAM，把大体积 U-Boot 直接载入运行；代价是 DCD 写错=启动即死且难调试。RK 方案把它做成独立 TPL 固件，可单独替换测试更灵活——两种取舍各有胜负。
> **Q2：eMMC 主系统坏了怎么一键恢复？** 拨码切 Serial Download + uuu 全盘重刷即可，这正是产线脚本的设计前提；HAB 开启后该通道依然可用（不受验签约束）。

> [!question] 📝 思考题
> 1. 设计「eMMC 主系统损坏后一键恢复」的完整产线方案，画出状态流转图。
> 2. 对比 ALPHA 板双网口拓扑与家用路由器的 WAN/LAN 概念差异。
> 3. 为什么 SD 卡烧写偏移必须是 1KB？写出 BootROM 定位 IVT 的完整逻辑链。

---
🏷️ #domain/soc #topic/bootloader #topic/security | 🔗 [[ch34-ARM-A架构与国产SoC选型地图]] ← **本章** → [[ch36-RK平台ATK-DLRK3568-RK3588-Luckfox]] | 📚 [[P4-MOC]]
