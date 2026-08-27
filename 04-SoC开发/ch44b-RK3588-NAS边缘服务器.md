---
title: "第44B章 RK3588 项目实战②：NAS 与边缘服务器"
part: "[[P4-MOC]]"
chapter: "44B"
tags:
  - domain/soc
  - topic/storage
  - topic/network
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch44a-RK3588四目AI视觉工作站]]"
related:
  - "[[ch57-根文件系统构建只读overlayfs]]"
  - "[[ch92-P6-OpenWrt定制路由器全志H3]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第44B章 RK3588 项目实战②：NAS 与边缘服务器

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch44a-RK3588四目AI视觉工作站]] | → [[ch44c-新板矩阵五块新硬件开箱与分析]]

## 🎯 学习目标
- [ ] 会做 RK3588 平台 PCIe 拓扑规划与 SATA 存储栈选型
- [ ] 能完成 SMB/NFS 服务调优并复现实测吞吐数据
- [ ] 掌握 Docker 容器资源治理与 UPS 联动关机链路
- [ ] 建立「消费芯片当服务器」的可靠性工程清单

## 44B.1 需求规格
同一颗芯片换一种打开方式：交付 4 盘位 NAS + Docker 服务宿主二合一设备原型。

| 需求项 | 指标 | 路线 |
|--------|------|------|
| 存储 | 4×SATA HDD（或 M.2 SSD×2+SATA×2），RAID1/5 可选 | 板载 AHCI 兼容 Native SATA 控制器 |
| 文件服务 | SMB/NFS，千兆 ≥112MB/s、2.5G ≥280MB/s | Samba / NFS-kernel |
| 容器服务 | HomeAssistant/Jellyfin/Qbittorrent 等 8+ 服务 | Armbian/Debian + docker-ce |
| 网络 | 双 2.5G 电口(链路聚合)+可选万兆光 | RTL8125 板载×2 + PCIe3×1 万兆位 |
| 可靠性 | 异常断电文件系统零损坏、SMART 告警、UPS 联动关机 | ext4/xfs+journal、smartd、nut |

## 44B.2 硬件与 PCIe 拓扑规划

```text
PCIe 拓扑分配(Gen3x4 总闸 ≈ 32Gbps)：
 ├─ x2 → JMB585 SATA 扩展卡位(4 盘)；或用 RK3588 自带 3×SATA(AHCI)
 │        + Combo PIPE 再出一组 —— 注意端口复用冲突，拓扑表先行！
 ├─ x1 → RTL8125 第二个 2.5G 电口
 └─ x1 → 预留万兆(ASMedia/Aquantia AQC113 卡)或 M.2 WiFi

存储布局决策： 系统=eMMC squashfs 只读(ch57 方案)，HDD 全部让给数据；
              数据=mdadm RAID1(安全优先) 或 ext4 单盘+定时 rsync(成本优先)；
              无 SSD 时禁用 write cache 类特性——掉电安全优先于性能。
功耗账本： 主板 6W + HDD 待启停(2W 运行/25W spin-up 峰值!) →
          电源按 4×25W 峰值重叠设计 ≥120W 且 staggered spin-up 分时上盘 ★关键
```

## 44B.3 关键代码：系统构建步骤（Armbian 路线）

```bash
# 底座：armbian build 选对应 rk35xx 分支 RELEASE=bookworm
mdadm --create /dev/md0 --level=1 --raid-devices=2 /dev/sda /dev/sdb   # RAID1
mkfs.ext4 -m 0 /dev/md0 && mount -o noatime /dev/md0 /export           # 数据卷
# smartd.conf：DEVICESCAN -a -m root -s (S/../.././02)  # 周二凌晨自检
# samba 最小可用配置 + vfs objects=full_audit 按需；nfs exports 加 fsid=数字
curl -fsSL get.docker.com | sh                                          # docker compose 部署全家桶
# Jellyfin 硬解：/dev/dri(RK VDPU381) 需映射设备+video 组权限
ip link add bond0 type bond && ip link set eth1 master bond0            # mode=802.3ad(LACP)
                                                                        # 或 active-backup(免交换机支持)
```

## 44B.4 存储性能实测与调优记录

| 场景 | 配置 | 实测 |
|------|------|------|
| SATA 单盘顺序写 | fio bs=1M direct=1 | ~230MB/s(盘上限) |
| RAID1 顺序读 | 双盘并行 | ~260MB/s |
| SMB 千兆单流 | 默认参数 | 108MB/s ✓ |
| 2.5G bond 双流 | LACP + SMB multichannel | **~430MB/s**(SMB multi-channel 生效时) |
| 4K 随机写(数据库类容器) | HDD | ~1.2MB/s —— **元数据型容器务必放 eMMC/SSD** |

调优清单：readahead 提升、vm.dirty_ratio 微调、SMB aio 参数、关闭 atime。

## 44B.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 2.5G 吞吐腰斩 | ethtool -i eth1 查驱动 | 换 r8125 vendor 驱动 | iperf3 达 2.5G 线速档 |
| HDD 频繁唤醒 | 盘体声/日志时间戳 | 心跳容器工作目录迁 tmpfs/eMMC | standby 保持不退出 |
| 重同步期业务骤降 | cat /proc/mdstat 看 speed | bitmap 开启+min_sync_rate 限速 | 业务 I/O 无感知 |
| 半夜假关机 | nut 日志查 USB HID 时序 | 驱动参数加去抖 | 无市电误报触发 |
| Windows 发现不了 NAS | 广播域/网段检查 | host 网络或 macvlan 替代默认 bridge | 网络发现可见可访问 |

