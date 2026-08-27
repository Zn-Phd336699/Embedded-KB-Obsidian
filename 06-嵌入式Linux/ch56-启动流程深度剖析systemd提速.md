---
title: "第56章 启动流程深度剖析systemd提速"
part: "[[P6-MOC]]"
chapter: 56
tags:
  - domain/linux
  - topic/boot
difficulty: 3
est_minutes: 45
prerequisites:
  - "[[ch38-SoC启动链深度剖析]]"
  - "[[ch55-交叉编译与sysroot]]"
related:
  - "[[ch44-综合实战RK3568多协议边缘网关]]"
  - "[[ch72-A-B-OTA升级与Recovery体系]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第56章 启动流程深度剖析systemd提速

> [!info] 导航
> ⏱ 45min | ★★★☆☆ | 前置 [[ch38-SoC启动链深度剖析]] | → [[ch57-根文件系统构建只读overlayfs]]

## 🎯 学习目标
- [ ] 能画出从 zImage 自解压到 PID=1 接管的内核十步启动序列并标注调试锚点
- [ ] 区分 initramfs 的三种用途，手工构建最小 initramfs 并完成 switch_root
- [ ] 用 systemd-analyze 定位启动瓶颈，实施并行化/延迟加载等提速手段并量化收益

## 56.1 内核阶段十步曲
U-Boot 之后发生了什么？zImage 自解压 → `__start` → `start_kernel()`：
```text
① setup_arch: 读 dtb,建页表,开MMU
② mm_init/memblock 收尾
③ sched/时钟初始化(timekeeping)
④ IRQ/GIC 初始化
⑤ console_init → earlycon 切正式驱动
⑥ rest_init → kernel_init 线程
⑦ do_initcalls: 各级(.initcall0~7)按序执行 —— 驱动probe大潮
⑧ 挂载rootfs(do_mount_root) 或 initramfs 内置解包
⑨ 找 /init (ramfs) 或 /sbin/init (真root)
⑩ run_init_process → 用户态第一进程 PID=1 从此接管
调试锚点： initcall_debug 打印每步耗时；printk.time=1 日志带时间戳 —— 启动优化第一步
```

## 56.2 initramfs 三种用途与最小构建
1. **过渡跳板**：真 rootfs 在 LVM/加密分区/NFS 上时，先在内存里装好驱动再 switch_root；
2. **恢复环境**：独立 recovery 系统（[[ch72-A-B-OTA升级与Recovery体系]] 的 recovery 同思想）；
3. **极速启动**：整个系统就是 initramfs（内存盘），适合只读小型设备——开机即就绪无 IO 等待。
```sh
mkdir -p initramfs/{bin,dev,proc,sys}
cp busybox initramfs/bin/ ; ln -s ../bin/busybox initramfs/bin/sh
cat > initramfs/init <<'EOF'
#!/bin/sh
mount -t proc none /proc; mount -t sysfs none /sys; mount -t devtmpfs none /dev
exec switch_root /newroot /sbin/init      # 挂真root后移交
EOF
find initramfs | cpio -o -H newc | gzip > initramfs.cpio.gz
```

## 56.3 init 系统对比：sysvinit/busybox/systemd
经典 sysvinit（/etc/rc?.d 符号链接+启停脚本、串行执行）是桌面时代的基线，嵌入式已被两极取代：极小系统用 busybox init，复杂设备用 systemd。核心差异在**是否按依赖图并行**：
| 维度 | busybox init | systemd |
|------|------|------|
| 并行启动 | ❌ 按 inittab 串行 | ✅ 单元依赖图并行 |
| 服务守护 | 自己写 respawn 逻辑 | Restart=always 即得 |
| 体积/复杂度 | 极小极简 | 大而全(可裁剪) |
| 适用 | <16MB 设备、单一功能 | 网关/带网络管理复杂设备 ★主流选择 |

## 56.4 systemd 单元类型与依赖图
单元类型速览：`.service`（服务进程）、`.target`（同步点/分组，如 multi-user.target）、`.socket`（套接字激活）、`.mount/.automount`（挂载）、`.timer`（定时触发）。依赖三关键字：`Requires=`（强依赖，一起失败）、`Wants=`（弱依赖，失败不拖累）、`After=`（仅排序不拉起）。启动顺序 = 这些声明构成的 DAG 的拓扑序——「服务启动顺序随机失败」几乎都是缺 `After/Wants` 声明。

## 56.5 关键代码：自研 app 服务单元模板
```ini
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/gatewayd --config /etc/gateway/config.yaml
Restart=always                      # 崩溃自动拉起
WatchdogSec=30                      # 配合 sd_notify 心跳(ch44 守护)
MemoryMax=256M                      # cgroup 资源上限防失控

[Install]
WantedBy=multi-user.target
```

