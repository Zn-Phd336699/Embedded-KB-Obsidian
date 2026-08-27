---
title: "SO5 Linux 系统优化进阶：内核调参、容器治理与观测前沿"
part: "[[P12-MOC]]"
chapter: "SO5"
tags:
  - domain/performance
  - topic/kernel
  - topic/container
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[chs4-SO4综合优化战役复盘五大战役]]"
related:
  - "[[ch65-性能优化CPU隔离cgroup-io调优]]"
  - "[[ch16-perf-ftrace-strace性能剖析]]"
  - "[[SE-专家之路技能地图]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# SO5 Linux 系统优化进阶：内核调参、容器治理与观测前沿

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[chs4-SO4综合优化战役复盘五大战役]] | → [[SE-专家之路技能地图]]

## 🎯 学习目标
- [ ] 建立 sysctl 参数的「语义级」理解框架而非死记数值
- [ ] 掌握 cgroup v2 治理多服务争用的完整方法(cpu.weight/memory.max/io.max)
- [ ] 能设计 L0/L1/L2 三层观测体系并制定升降级策略
- [ ] 能对 eBPF/io_uring 做出嵌入式落地决策

## SO5.1 内核调参的语义级理解框架（举三反一）
| 参数族 | 语义本质 | 典型调优决策链 |
|--------|----------|----------------|
| vm.dirty_ratio / dirty_background_* | 「脏页何时强制落盘」——写缓存水位线 | 写入毛刺→降低 background 阈值让后台提前分担；掉电安全→缩短 expire 时间 |
| net.core.somaxconn / netdev_max_backlog | 「突发到达时的排队容量」 | SYN 丢包→增大 somaxconn 且应用 accept 跟上；软中断丢包→加 backlog 但先查 CPU(ch16) |
| sched_autogroup / migration_cost_ns | 「调度器对交互性与亲和性的取舍」 | 实时抖动→CPU 隔离+RT 策略优先于改调度器参数([[ch65-性能优化CPU隔离cgroup-io调优]]) |

方法论：**每个参数先问「它默认保护什么」，再决定是否打破——盲抄网上的 sysctl 清单是事故制造机。**

## SO5.2 cgroup v2 治理多服务争用实战
场景：网关机上 MQTT 业务、日志采集、OTA 三者互相抢 CPU 与内存。
```ini
; 统一层级切片方案
/gateway.slice   cpu.weight=500  memory.max=256M             ; 业务主体，让路给谁都不行
/logs.slice      cpu.weight=50   memory.max=64M              ; 日志永远低人一等
/ota.slice       cpu.weight=100  io.max="nvme0n1 wbps=50000000"  ; 限 OTA 落盘带宽 50MB/s
```
systemd 实现(推荐)：service 单元内直接写 `CPUWeight=`/`MemoryMax=`，或 `systemctl set-property xxx.service CPUWeight=500` 即时生效。
验证闭环：`systemd-cgtop` 实测各切片占比符合权重比；压力注入(模拟 OTA 满速)观察 MQTT P99 是否仍在预算表内(SO1 联动)。

## SO5.3 抢占模型三态基准对比（实测数据表）
| 模型 | cyclictest(同板) | 吞吐影响 | 适用 |
|------|------------------|----------|------|
| PREEMPT_NONE(服务器式) | - | 吞吐最高 | 纯吞吐网关 |
| CONFIG_PREEMPT(标准) | P99 210 µs / max 3.4 ms | ≈−2% | 通用 ★多数产品起点 |
| **PREEMPT_RT 补丁** | P99 62 µs / max 140 µs | −5~8% | 确定性刚需 |

选择纪律：先用标准内核+RT 策略(SCHED_FIFO/chrt 调确定性关键线程，普通业务走 SCHED_OTHER+nice 或 cgroup cpu.weight 分层)调到极限，仍不达标再上 RT 补丁——**补丁不是默认答案**。