## 44B.6 实测数据表：整机功耗画像（4×4TB HDD）

| 状态 | 功率 | 备注 |
|------|------|------|
| 待机(盘休眠) | 7.8W | HDD standby + 服务低载 |
| SMB 满速读写 | 19W | 双盘活跃+网络满载 |
| RAID 重构中 | 31W | 四盘全转——供电散热按此设计 |
| 冷启动峰值 | 118W(2s) | staggered spin-up 后降至 62W ★必须分时 |

## 44B.7 排故速查表：十大踩坑实录

| # | 现象 | 根因候选 | 定位路径与对策 |
|---|------|----------|----------------|
| 1 | 启用 SATA3 后 PCIe 设备消失 | 端口与 Combo 复用冲突 | 先画拓扑表再定硬件配置 |
| 2 | 2.5G 只能亮不能跑满 | 主线 r8169 驱动吞吐腰斩 | 装 vendor 驱动 r8125 |
| 3 | 盘刚休眠又被唤醒 | 容器心跳写盘 | 监控类容器目录迁 tmpfs/eMMC |
| 4 | 开机卡在等待阵列 | mdadm 自动装配失败 | initramfs 内 mdadm.conf 更新纪律 |
| 5 | Jellyfin 转码占满 CPU | 未启用硬解/客户端转码 | 映射 VPU(/dev/dri)+Direct Play 优先 |
| 6 | SMB 广播发现失效 | Docker 默认 bridge 冲突 | host 网络/macvlan 二选一 |
| 7 | 断电信号误报假关机 | UPS USB HID 时序抖动 | nut 驱动参数加去抖 |
| 8 | RAID1 重同步拖垮业务 | 全速 resync 抢带宽 | bitmap+min_sync_rate 限速 |
| 9 | 中文文件名乱码 | SMB 字符集不一致 | unix charset=UTF-8 全局统一 |
| 10 | 出厂设备残留测试数据 | 忘清测试容器卷 | 产测 SOP 增加「恢复出厂」步骤(ch57 重置方案) |

## 44B.8 部署注意事项（可靠性工程清单）
1. eMMC 写放大治理：日志/journald volatile 化、数据库容器强制落 HDD/SSD 分区（[[ch57-根文件系统构建只读overlayfs]] 只读方案复用）；
2. 看门狗三级：硬件 WDT + systemd WatchdogSec + 容器 healthcheck（ch44 同款三级守护思想）；
3. 温度分级策略：HDD 仓 45℃ 风扇起转、SoC 75℃ 降频——thermal zones 显式配置；
4. 供应链双源：核心板与 HDD 各锁第二供货源；固件仓库保存全量可复现构建；
5. 远程运维通道：WireGuard 隧道+SSH 密钥+自动快照回滚点；UPS 联动顺序为「广播通知容器优雅停止→mdadm 同步完成→最后关机」，备份三层：每日 borgbackup 增量+每周 snapper 快照+异地冷备，恢复演练纳入季度任务。

> [!example]- 🧪 动手实验 L44B-1：随机断电一致性演练（30 分钟）
> **步骤**：① 后台脚本循环写入带校验和的测试文件到 RAID 卷；② 用智能插座/继电器随机切断 DC 电源 ×10 次；③ 每次上电后执行 `mdadm --check` 与 fsck，比对全部校验和；④ 记录 journal 中文件系统错误条数。
> **验收**：RAID 无 degraded、所有校验和比对通过、journal 无 ext4 结构损坏记录——达成 G2「随机断电零损坏」标准。

## 44B.9 进阶话题
- 边缘容器编排对比：K3s(内存开销 ~512MB，agent 模式 ~256MB；声明式 YAML/自愈/滚动更新；多节点 server+agent 集群；16GB 板实测稳定跑 20+ Pod) vs Docker Compose(~100MB，compose.yaml 单文件，单机) vs 裸 systemd(<10MB)。**判断：单台设备 Compose 足够；多台需要统一编排时再上 K3s**（安装一行命令 `curl -sfL get.k3s.io | sh -`）；
- ZFS 取舍：ARC 以内存换性能，RK 平台无 ECC 使校验优势打折——ext4+RAID1+borg 快照更务实；
- 对比 x86 小主机(N100)：RK3588 功耗省一半、NPU/编解码白送，代价是虚拟化能力一般(KVM 可用但性能平平)；重度虚拟化选 x86；
- 全闪改造：若客户要求 4×NVMe，PCIe Gen3×4 总闸需重新规划分配图。

> [!warning]- ❓ FAQ
> **Q1：为什么不上 ZFS？** 16GB 内存机器上 ARC 反而让体验不如「ext4+合理缓存」；且 RK 平台 ECC 缺失使 ZFS 校验优势打折。数据安全性用 RAID1+borg 快照组合达成。
> **Q2：和 x86 小主机(N100)比值不值？** 家庭/轻商用场景 RK3588 占优（功耗/NPU/硬解码）；重度虚拟化场景选 x86 更稳。

> [!question] 📝 思考题
> 1. 推导「4 盘 RAID5 vs 2×RAID1」在本项目容量/可靠性/重建时间三维的对比。
> 2. 设计容器化 NAS 的「一键灾备恢复」流程并演练一次。
> 3. 若客户要求全闪(4×NVMe)，PCIe 拓扑如何重新规划？重画 44B.2 分配图。

---
🏷️ #domain/soc #topic/storage #topic/network | 🔗 [[ch44a-RK3588四目AI视觉工作站]] ← **本章** → [[ch44c-新板矩阵五块新硬件开箱与分析]] | 📚 [[P4-MOC]]
