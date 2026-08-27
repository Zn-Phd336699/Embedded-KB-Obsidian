---
title: "第57章 根文件系统构建只读overlayfs"
part: "[[P6-MOC]]"
chapter: 57
tags:
  - domain/linux
  - topic/rootfs
difficulty: 3
est_minutes: 40
prerequisites:
  - "[[ch41-Buildroot定制rootfs全流程]]"
  - "[[ch56-启动流程深度剖析systemd提速]]"
related:
  - "[[ch72-A-B-OTA升级与Recovery体系]]"
  - "[[ch92-P6-OpenWrt定制路由器全志H3]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第57章 根文件系统构建只读overlayfs

> [!info] 导航
> ⏱ 40min | ★★★☆☆ | 前置 [[ch56-启动流程深度剖析systemd提速]] | → [[ch58-字符设备驱动hello-drv到并发安全]]

## 🎯 学习目标
- [ ] 手工组装 BusyBox 最小系统七件套并完成登录闭环验证
- [ ] 说清只读 rootfs 的掉电安全动机，实施 squashfs+overlayfs 量产级改造五步清单
- [ ] 掌握 overlayfs 三层模型（lowerdir/upperdir/workdir）、whiteout 与数据分区分离策略

## 57.1 FHS 目录职责速览（嵌入式视角）
| 目录 | 职责 | 嵌入式要点 |
|------|------|------|
| /bin /sbin /lib | 基础工具与库 | busybox 合并布局；libc 选型定体积 |
| /etc | 配置 | 只读化后是 overlay 写热点，需迁出 |
| /dev /proc /sys | 设备/进程/内核接口 | devtmpfs 自动挂载；静态节点仅兜底 |
| /usr /opt | 应用与第三方 | 自研 app 放 /usr/bin 配 unit |
| /var /tmp | 可变数据 | tmpfs 挂载防 Flash 写穿 |

## 57.2 BusyBox 最小系统七件套
从零手搓一个能登录的 Linux 世界——理解每个部件的必要性，才能做对裁剪：
```text
rootfs/
├── bin/busybox (+ sbin → usr/sbin 合并布局可选)
├── etc/inittab        ::sysinit:/etc/rcS ; ttySC0::respawn:-/bin/login
├── etc/passwd+shadow  root:x:0:0... (shadow 用 mkpasswd 生成哈希)
├── etc/group /etc/profile
├── dev/               (devtmpfs 自动，静态节点仅保留 console/null 兜底)
├── proc sys tmp run   挂载点空目录
└── lib/               ld-linux-armhf.so.3 + libc.so.6 (+ldd 排查出的闭集)
登录闭环验证： 串口出 login: → root 密码 → shell 可用 = 骨架成立
```

## 57.3 设备节点管理与 fstab 挂载策略
| 方案 | 机制 | 选型 |
|------|------|------|
| mdev(busybox) | hotplug 回调脚本创建节点 | 极小系统首选 |
| eudev/systemd-udevd | netlink 监听+规则引擎 | 需要复杂规则(权限/别名/symlink)的正规军 |

```text
# /etc/fstab 嵌入式典型配置：
/dev/root       /       ext4    ro,noatime             0  1   ← 只读根！
tmpfs           /run    tmpfs   nosuid,nodev,size=32M  0  0
tmpfs           /tmp    tmpfs   nosuid,size=64M        0  0
/dev/mmcblk0p3  /data   ext4    rw,noatime,commit=60   0  2   ← 数据分区
proc            /proc   proc    defaults               0  0
sysfs           /sys    sysfs   defaults               0  0
# commit=60 延迟提交降低 Flash 写放大；noatime 省掉读也写时间的灾难
```

## 57.4 只读 rootfs：动机与改造五步
**动机：掉电安全**。嵌入式设备随时可能被拔电——ext4 日志只能保证元数据一致，不能保证「写到一半的升级」不损坏系统；把根做成天然只读的 squashfs，写路径全部引到独立分区，任意时刻断电系统镜像都完好无损。改造清单：
1. 镜像打包为 squashfs（mksquashfs 天然只读压缩）；
2. 写热点迁移：/etc/resolv.conf→/run；日志→journald volatile 或 /data；
3. overlayfs 合成可写视图：`lowerdir=/ro upperdir=/data/ov workdir=/data/ovw`；
4. 首次开机初始化：检测 /data 空则从种子目录复制默认配置；
5. OTA 时整分区块替换 squashfs——永不担心升级中断电损坏系统。