## SO5.4 内存回收深水区：watermark/kswapd/direct reclaim 联动
```text
三级水位(min/low/high)驱动回收节奏：
· free < low → 唤醒 kswapd 后台回收(异步、温和)
· free < min → direct reclaim(同步——进程自己回收，延迟毛刺元凶)
· 高阶分配失败 → compaction 内存紧凑化(CPU 尖峰另一来源)
症状「偶发 50ms 卡顿周期性出现」→ vmstat 看 kswapd 时间戳是否对齐
  对策：提前回收(watermark 刻度放大)/关 THP/关键进程 mlock(ch65)
症状「高阶分配失败」→ /proc/pagetypeinfo 查碎片 → compact_memory 或重启预防
```

## SO5.5 eBPF 观测前沿：嵌入式能用吗？
| 问题 | 答案 |
|------|------|
| ARM 板能跑吗？ | 能——内核 4.x+ 开启 BPF_JIT/BPF_SYSCALL；低配板建议诊断会话时按需加载，平时零驻留 |
| 最有价值的三个程序 | ① offcputime(off-CPU 火焰图数据源) ② biolatency(存储延迟直方图) ③ tcptop(每进程网络吞吐) |
| 交叉编译痛点 | BPF 程序依赖目标内核 BTF，厂商内核常缺——对策 CO-RE+vmlinux.h，或退回 perf trace 方案 |
| 与 ch16 分工 | perf 回答「谁在耗 CPU」，eBPF 回答「谁在等/谁在丢」——互补不替代 |

## SO5.6 io_uring 与异步 IO 前沿
价值定位：高并发 IO(日志聚合/流媒体落盘)减少 syscall 与上下文切换。收益口径：512 并发小文件写，syscall 数 −90%、吞吐 +35%(x86 实测)，ARM 趋势一致。
**采用门槛判定（三条同时满足才值得引入）**：① 内核 ≥5.10——主流 RK/i.MX 新 BSP 可满足；② profiler 证明 IO 为瓶颈；③ 应用已有事件循环架构——否则收益覆盖不了改造成本。

IO 通道取证基线：`iostat -x 1` 盯 `%util`/`await` 找饱和盘；用 `fio` 对目标存储定标顺序/随机极限作为基线(嵌入式 eMMC 典型值：顺序写数十 MB/s、4K 随机写数百~数千 IOPS)；上线后以 eBPF biolatency 直方图对照退化。

## SO5.7 观测体系分层：L0/L1/L2 常态低频+问题态高频自动升降
```text
L0 常态层(常驻)：心跳携带 30s 粒度关键指标(CPU/mem/重传率/队列水位)
L1 触发层：阈值/事件触发升级(错误率↑、延迟 P99 超标、OOM kill)
L2 深挖层(临时)：自动 perf record -F299 -g --sleep 30 + eBPF offcputime
                + tcpdump 滚动窗口 → 打包上传后自动卸载
升降级三机制：
① 升级去抖：连续 N 个窗口超阈值才升级，防抖动误报
② 自我限流：L2 采集自身开销计入预算(<3%)，超限自动降级
③ 现场保留：pstore/ramoops 兜底崩溃前的最后观测(ch64)
```

## SO5.8 大规模部署的性能回归体系（持续基线）
1. **基线库**：每「硬件版本×软件版本」组合固化基准数字组(启动/延迟/吞吐/内存水位)；
2. **自动回归**：CI 夜间跑基准脚本，偏离基线 >10% 阻断发布(SO2 决策表的体系化)；
3. **现场遥测对照**：设备心跳携带关键指标与实验室基线比对——捕获「只在线上出现」的退化；
4. **事故复盘归档**：接入 SO4 复盘模板，形成团队性能知识图谱。

