---
title: "第41章 Buildroot定制rootfs全流程"
part: "[[P4-MOC]]"
chapter: 41
tags:
  - domain/soc
  - topic/buildroot
  - topic/rootfs
difficulty: 3
est_minutes: 40
prerequisites:
  - "[[ch40-内核适配与设备树dts语法-pinctrl-overlay]]"
related:
  - "[[ch42-Yocto入门-layer-recipe-bbappend]]"
  - "[[ch57-根文件系统构建只读overlayfs]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第41章 Buildroot定制rootfs全流程

> [!info] 导航
> ⏱ 40min | ★★★☆☆ | 前置 [[ch40-内核适配与设备树dts语法-pinctrl-overlay]] | → [[ch42-Yocto入门-layer-recipe-bbappend]]

## 🎯 学习目标
- [ ] 完成 Buildroot 全量构建并用 external tree 替换为自研 app
- [ ] 写出 package/myapp 打包四件套（Config.in/.mk/启动脚本/post-build）
- [ ] 按场景选镜像格式并解释 squashfs+overlayfs 只读架构
- [ ] 用 legal-info 导出许可证合规清单满足量产要求

## 41.1 快速上手

```bash
wget https://buildroot.org/downloads/buildroot-2024.02.tar.gz && tar xf ...
cd buildroot-2024.02
make menuconfig
#   Target options → ARM Cortex-A7；Toolchain → External(gcc 12.x linaro) 或内部构建
#   System configuration → hostname/getty tty/ttymxc0；Kernel → 外部预编 zImage 或内置构建
#   Target packages → busybox 自定义配置 + 需要的包(dropbear htop python3...)
#   Filesystem images → ext4 + squashfs 双出
make source      # 只下载源码（可提前离线缓存 dl/ 目录）
make -j$(nproc)  # 输出 output/images/{rootfs.ext4,zImage,...}
```

## 41.2 external tree：工程化定制的正确打开方式

```text
my-br-ext/
├── external.desc     # name:MYPROJ
├── Config.in
├── external.mk
├── package/myapp/    # Config.in + myapp.mk —— 自研应用打包规则
├── board/myboard/    # genimage.cfg 分区布局 / post-build.sh 镜像后处理
│   └── rootfs-overlay/  # 直接覆盖进rootfs的文件(服务脚本/证书/配置)
└── configs/myboard_defconfig

用法： make BR2_EXTERNAL=/path/my-br-ext myboard_defconfig
收益： buildroot 主树 git pull 更新零合并冲突 —— 团队协作的生命线。
```

## 41.3 镜像格式决策表

| 格式 | 特性 | 适用 |
|------|------|------|
| squashfs | 只读压缩、掉电安全、天然防篡改 | 量产固件主体（配 data 分区可写层） |
| ext4 | 可读写、支持日志 | 开发期/data分区 |
| initramfs | 内存根、极快、随内核加载 | 恢复模式/升级器环境(ch72 recovery 同思想) |
| ubifs/jffs2 | NAND 友好磨损均衡 | SPI NAND 设备(Luckfox 类，见 [[ch36-RK平台ATK-DLRK3568-RK3588-Luckfox]]) |

**只读系统 + overlayfs 黄金组合**：squashfs(ro) 作底层 + tmpfs 作上层 + overlayfs 合并视图 = 「每次开机都是全新系统」，用户数据单独挂 /var 或 /data 分区。这是路由器/IoT 网关的标准架构——固件升级=整分区块替换，永不担心半写状态损坏（展开见 [[ch57-根文件系统构建只读overlayfs]]）。

## 41.4 原理深挖：Buildroot 的 make 生命周期

```text
一个包从源码到 rootfs 的七步(以 myapp 为例)：
  myapp-patch → myapp-configure → myapp-build → myapp-install-staging
  → myapp-install-target → (所有包完成后) fakeroot 打镜像
高频命令：
  make myapp-dirclean && make myapp     # 单包重编(改代码后)
  make legal-info                       # 导出全部包许可证合规清单 ★量产必备
  make source -j8                       # 只拉取源码(离线缓存)
  make graph-depends                    # 输出依赖图 pdf —— 看清谁拖家带口
```

## 41.5 关键代码：自研应用打包模板（package/myapp 全套）