## 56.6 systemd-analyze 分析与提速清单
```bash
systemd-analyze                     # 总时间分解：firmware+loader+kernel+userspace
systemd-analyze blame | head        # 各单元耗时排行
systemd-analyze critical-chain      # 关键路径图
# ① udev 规则精简/禁用不需要的 net.ifnames 重命名等待
# ② Mask 无关单元： systemctl mask ModemManager wpa_supplicant(有线设备)
# ③ 内核侧： 非关键驱动改模块延迟加载；quiet loglevel=3 省 printk 时间
# ④ rootfs 用 squashfs 免日志恢复扫描；eMMC HS200 提速
# ⑤ splash 移除；bootchart/systemd-analyze plot 记录二次定位
```
readahead 类预读在 eMMC+现代内核上收益有限，优先做并行化与延迟加载。跨段对齐手段：U-Boot 打 GPIO 翻转→逻辑分析仪测各段边界(硬证据)；printk.time=1 + systemd monotonic 软件对齐误差 ~ms。**铁律：先分解再优化，每砍一刀复测一次，防止负优化。**

## 56.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 启动慢但 blame 无大户 | critical-chain 看关键路径 | 补齐依赖图/砍路径上串行点 | 关键链总时长下降 |
| 卡在等待网络 | `journalctl -b` 找 waiting 行 | 去 network-online Wants 或加超时 | 不再阻塞 multi-user |
| 内核段耗时异常 | initcall_debug + printk.time | 驱动改模块延迟加载 | kernel 段 <2s(典型) |

## 56.8 实测数据表：i.MX6ULL 启动优化战绩单（12.1s→4.3s）
| 场景 | 节省 |
|------|------|
| U-Boot 倒计时关闭+裁剪命令集 | -1.6s |
| 内核驱动改模块延后加载(非关键外设) | -2.2s |
| systemd 并行化修正+mask 无关单元 | -2.8s |
| journald volatile + loglevel=3 | -0.7s |
| splash/网络等待删除 | -0.5s |

## 56.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 卡在 "Waiting for root device" | 存储控制器驱动缺失/异步探测竞态 | rootwait 参数；把关键驱动改内建 |
| switch_root 后黑屏 | 新 root 缺 /dev/console 或 init 权限错 | initramfs 里手动 mount+chroot 验证；检查 exec 目标存在且+x |
| 服务启动顺序随机失败 | 缺 After/Wants 依赖声明 | critical-chain 分析补齐依赖图 |
| 重启比冷启动还慢 | shutdown 卡某单元超时 | journalctl -b -1 看上次停止日志；DefaultTimeoutStopSec 调整 |

## 56.10 部署注意事项
1. 自研服务统一走 56.5 单元模板入库(journalctl 统一日志)，禁止 rc.local 里 nohup 手拉进程；模板复用于 [[ch44-综合实战RK3568多协议边缘网关]] 与 [[ch66-综合实战USB摄像头流采集服务]]。
2. WatchdogSec 必须配套应用内 sd_notify 心跳，否则等于自杀开关。
3. 提速改动逐项提交并附 systemd-analyze 前后截图，形成可回滚的优化序列。
4. mask 操作前确认服务无隐式依赖者，避免 network-online 类连锁失效。

> [!example]- 🧪 动手实验 L56-1：给你的板子做一次启动瘦身（60 分钟）
> **步骤**：① systemd-analyze blame 取 TOP10；② mask 三项确认无用的服务并实测；③ 内核加 `initcall_debug` 找最贵的三个 initcall；④ 选其一做延后加载改造；⑤ 全程记录前后 critical-chain 图。**验收**：总启动时间下降 ≥20% 且功能回归全绿。

## 56.11 进阶话题
- initcall 排序的合法手段：把驱动编成 module 用 udev/modprobe 触发，或在 dts 层面延迟(status=disabled→运行期 enable)。
- splash 的代价真相：开机 logo 若阻塞 fbdev 就绪会倒扣时间——DRM plane 直接显示或干脆黑屏最快。
- systemd-analyze security 给每个服务打暴露分(ProtectSystem 等)；权威参考 bootup(7)/systemd.unit(5)/systemd.service(5) 三页精读。

> [!warning]- ❓ FAQ
> **Q1：为什么 initcall 分七个等级而不是一个大循环？** 各等级语义不同（early/core/postcore/arch/subsys/fs/device/late），保证「时钟先于驱动、总线先于设备」的初始化次序契约。
> **Q2：systemd 这么重为什么还选它？** 依赖图并行、cgroup 资源管控、watchdog/journal 一体化在复杂设备上收益远超其体积代价；小设备仍有 busybox init 退路。

> [!question] 📝 思考题
> 1. 解释为什么 initcall 分七个等级而不是一个大循环？各等级语义是什么？
> 2. 为「断电安全」设计 rootfs：哪些目录 tmpfs、哪些持久化、如何原子更新？

---
🏷️ #domain/linux #topic/boot | 🔗 [[ch55-交叉编译与sysroot]] ← **本章** → [[ch57-根文件系统构建只读overlayfs]] | 📚 [[P6-MOC]]