## SO5.9 sysctl 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 写入毛刺周期性出现 | iostat/vmstat 看 dirty 水位 | 降低 dirty_background 阈值 | 毛刺幅度明显收敛 |
| SYN 泛洪下丢连接 | ss -lnt 看 Recv-Q 溢出 | somaxconn↑ 且应用 accept 并发跟上 | listen 队列不再打满 |
| 高阶内存分配失败 | /proc/pagetypeinfo 看碎片 | compact_memory 或预防性重启 | order-N 失败计数停止增长 |
| RT 任务偶发长尾 | cyclictest 直方图 | 先 CPU 隔离+cgroups 再动调度参数 | max/P99 进入预算表 |

## SO5.10 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 周期性 50ms 卡顿 | kswapd/direct reclaim 时间戳对齐 | vmstat 对照水位刻度→放大 watermark/mlock |
| 高 PPS 下连接莫名丢包 | conntrack 表满 | nf_conntrack_count vs max→调 max+超时或 NOTRACK |
| 单核 softirq 打满 | 单队列网卡未跨核分发 | RPS/RFS/XPS 组合拳→关闭 irqbalance 手工接管 |
| 多服务互相抢资源 | 无切片隔离、权重缺省均分 | systemd-cgtop 实测占比→按业务权重设 cpu.weight |

## SO5.11 部署注意事项
1. **参数变更灰度**：sysctl/cgroup 限制先灰度 5% 设备观察 72h 再全量(ch72 思想复用)；
2. **观测自身成本**：eBPF/全量指标常驻有开销——生产态低频采样、问题态拉高(L0/L1/L2 分级即为此设计)；
3. **版本三角纪律**：内核/BPF 工具链/libbpf 锁定入库——前沿工具链兼容性脆弱需制度化防御。

> [!example]- 🧪 动手实验 LN-SO5：cgroup v2 切片权重闭环（30 分钟）
> **步骤**：为三个服务建立 slice 并设 cpu.weight=500/100/50 → 用 stress 注入满载 → `systemd-cgtop` 记录各切片实测占比 → 再模拟 OTA 满速写盘观察业务 P99。
> **验收**：三切片 CPU 占比与权重比一致(误差 ±10%)；注入期间业务 P99 不超出 SO1 预算表。

## SO5.12 进阶话题
- **参数即代码**：sysctl/cgroup 配置纳入版本管理并与发布绑定——「这台机器为什么这么配」必须永远可回答；
- **容量规划前置**：新功能上线前按 SO1 公式预估资源增量——性能工程从被动救火转向主动规划的分水岭；
- conntrack 表满是高 PPS 网关最隐蔽的丢包源：纯转发场景直接 NOTRACK；RFS 需配 rps_sock_flow_entries 才生效，与 XPS 锁核组合收益最大；
- **持续剖析(Continuous Profiling)**：以 eBPF 低频常态采样为底座、问题态自动升频的工业化形态——正是 L0/L1/L2 分层在观测领域的落地样板。

> [!warning]- ❓ FAQ
> **Q1：为什么不能盲抄网上的 sysctl 清单？** 每个参数默认都在保护某种场景，不理解语义就打破保护=制造事故；先问「它保护什么」再动。
> **Q2：eBPF 能替代 perf/ftrace 吗？** 不能——perf 回答谁在耗 CPU，eBPF 回答谁在等/谁在丢，互补不替代。
> **Q3：direct reclaim 为什么是延迟毛刺元凶？** free 低于 min 时进程同步自行回收页面，回收耗时直接计入该进程关键路径。

> [!question] 📝 思考题
> 1. 为你的网关设计 cgroup v2 切片方案并说明权重依据。
> 2. eBPF 与 perf/ftrace 的能力边界？举一个必须 eBPF 的场景。
> 3. 描述一次「direct reclaim 导致延迟毛刺」的完整取证链。
> 4. 你的产品适合引入 io_uring 吗？给出完整判定流程。

---
🏷️ #performance #linux #ebpf #observability | 🔗 [[chs4-SO4综合优化战役复盘五大战役]] ← **本章** → [[SE-专家之路技能地图]] | 📚 [[P12-MOC]]