| 文件 | 关键内容 |
|------|----------|
| Config.in | `config BR2_PACKAGE_MYAPP` bool "myapp" + depends 按需 + help 文本 |
| myapp.mk | MYAPP_VERSION=1.2.0；MYAPP_SITE=$(BR2_EXTERNAL...)/git 或 http；`$(eval $(cmake-package))` |
| rootfs-overlay/etc/init.d/S99myapp | busybox init 启动脚本(start/stop/status 三段式) |
| post-build.sh | 改机名/注入版本号文件(git describe)/清理文档残留 |

```sh
# S99myapp 三段式骨架
case "$1" in
  start) /usr/bin/myapp -b ;;
  stop) killall myapp ;;
  status) pgrep myapp >/dev/null && echo running || echo stopped ;;
esac
```

## 41.6 实测数据表：体积与启动时间量级

| 场景 | rootfs 体积 | 用户态到 shell |
|------|-------------|----------------|
| BusyBox 最小系统 | ~10MB 级(典型值) | ~400ms(i.MX6ULL 实测, ch38) |
| systemd 系统 | ~100MB 级(典型值) | ~2.8s(i.MX6ULL 实测, ch38) |
| 包体积三刀瘦身(STROP/locale/busybox) | 常规省 30%+(典型值) | — |

## 41.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 下载源码超时 | 国内网络访问 upstream 不稳 | BR2_DL_DIR 共享缓存；换镜像站(BR2_PRIMARY_SITE) |
| 包编译失败连锁 | 工具链版本 ABI 不兼容 | `make <pkg>-dirclean` 单包重建；锁 toolchain 版本 |
| 启动卡在 random crng | 无熵源阻塞 getrandom | jitterentropy/rng-tools；busybox 配置核对 |
| overlay 文件权限丢失 | post-build 在非 root 下跑丢属主 | device table 或 post-fakeroot 脚本设置属主 |

## 41.8 部署注意事项
1. legal-info 是量产红线：导出全部包的许可证+源码清单，交法务前先自查 LICENSE 字段完整性；
2. GPL 包静态链接进商业固件需逐个做合规判断——别等出货才发现；
3. 量产镜像选 squashfs 只读主体 + /data 可写分区，升级走整分区块替换；
4. dl 缓存团队共享(BR2_DL_DIR 指向 NFS/对象存储)，新同事首日即可全量构建；
5. post-build.sh 注入 /etc/version(git describe)，现场一问便知烧的哪版。

> [!example]- 🧪 动手实验 L41-1：把 hello 世界变成「可升级产品」（50 分钟）
> **步骤**：① external tree 建骨架并跑通最小镜像；② 按 41.5 打包你的 app 并进 menuconfig 勾选；③ 修改 post-build.sh 注入 /etc/version(git describe)；④ 重编后烧写验证 version 文件与启动脚本生效。
> **验收**：一条命令从零复现整盘——这就是「可复现构建」的体感。

## 41.9 进阶话题
- 只读系统的 initramfs 变体：kernel+initramfs 单镜像适合「无存储介质」设备——rootfs 即内存盘，升级=换内核镜像；
- A/B 双 squashfs 升级：两套只读根分区+原子切换标志，是 OTA 的存储层基础；
- 扩展阅读：Buildroot Manual 的 project-specific customization + adding-packages 两章；board/raspberrypi 的 genimage.cfg 是分区布局范本；make graph-size 输出各包体积占比 PDF——瘦身靶心图。

> [!warning]- ❓ FAQ
> **Q1：Buildroot 和 Yocto 怎么选？** 小系统、量产镜像首选 Buildroot（菜单选包一键出镜像）；多层定制、SDK 级交付上 Yocto layer 体系，见下一章。
> **Q2：make legal-info 到底导出了什么？** 每个启用包的许可证文本、源码包与 manifest 清单——合规审计与法务存档的直接输入。

> [!question] 📝 思考题
> 1. 对比 Buildroot external tree 与 Yocto layer 的能力边界。
> 2. 设计 A/B 双 squashfs 升级方案的数据结构与切换原子性保证。
> 3. 估算「busybox 最小系统 vs systemd 系统」的 rootfs 体积差与启动时间差。

---
🏷️ #domain/soc #topic/buildroot #topic/rootfs | 🔗 [[ch40-内核适配与设备树dts语法-pinctrl-overlay]] ← **本章** → [[ch42-Yocto入门-layer-recipe-bbappend]] | 📚 [[P4-MOC]]
