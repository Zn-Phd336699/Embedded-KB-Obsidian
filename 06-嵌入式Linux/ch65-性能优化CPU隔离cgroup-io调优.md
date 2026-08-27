---
title: "第65章 性能优化专题：CPU隔离、cgroup与IO调优"
part: "[[P6-MOC]]"
chapter: 65
tags:
  - domain/linux
  - topic/performance
  - topic/scheduling
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch64-内核调试Oops解读debugfs-kdump]]"
related:
  - "[[ch61-中断下半部threaded-irq-workqueue]]"
  - "[[ch44-综合实战RK3568多协议边缘网关]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第65章 性能优化专题：CPU隔离、cgroup与IO调优

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch64-内核调试Oops解读debugfs-kdump]] | → [[ch66-综合实战USB摄像头流采集服务]]

## 🎯 学习目标
- [ ] 用 top/iostat/vmstat/perf 四板斧建立「先基线后优化」的工作纪律
- [ ] 落地 CPU 亲和性+隔离方案（taskset/cpuset/isolcpus）并给实时任务让核
- [ ] 用 cgroup v2 对服务做 cpu.max/memory.max/io.max 三维限额
- [ ] 完成 IO 调度器选型与 PREEMPT_RT 实时性验收流程

## 65.1 性能分析四板斧
嵌入式 Linux 的性能优化是「资源预算学」：算力给谁、内存留谁、IO 让谁。铁律：**没有数据的优化都是玄学**——先测基线（systemd-analyze + perf top + iostat），按「用户感知延迟」排序优化项：冷启动 > 操作响应 > 后台吞吐；每项优化前后跑同一基准脚本出对比表。

| 工具 | 看什么 | 典型判读 |
|------|--------|----------|
| top / mpstat -P ALL | 各核利用率分布 | 单核打满=亲和性问题 |
| vmstat | si/so 换入换出 | 持续非零=kswapd 回收抖动源 |
| iostat -x | %util 与 await | await 暴涨=存储瓶颈 |
| perf top / record | 热点函数火焰图 | 热点集中处优先下手 |

## 65.2 CPU 亲和性与隔离三板斧
```bash
# ① 调频策略：
echo performance > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
# 或 schedutil(平衡)；固定频率测试用 scaling_max/min_freq 锁定
# ② 任务绑定：
taskset -pc 2-3 $(pidof myapp)          # 绑到核2,3
pthread_setaffinity_np / sched_setaffinity 代码内设置
# ③ 中断分流：
echo 4 > /proc/irq/38/smp_affinity      # 中断挪到指定核，与业务错开
# RK3588 大小核注意：业务绑 A76(核4-7)，系统杂务留 A55
# 隔离进阶（内核启动参数）：
isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3
#   → 核2,3 无调度抖动纯给实时任务——音视频低延迟标配
```

## 65.3 cgroup v2 资源限制
cgroup v2 统一层级，服务治理三把刀（联动 ch44 服务编排）：

```bash
echo "+cpuset +cpu +memory +io" > /sys/fs/cgroup/cgroup.subtree_control && mkdir /sys/fs/cgroup/ai.slice
echo "2-3"            > ai.slice/cpuset.cpus        # 运行期绑隔离核，配合 isolcpus
echo "200000 100000"  > ai.slice/cpu.max            # quota/period：每100ms最多200ms→限2整核
echo "536870912"      > ai.slice/memory.max         # 硬顶512MB，触顶触发 OOM kill
echo "402653184"      > ai.slice/memory.high        # 软顶384MB，触顶回收施压防硬杀
echo "179:0 wbps=10485760 wiops=200" > ai.slice/io.max   # eMMC 写限流 10MB/s、200 IOPS
```

要点：`cpu.max` 是「配额/周期」二元组，突发型负载调大 period 可平滑毛刺；`io.max` 按 设备主次设备号 生效，先用 `lsblk` 查号；OOM 保护核心进程可叠加 `oom_score_adj=-1000`。

## 65.4 内存层取舍表
| 手段 | 命令/配置 | 收益场景 |
|------|-----------|----------|
| zram 压缩交换 | swapon /dev/zram0；zstd 算法 | 512MB 小内存设备防 OOM，代价 CPU |
| CMA 预留 | dts reserved-memory size=reusable | 摄像头/显示大缓冲免碎片 |
| THP 关闭 | transparent_hugepage=never | 降低延迟抖动（实时向） |
| mlock 关键页 | mlockall(MCL_CURRENT\|MCL_FUTURE) | 防关键路径缺页停顿 |
| OOM 策略 | oom_score_adj=-1000 保护核心进程 | 让日志进程先死而不是业务死 |

## 65.5 IO 调度器与存储调优
```bash
# eMMC 基线测试（顺序写 vs 4K随机写——差距可达百倍）：
fio --name=seqw --rw=write --bs=1M --size=256M --direct=1 --filename=/data/t && fio --name=randw --rw=randwrite --bs=4k --size=256M --direct=1 --filename=/data/t
# 调优清单：
mount -o noatime,commit=30 ...   # ext4 data=journal 慎用（双写费寿命）
cat /sys/block/mmcblk0/queue/scheduler   # bfq交互公平/mq-deadline吞吐/none(NVMe类)
# 文件系统：ext4通用 / f2fs Flash原生随机写友好 / squashfs 只读
# 数据库负载：WAL+sync=NORMAL 折中；或 LMDB/SQLite mmap 读
```