## 57.5 关键代码：overlayfs 三层挂载实操与 whiteout
```bash
# lower(squashfs ro) + upper(ext4 rw) + workdir → merged 视图
mount -t squashfs /dev/mmcblk0p1 /ro
mkdir -p /data/ov /data/ovw /mnt/merged
mount -t overlay overlay \
  -o lowerdir=/ro,upperdir=/data/ov,workdir=/data/ovw \
  /mnt/merged
switch_root /mnt/merged /sbin/init
```
```text
三层语义：
· 读： upper 有则用，否则透到 lower
· 写(lower 文件)： copy-up 整文件到 upper 再改 —— 首次写放大！
· 删 lower 文件： upper 建 whiteout 字符设备(0/0) 标记遮蔽
· mkdir 同名： upper 建不透明目录(.wh..opq) 整目录遮蔽
产品化推论：
① copy-up 意味着大文件首次写很慢 —— 热数据开机预拷贝
② overlay 上层容量规划 = 你会改动的文件总量 ×1.2
③ 升级=换 lower 层镜像，upper 用户数据原样保留 —— OTA 与用户态解耦
```

## 57.6 数据分区分离策略
分区布局三板斧：p1=只读系统(squashfs)、p2=数据(/data, ext4 rw)、不配 swap（嵌入式禁用）。所有可变状态归拢 /data：应用配置、overlay upper、日志持久部分；易失部分归 tmpfs。出厂重置的正确实现：**清 upper 层而非重刷固件**——删空 `/data/ov` 后重启即恢复出厂，秒级完成且绝不伤及 lower 只读层。该布局同时是 [[ch72-A-B-OTA升级与Recovery体系]] 动态分区的公共底座。

## 57.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 首次写大文件极慢 | time dd if=/dev/zero of=/merged/f | 热数据开机预拷贝到 upper | 二次写入耗时正常 |
| Flash 寿命告警 | iostat 找写大户 | 高频写迁 tmpfs/journald volatile | 写入速率 <Flash 预算 |
| overlay 容量告警 | df -h /merged 看 upper 使用量 | 扩 /data 分区或清理 upper | upper 用量 <80% |

## 57.8 实测数据表
| 场景 | 指标 | 数值（典型值） |
|------|------|------|
| squashfs 根 vs ext4 根 | 镜像体积比 | ~40~50% 压缩率 |
| copy-up 一个 10MB 文件 | 首次写耗时 | 毫秒~十毫秒级（eMMC） |
| 清 upper 出厂重置 | 重置耗时 | 秒级（对比重刷固件分钟级） |

## 57.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| login 后立刻退出 | /etc/passwd shell 路径不存在或缺动态库 | chroot 进 rootfs 手动跑 /bin/sh 验证 |
| 随机 Read-only file system 写失败 | 程序写死路径落在 ro 区 | strace -e openat 抓写点；迁到可写路径 |
| 设备节点权限不对 | mdev 规则缺失 | /etc/mdev.conf 加属主模式行；udevadm info 对照 |
| Flash 写穿寿命告警 | 高频写 /var 未迁移 | iostat 找写大户；tmpfs+journald volatile 化 |

## 57.10 部署注意事项
1. workdir 必须与 upperdir 同一文件系统且为空目录，否则 mount 直接报 EINVAL。
2. fstab 里根分区务必 `ro,noatime`；`commit=60` 只加在 /data 这类 rw 分区上。
3. 升级流程只替换 lower 镜像，禁止在线改 upper 里的系统文件；挂载脚本范本抄 OpenWrt（squashfs+overlay 宗师，见 [[ch92-P6-OpenWrt定制路由器全志H3]]）。
4. 首开机种子复制脚本要有幂等标记，防止每次开机重复覆盖用户配置。

> [!example]- 🧪 动手实验 L57-1：亲手搭一套只读系统（70 分钟）
> **步骤**：① Buildroot 出 squashfs rootfs；② 手动分三区(ro/data)格式化挂载；③ 配置 overlay fstab 条目让 / 为可写视图；④ 断电测试 20 次：每次上电系统完整、/data 内容保留；⑤ 用 dd 在 / 写大文件观察首次 copy-up 耗时。**验收**：断电零损坏 + 一份 copy-up 性能小抄。

## 57.11 进阶话题
- erofs 替代 squashfs：页内压缩+随机读更快——新项目值得评估(Android 已主力采用)。
- /etc 管理两派：overlay 全可写 vs uci/confd 式声明配置生成——后者对升级合并更友好。
- 出厂重置的最小实现：数据分区标记清除 upper 层，3 秒完成。
- 权威语义参考：内核文档 Documentation/filesystems/overlayfs.rst。

> [!warning]- ❓ FAQ
> **Q1：为什么删一个 lower 文件磁盘占用反而增加？** upper 层创建了 whiteout 字符设备(0/0)遮蔽标记——这是 overlayfs 的删除语义，不是 bug。
> **Q2：noatime 和 relatime 怎么选？** noatime 彻底关闭读时间戳更新最省写；relatime 折中仍会偶发写盘。eMMC 产品一律 noatime。

> [!question] 📝 思考题
> 1. 设计「出厂重置」功能：数据分区标记清除的最小实现。
> 2. 推演 overlayfs whiteout 文件在 OTA 清理时的处理。

---
🏷️ #domain/linux #topic/rootfs | 🔗 [[ch56-启动流程深度剖析systemd提速]] ← **本章** → [[ch58-字符设备驱动hello-drv到并发安全]] | 📚 [[P6-MOC]]