## 65.6 PREEMPT_RT 预览：上手五步与验证指标
```text
① 获取：Debian/Ubuntu 装 linux-image-rt-amd64；嵌入式用 OSADL/厂商 RT 补丁
② 配置：内核选 PREEMPT_RT + 关闭不需要的调试选项(开销)
③ 冒烟：uname -v 含 PREEMPT_RT；cyclictest -m -Sp99 -i1000 -h800
④ 判读：A55@1.8G 典型 P99<80µs / max<150µs(A76 更低)
⑤ 劣化源逐项隔离定位：console printk、USB 中断、eMMC io
指标纪律：只看 P99 与 max；「平均延迟」是自欺欺人的指标。
```

## 65.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 高负载下延迟尖刺 | cyclictest 加压对比 | 业务迁 isolcpus 核+IRQ 错核 | P99/max 收敛 |
| 小内存设备 OOM 误杀核心进程 | 按 RSS 排序找大户 | oom_score_adj=-1000 保护核心 | 先死的是日志进程 |
| 后台 IO 干扰实时路径 | iostat -x 看 await 毛刺 | io.max 给后台任务限 wbps/wiops | await 尖刺消失 |
## 65.8 实测数据表：cyclictest 三种内核对比（RK3568 同板）
| 内核 | P50 | P99 | max(1h) |
|------|-----|-----|---------|
| mainline CFS | 18µs | 210µs | 3.4ms |
| mainline+SCHED_FIFO 任务 | 15µs | 120µs | 2.8ms |
| **PREEMPT_RT + 线程化中断** | 11µs | **62µs** | **140µs** |
max 的改善才是 RT 补丁的核心价值——买的是确定性而非速度。

## 65.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 偶发 50ms 卡顿周期出现 | kswapd 回收/日志刷盘风暴 | ftrace sched_wakeup 找元凶线程；vmstat 采样 si/so |
| 多任务互相拖慢 | 同核争抢/中断亲和未分离 | mpstat -P ALL 看分布；taskset 分域 |
| 写入速度随时间骤降 | eMMC 进入稳态(TRIM 缺失) | fstrim.timer 使能；fio 全盘预填充后复测 |
| 降频后功能异常 | 外设时钟依赖主频假设(UART 波特率源) | clk_summary 对照；改独立 PLL 源 |
## 65.10 部署注意事项
1. 先基线后优化：systemd-analyze + perf top + iostat 先行；每项优化前后同一基准脚本，对比表入文档；
2. 电池设备按「能效比」选 governor——performance 提速但功耗约 ×2；
3. 隔离三层配合：isolcpus(启动期)+cpuset cgroup(运行期)+irqaffinity；改 isolcpus 需重启；
4. ext4 data=journal 双写费 Flash 寿命，量产慎用；
5. 实时指标纪律：验收只看负载下 P99 与 max（[[ch61-中断下半部threaded-irq-workqueue]] 线程化是前提）。

> [!example]- 🧪 动手实验 L65-1：一次完整的实时性验收（70 分钟）
> **步骤**：① 装 cyclictest 与 stress-ng；② 基线测量(mainline+空载)；③ 加压(stress-ng --cpu 4 --io 2)再测暴露劣化；④ 按 65.6 清单逐项隔离元凶并整改；⑤ 输出「负载下 max 延迟」达标报告。
> **验收**：一份可复现的实时性验收文档（含三种配置对比表）——工业客户问的就是这个。

## 65.11 进阶话题
- **CPU 隔离完整姿势**：isolcpus(启动期)+cpuset cgroup(运行期)+irqaffinity 三层配合，只留 rcu_nocbs 微干扰；
- **内存延迟抖动两源**：kswapd 回收与 THP 合并——mlockall+THP=never 双关后 P99 立竿见影；
- **eMMC 写延迟毛刺**：定期 GC 导致毫秒级停顿——关键路径用独立存储或预分配文件规避；OSADL QA Farm 是各硬件 RT 表现的真实数据库。

> [!warning]- ❓ FAQ
> **Q1：开了 performance governor 反而更卡？** 大概率大小核绑错或中断未错核；先 mpstat 确认分布再动调度器。
> **Q2：加了 SCHED_FIFO 还有尖刺？** 中断与内核路径未线程化；PREEMPT_RT + IRQ 亲和分离后才收敛。

> [!question] 📝 思考题
> 1. 推导「isolcpus 核上运行单线程」的最坏唤醒延迟构成。
> 2. 为 512MB RAM 设备制定 zram 大小与算法选择决策表。
> 3. 设计一套「性能回归 CI」：每次提交自动跑三项基准并比对阈值。

---
🏷️ #domain/linux #topic/performance #topic/scheduling | 🔗 [[ch64-内核调试Oops解读debugfs-kdump]] ← **本章** → [[ch66-综合实战USB摄像头流采集服务]] | 📚 [[P6-MOC]]
