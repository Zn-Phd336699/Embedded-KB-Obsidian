---
title: "Linux系统优化实战"
date: 2025-09-09
category: "ZYNQ异构"
tags: ["ZYNQ", "Linux", "性能优化", "系统调优"]
description: "Linux系统启动优化、内存优化、CPU调度优化、实时性优化"
---

# Linux系统优化实战

> Linux系统启动优化、内存优化、CPU调度优化、实时性优化

## 目录

1. [[#Linux 系统优化实战|Linux 系统优化实战]]

---

## 第51章 Linux 系统优化实战
术语 → 手段 → 工具 → 实战 → 分析思路，五段式完整教学 —— 这是产品化工程师的核心竞争力。

**🎯 学习目标**
- 精确理解 30+ 性能术语，能用数据说话
- 掌握 CPU/内存/IO/网络/启动五大维度的优化手段与适用边界
- 建立「测量→归因→单变量实验→回归固化」的工程化优化流程

### 51.1 术语精确定义（性能语言的字母表）
优化讨论的第一杀手是术语含混。「系统卡」三个字无法定位任何问题 —— 先把语言校准：

| 术语 | 精确定义 | 测量口径/单位 

| 延迟 Latency | 单个事件从请求到完成的耗时 | avg / P95 / P99 / MAX（只看平均是新手标志） 

| 抖动 Jitter | 周期事件发生时刻的波动幅度 | max−min 或标准差（PLC 扫描核心指标） 

| 吞吐 Throughput | 单位时间完成的事务/字节量 | tps / MB/s（与延迟常互斥，需权衡） 

| 负载 Load Average | 1/5/15 分钟内 **可运行+不可中断睡眠(D状态)** 的平均任务数 | 与核数比较：4 核机器 load=4 即饱和；D 状态计入是 Linux 特色（IO 卡顿也会推高 load） 

| 运行队列 Runqueue | 等待 CPU 的就绪任务队列 | vmstat 的 r 列（每核>3 即过载信号） 

| 调度延迟 Sched Delay | 任务变可运行到真正上 CPU 的等待时间 | perf sched latency / /proc/schedstat 

| 自愿/非自愿切换 | 主动让出(IO/锁等待) vs 时间片用尽/被抢占 | vmstat cs 列；非自愿激增=CPU 争抢 

| RT Throttling | 内核限制实时任务每周期最多用 sched_rt_runtime_us/sched_rt_period_us（默认 950ms/1000ms=95%） | 防 RT 任务饿死系统；实时应用偶发 50ms 卡顿的头号嫌疑 

| Page Cache 页缓存 | 内核用空闲内存缓存文件读写 | free 里 buff/cache ——「内存快用完了」多数是假象 

| Dirty Page 脏页 | 已修改未落盘的页；达 dirty_ratio 阈值触发集中回写 | 突发写卡顿（百 ms 级停顿）的经典根因 

| Major/Minor Fault | 缺页需读盘 vs 仅分配/映射 | major 持续非零=内存不足在换页 

| THP 透明大页 | 内核自动合并 2MB 大页降低 TLB miss | 延迟敏感场景的**双刃剑**：合并/拆分引发毫秒级 stall（51.5 案例） 

| mlock | 锁定内存禁止换出/迁移 | 实时进程标配（配合 RLIMIT_MEMLOCK） 

| WCET | 最坏情况执行时间（可分析性的标尺） | 静态分析+实测上界双证据 

| False Sharing | 两核频繁写同一 cache line 的不同变量 | perf c2c 检测；结构体按 64B 对齐隔离 

### 51.2 优化总纲：五层模型与铁律
```
L5 算法/架构      O(n²)→O(nlogn)、批量化、无锁结构     ← 收益最大,先动这里
L4 应用运行时     线程模型/锁粒度/内存分配模式/日志策略
L3 系统库         malloc arena、stdio缓冲、TLS栈
L2 内核参数       调度器/THP/脏页/网络栈/sysctl
L1 硬件与固件     CPU频点/缓存拓扑/存储介质/中断路由
/* 铁律一: 自上而下排查, 自下而上解释 —— 症状在上层显现, 根因常在底层 */
/* 铁律二: 测量先于优化, 基线先于实验, 单变量推进, 回归固化成果 */
/* 铁律三: 优化目标必须量化为 SLO (如: 扫描抖动P99<200μs, 启动<15s, 
   Modbus RTT P99<5ms) —— 没有SLO的优化是玄学 */
```

### 51.3 CPU 与调度优化
#### ① 手段清单

| 手段 | 操作 | 适用/代价 

| 亲和绑定 | `taskset -c 2 app` / `sched_setaffinity()` | 把关键任务钉在专属核；代价：负载不均 

| 核隔离 | cmdline：`isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3` | 隔离核不再被普通任务/RCU/tick 打扰（39章）；代价：可用核减少 

| IRQ 手工分布 | 停 irqbalance → `echo 0 > /proc/irq/55/smp_affinity_list` | 把网卡中断挪离实时核 

| 实时策略 | `chrt -f 80 app`（SCHED_FIFO）；优先级规划：越短周期越高 | 压过一切普通任务；防饿死靠 RT throttling 或预留 CPU 

| RT throttling 调整 | `echo 1000000 > /proc/sys/kernel? sysctl kernel.sched_rt_runtime_us=-1`(关闭) 或调高配额 | 确认无死循环风险后放开；否则保留兜底 

| PREEMPT_RT | 换打补丁内核 | 临界区可抢占、IRQ线程化；抖动从 ms 级→50μs 内；吞吐略降 

| cpuset/cgroup | systemd CPUAffinity= / cgroup v2 cpu.weight | 系统级配额与隔离（容器化部署必配） 

| 调频策略 | `cpupower frequency-set -g performance` | 禁用深睡眠 C-state（exit latency 是延迟尖刺源）：`/dev/cpu_dma_latency` 持有 

#### ② 实战案例 A：PLC 扫描抖动 1.2ms → 80μs
```
【基线】默认系统, 扫描线程普通优先级: P99 抖动 1.2ms, 偶发 8ms
【步骤1】perf sched record -p $(pidof plc_runtime) -- sleep 30; perf sched latency
  → 最大调度延迟 6.8ms, 元凶: kworker 日志回写 + 网卡软中断
【步骤2】isolcpus=1 nohz_full=1 rcu_nocbs=1 + taskset -c 1 扫描线程
  + 网卡IRQ affinity 挪核0 + 关 irqbalance
【步骤3】chrt -f 60 + 持有 /dev/cpu_dma_latency + performance governor
【结果】P99=180μs; 剩余尖刺 3ms/小时 → ftrace 定位到 THP compaction → 见51.5
【最终】关闭 THP 后 P99=80μs, 30 分钟零 >500μs 尖刺
/* 每一步只改一个变量, 每一步都有前后数据 —— 这就是可复现的优化 */
```

### 51.4 内存优化
#### ① 手段清单

| 手段 | 操作 | 要点 

| 锁定内存 | `mlockall(MCL_CURRENT|MCL_FUTURE)` + ulimit -l 调整 | 实时进程防换页/迁移停顿；启动后立即锁并预触碰所有页 

| THP 控制 | `echo never > /sys/kernel/mm/transparent_hugepage/enabled` | 延迟敏感默认关；大内存吞吐服务可开 madvise 

| 预留大页 | `sysctl vm.nr_hugepages=64` + mmap MAP_HUGETLB | DPDK 类数据面；TLB miss 显著下降 

| malloc 调优 | `mallopt(M_MMAP_THRESHOLD, 131072)` / M_ARENA_MAX | 多线程偶发 brk/mmap 系统调用尖刺的解药 

| 脏页策略 | sysctl vm.dirty_background_ratio=5, dirty_ratio=15, dirty_expire_centisecs | 削平回写尖峰；实时系统改 dirty_bytes 小值 

| 泄漏/越界 | valgrind / ASan / kmemleak（39章） | 优化前先保证正确性 

#### ② 实战案例 B：Web 监控页偶发 200ms 尖刺
```
【现象】每 5~10 分钟随机一次 HTTP 响应 200ms+（平时 8ms）
【排查】perf record -g 抓尖刺窗口 → 火焰图出现 __compact_memory? 
        /sys/kernel/debug/mm/compaction? → 用 ftrace 确认 mm_compaction 事件
【归因】THP 后台 compaction 运行时锁住页表, 所有进程缺页处理被拖慢
【修复】THP=never (该负载无大块连续内存需求) + RSS 预留验证
【回归】72h 老化: 尖刺归零; 内存碎片化指标无恶化
/* 教训: "内核为你好自动做的事"常常是延迟敏感系统的敌人 */
```

### 51.5 I/O 与文件系统优化
#### ① 调度器选择表

| 介质 | 推荐调度器 | 理由 

| NVMe SSD | none | 设备内部并行调度,内核再调度纯开销 

| SATA SSD/eMMC | mq-deadline | 保读写延迟上界 

| 机械盘 | bfq | 公平性防大IO饿死小IO 

| 查看/切换 | `cat /sys/block/mmcblk0/queue/scheduler` 

#### ② 手段与实战

- **fsync 代价**：eMMC 上一次 fsync 可达 10~50ms！数据记录器方案：**组提交**（攒 N 条/50ms 批量 fsync）+ 独立落盘线程与业务解耦；
- **挂载选项**：`noatime`（省读放大）、`commit=15`（ext4 回写间隔）、日志模式 data=ordered 权衡；
- **O_DIRECT** 绕过页缓存自管缓冲（数据库式负载），注意对齐要求；
- **fstrim 定时**：SSD/eMMC 长期写性能维持；
- **实战案例 C**：数据记录器每 10 分钟出现 300ms 卡顿 → 定位为 journal commit + dirty 回写风暴 → 改组提交 + dirty_background_bytes=4MB + 独立分区 → 卡顿消失，掉电丢数据窗口从「不确定」变为「≤2s 可承诺」。

### 51.6 网络优化

| 维度 | 手段 | 命令/位置 

| 缓冲区 | 按带宽时延积 BDP 设 rmem/wmem | `sysctl -w net.core.rmem_max=... net.ipv4.tcp_rmem="4096 87380 4194304"` 

| 拥塞控制 | 长肥管道换 BBR | `sysctl net.ipv4.tcp_congestion_control=bbr` 

| 中断合并 | 权衡延迟与中断率 | `ethtool -C eth0 rx-usecs 32`（实时场景调小） 

| 多核分发 | RPS/RFS/XPS 把包处理分散 | `/sys/class/net/eth0/queues/rx-*/rps_cpus` 

| 端口/连接 | 端口耗尽与 TIME_WAIT | ip_local_port_range + tcp_tw_reuse + 连接池 

| 协议选择 | 本机高频小消息 | Unix socket/共享内存 优于 TCP 回环（省协议栈） 

### 51.7 启动时间优化（产品体验硬指标）
```
# 测量三板斧
systemd-analyze                    # 总耗时: 固件+内核+用户态
systemd-analyze blame | head -15   # 各服务耗时排行
systemd-analyze critical-chain plc.service   # 关键路径链
# 内核段: initcall_debug + printk.time=1 → dmesg 时间戳分析(14章)
【45s→12s 实战清单】
 ① U-Boot: bootdelay=0, 关闭多余探测, silent console(-3s)
 ② 内核: 裁剪无用驱动/文件系统, initcall 慢项改模块后置(-8s)
 ③ rootfs: 改用 squashfs+只读(挂载快), 关 fsck
 ④ 服务: 串行依赖改并行(Type=simple+After 最小化), 网络等待改 ip=静态
    去掉 NetworkManager-wait-online(-10s), 日志改 volatile
 ⑤ 应用: 延迟启动非关键服务(10s 后再拉起), 预链接 prelink? ldconfig 缓存
/* 原则: 先测量后删减; 每删一项确认功能无回归 */
```

### 51.8 工具箱全景表（一页备查）

| 看什么 | 工具与命令 | 健康判据示例 

| CPU 各核/中断占比 | `mpstat -P ALL 1`; `cat /proc/interrupts`(两次差分) | %soft 集中单核=需 RPS/XPS 

| 调度延迟 | `perf sched record/latency`; /proc/schedstat | 实时任务 max delay < SLO 

| 上下文切换 | `vmstat 1`(cs列); pidstat -w | 非自愿切换持续高=CPU 争抢 

| 内存与换页 | `vmstat 1`(si/so 应为0); ps -eo rss,comm --sort -rss | si/so≠0 即物理内存不足 

| 块设备延迟 | `iostat -x 1`(await/util) | util>80% 持续=瓶颈 

| 网络丢包重传 | `ss -s; netstat -s | grep -i retrans` | 重传率<0.1% 

| 热点函数 | perf record/report/火焰图（39章） | Top1 <30% 为健康 

| 系统调用画像 | `strace -c -p PID` | 发现意外 syscall(如频繁 stat) 

| 综合基线 | sar 定时采集(历史回溯); tuned-adm profile | 变更前后对比的证据库 

### 51.9 系统化分析思路（决策树 + 报告模板）
```
【症状分类 → 首查动作】
A 延迟尖刺(偶发慢) ─▶ ① 时间相关性: 周期性?(定时器/回写/compaction)
                      ② ftrace/perf 抓尖刺窗口内核在干嘛
                      ③ 检查 THP/脏页/RT throttling/C-state
B 吞吐不足(持续慢) ─▶ ① 找瓶颈层: CPU(mpstat)/IO(iostat)/网(ss) 谁先饱和
                      ② 饱和层内找热点(火焰图); 未饱和=锁/依赖串行
C 资源耗尽(OOM/磁盘满/连接数) ─▶ 泄漏排查(39章) + 配额与告警
D 启动慢 ─▶ 51.7 清单

【优化报告模板(每次优化必交)】
1. 现象与SLO   2. 基线数据   3. 假设与依据
4. 实验记录(单变量, 前后数据)   5. 结论与残余风险
6. 固化措施: sysctl/服务配置进版本库 + 回归用例
```

### 51.10 火焰图与性能可视化深入 ★
#### ① 火焰图是什么（先建立正确心智）
火焰图是把**成千上万次采样的调用栈**聚合后画成的一张矩形图：每一列是一个调用栈，**x 轴宽度 = 该函数占用的 CPU 时间比例（按字母排序，不是时间轴！）**，y 轴是栈深度（顶=叶子函数，即真正在执行的代码），颜色默认随机暖色（无含义）。

```
# 生成全流程（板上采样 + 主机出图）
# 板上：
perf record -F 99 -g -p $(pidof plc_runtime) -- sleep 30   # 99Hz 采30秒
perf script > out.stacks
scp out.stacks host:~/                                       # 回传主机
# 主机（FlameGraph 工具集）：
git clone https://github.com/brendangregg/FlameGraph
stackcollapse-perf.pl out.stacks > out.folded
flamegraph.pl --title "plc_runtime CPU" out.folded > flame.svg
# 浏览器打开 flame.svg：点击矩形可下钻；Ctrl+F 按函数名搜索高亮
```
#### ② 解读五规则（新手→专家的分界）

- **找平顶（Plateau）**：顶部宽而平的矩形 = 热点叶子函数；宽度即优化收益上限；
- **看塔的形状**：又尖又窄=调用路径健康分散；底部一块巨宽的"大陆"=某条路径垄断 CPU；
- **宽度即预算**：某函数占 40% → 即使优化到零，总吞吐最多提升 1/(1-0.4)≈1.67 倍 —— 先算收益再动手（Amdahl 直觉）；
- **缺失帧排查**：栈不完整=编译没带 `-g` 或缺 frame pointer（加 `-fno-omit-frame-pointer`）；内核栈缺=权限；
- **x 轴不是时间**！想看"什么时刻在执行什么"，用时间线类工具（perf timechart / Tracealyzer / Chrome tracing 格式），火焰图只回答"谁最耗 CPU"。

#### ③ 三种必会变体

| 变体 | 回答的问题 | 生成方式 

| On-CPU 火焰图 | CPU 时间花在哪 | 上文标准流程 

| **Off-CPU 火焰图** | **线程阻塞在等什么**（锁/IO/事件）——延迟问题的正解！ | eBPF：`/usr/share/bcc/tools/offcputime -p PID` → 同样折叠出图 

| 差分(Diff)火焰图 | 优化前后谁变宽谁变窄（红增蓝减） | flamegraph.pl --diff? difffolded.pl before.folded after.folded | flamegraph.pl 

💡 延迟问题的黄金法则
CPU 火焰图很"空"（没有明显热点）但延迟仍高 → 问题几乎必然在 **Off-CPU**：等锁、等 IO、等事件。此时 on-CPU 图继续死磕是南辕北辙 —— 切换到 offcputime/eBPF 视角。这是性能分析最重要的视角切换。

### 51.11 优化种类 I：内存优化深入
#### ① 成本直觉：一次访存到底多贵

| 层级 | 典型延迟(A9 量级) | 工程含义 

| L1 Cache (32KB) | ~4 周期 | 热点数据要挤进这里 

| L2 Cache (512KB 共享) | ~12 周期 | 3×L1 —— 跨核共享也是争用源 

| DDR3 | 100+ 周期 | **30×L1**！一次 miss 抵消几十条指令优化 

#### ② 分配策略：从 malloc 到池化
malloc 三宗罪：碎片（长期运行致命）、锁争用（多线程）、偶发系统调用（brk/mmap 尖刺）。对策按序：

```
/* 对象池：定长块 O(1) 分配回收，零碎片零系统调用 —— 实时系统标配 */
typedef struct node { struct node *next; } node_t;
static node_t *freelist;
void *pool_alloc(void){ if(!freelist) return NULL;
    node_t *n = freelist; freelist = n->next; return n; }
void pool_free(void *p){ node_t *n = p; n->next = freelist; freelist = n; }
/* 初始化: 把一大块内存切成 N 个 node 串成 freelist —— 启动一次搞定 */

/* Arena（竞技场）：批量分配、整体释放 —— 适合"请求级"生命周期 */
/* 33章 Web 请求: arena_alloc 解析JSON的临时对象, 响应完 arena_free 一次归还 */
```
#### ③ 碎片两兄弟

- **内部碎片**：申请 33B 得到 48B（对齐+头部浪费）→ 定长池按真实尺寸分级；
- **外部碎片**：总空闲够但连续块不够 → 长跑系统对大块（缓冲区）**启动期一次性分配**，运行期只走定长池。

#### ④ Cache 友好编码：AoS vs SoA 实测
```
/* 需求: 每周期只更新 1000 个点的 x 坐标 */
struct pt { float x,y,z; uint8_t flags; };          /* AoS: 16B/点 */
struct pt pts[1000];  for(i..) pts[i].x += 1;       /* 步长16B用4B → cache有效载荷25% */

float xs[1000], ys[1000], zs[1000]; uint8_t fl[1000];  /* SoA */
for(i..) xs[i] += 1;   /* 顺序满行 → 每条cache line 100%利用 + 硬件预取友好 */
/* 实测(A9): SoA 版本该循环快 2~3× —— 数据布局是"免费的优化" */
/* 反面: false sharing —— 两核各写同一 line 的不同变量 → 按 64B 对齐隔离 */
```
#### ⑤ 其他要点

- **拷贝消除**：传指针/索引而非值；日志格式化"先计数后一次性写"；字符串用长度前缀避免反复 strlen；
- **内存预算制**：每个模块在头文件注释声明 RSS 预算（如 `// MEM BUDGET: 2MB`），CI 监控超预算即报警 —— 泄漏在萌芽期被抓（51.15 案例的制度化成果）。

### 51.12 优化种类 II：通讯优化深入 ★
#### ① 优先级排序（收益从大到小）
```
减少交互次数 > 减少传输字节 > 减少拷贝次数 > 减少上下文切换
/* 每往左一级, 通常是数量级的收益; 反向微调(改个缓冲区大小)常是白忙 */
```
#### ② 批量化：一次事务搬一批

| 方案 | 事务数 | 每事务开销(请求8B+响应5B+RTT5ms) | 总耗时 

| 逐点轮询 100 点(FC03 单点) | 100 | RTT 5ms | **≈500ms** 

| 批量 FC03 一次读 100 寄存器 | 1 | RTT 5ms + 从站处理 2ms | **≈7ms**（71×） 

| JSON 上报 100 点(每点15B) | - | 序列化+解析 ~150μs/次 | 二进制定长 200B → ~2μs（75×） 

```
/* 通讯负载的"账本思维": 每字节都要记账 */
RTU 帧账本: 地址1+功能码1+数据N+CRC2 → N=1 时开销 400%! N=100 时 4%
结论: 协议效率 = 数据占比; 优化方向永远是"攒大了再发"。
但注意反向约束: 控制类小消息(急停)不能为效率牺牲时效 → 分通道策略。
```
#### ③ Socket 层手段

| 手段 | 命令/代码 | 场景 

| 禁 Nagle | `setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&y,4)` | 交互式小包(Modbus!)必开，否则 200ms 合并延迟 

| 缓冲区对齐 BDP | sysctl tcp_rmem/wmem（51.6） | 长肥管道吞吐 

| 聚合写 | writev / 用户态缓冲攒批 | 减少 syscall 次数 

| 零拷贝 | sendfile(文件→socket) / 共享内存(本机) | 大块数据；本机高频用 29 章映像区 

| io_uring | Linux 5.1+ 异步提交 | syscall 密集型服务的下一代方案（了解） 

#### ④ 连接与轮询架构
```
/* 多从站轮询: 串行→并发+自适应超时 (51.16 案例核心) */
typedef struct { int fd; int dev; int rtt_ms; int fails; } conn_t;
/* epoll 统一管理 N 条连接; 每轮: 对就绪设备发请求, 收齐/超时即结算
   自适应: 连续 5 次 RTT<10ms → 轮询间隔×0.8; 超时 → 间隔×2 并告警 */
```

### 51.13 优化种类 III：并发与锁优化（精要）

- **锁的真实代价**：无争用加解锁 ~20ns；争用时陷入内核+futex 唤醒 = μs 级 + cache line 在核间弹跳（每次 ~100 周期）—— 所以"锁很贵"的准确表述是"**争用的锁很贵**"；
- **手段阶梯**（从首选到慎用）：缩小临界区 → 减少共享(改传值/消息) → 读写锁/RCU → **分片 sharding**（N 把锁各管 1/N 数据，示例：统计计数按核分片最后求和）→ 无锁结构（kfifo/DPDK ring，注意 ABA 与内存序，37章）；
- **诊断**：perf lock? /proc/lock_stat 排名争用 Top；火焰图中 futex_wait 宽塔 = 锁瓶颈实锤。

### 51.14 性能分析方法论深入：USE / RED / Off-CPU / 统计严谨性
#### ① USE 方法（资源层系统排查）——对每种资源问三个问题

| 资源 | Utilization 利用率 | Saturation 饱和度 | Errors 错误 

| CPU | mpstat usr+sys per核 | runqueue r 值 / 调度延迟 | machine check / throttling 

| 内存 | available 比例 | si/so 换页 / pgmigrate/compact | OOM kill / ECC 

| 存储 | iostat %util | await 队列时间 | /sys/block/*/stat err 计数 

| 网络 | 带宽占比(sar -n DEV) | drop/overflow 计数 | CRC/重传率 

#### ② RED 方法（服务层）
对每个服务监控三曲线：**R**ate（每秒请求数）/ **E**rrors（错误率）/ **D**uration（耗时分布）—— 三线同看，异常组合即定位（如 R 不变 E 涨 = 依赖劣化）。

#### ③ Off-CPU 分析（延迟问题的正解视角）
线程时间 = on-CPU + off-CPU。延迟类问题（"偶尔卡"）的答案通常藏在 off-CPU：

```
# eBPF: 统计线程每次阻塞的时长与阻塞点
/usr/share/bcc/tools/offcputime -K -p $(pidof plc_runtime) 30
# 输出解读: futex_wait_wait? → 等锁; poll_schedule → 等IO/事件;
#           io_schedule → 等盘; 累计时长排序 = 优化优先级
/* 与 on-CPU 火焰图互补: 两张图合起来 = 线程一生的完整画像 */
```
#### ④ 统计严谨性四则

- **看分位数不看平均**：P99/P999/MAX 才是用户体验与 SLO 的语言；
- **警惕采样偏差**：perf 只采 on-CPU 样本 —— 阻塞中的问题它"看不见"（回到 off-CPU）；
- **样本量与噪声带**：先测空载系统 30 分钟建立噪声带，超出噪声带的变化才叫"优化效果"；
- **回归检测制度化**：基线数据进版本库，CI 自动对比，超噪声带即阻断（51.9 报告模板第 6 项的落地）。

### 51.15 端到端实战案例 I：内存泄漏 + 碎片化（完整走查）★
```
【背景】软 PLC 运行时 72h 老化: RSS 从 12MB 线性涨到 40MB, 第 3 天偶发
       Web 请求 malloc 返回 NULL(实际物理内存充足)
【Step1 定性: 泄漏还是碎片?】
  cat /proc/$(pidof plc_runtime)/smaps → [heap] 段持续涨 = 应用层泄漏/碎片
  (若是匿名 mmap 涨 → 另查线程栈/大块分配)
【Step2 ASan 立即抓泄漏】
  交叉编译加 -fsanitize=address -g → 跑 2h 压测 → ASan 报告:
    Direct leak of 64 bytes in 1 objects allocated from:
      #0 strdup  #1 json_parse_value  #2 api_status  web.c:88
  → 根因1: Web 层每次请求 strdup 设备名未释放(每天 86400 次 × 64B ≈ 5MB/天 ✓ 对得上!)
  修复: 解析完即 free / 改 arena(请求级一次性释放)
【Step3 泄漏修后: RSS 稳定在 18MB, 但 malloc 偶发失败仍在 → 碎片!】
  malloc_stats? malloc_info(stdout) → fastbin/自由列表大量空洞
  → 根因2: 三种尺寸(64B/256B/8KB)消息混用一个堆 → 外部碎片
  改造: 8KB 消息缓冲改启动期静态池(51.11 池化); 64/256B 走定长池
【Step4 制度化】
  · 每模块头文件声明内存预算; CI: 24h 老化 RSS 斜率必须 ≈0
  · 回归脚本: 老化后自动跑 ASan 快扫
【前后数据】RSS 12→40→18MB(稳定); malloc 失败 0; 交付承诺"30天免重启"
/* 反思: 泄漏是"错误", 碎片是"设计缺陷" —— 后者更隐蔽, 靠预算制度预防 */
```

### 51.16 端到端实战案例 II：Modbus 主站轮询吞吐优化（完整走查）★
```
【背景与SLO】主站需 100ms 周期轮询 10 台从站×20 寄存器; 实测单轮 350ms ✗
【Step1 时间线分解(测量先行)】
  tcpdump 抓单轮: 每事务 RTT≈30ms(请求5ms+从站响应等待25ms) × 10 台串行
  = 300ms + 本地处理 50ms(JSON解析居然占 45ms!) → 两个瓶颈并存
【Step2 归因与方案排序(收益×成本)】
  瓶颈A 串行架构: 并发化收益 10× → 首选
  瓶颈B JSON解析: 换二进制定长 → 45ms→1ms
【Step3 实施(单变量推进)】
  优化① epoll 管理全部 10 连接, 请求全发后统一收(并发度10)
     → 单轮 350→85ms ✓ (受最慢从站约束, 符合理论 30ms+处理)
  优化② 上报改二进制定长帧 → 处理 45→1.2ms
  优化③ TCP_NODELAY + 自适应间隔(连续快→收紧, 超时→放宽)
【Step4 结果表】
  | 指标        | 优化前 | 优化后 |
  | 单轮耗时    | 350ms  | 85ms   |
  | CPU占用     | 31%    | 12%    |
  | 最慢从站RTT | 30ms   | 28ms(物理极限) |
【Step5 反思与边界】
  28ms 是从站固件的处理时间 —— 我方已触达物理边界, 继续压榨只能
  换从站固件或降点表规模。优化到边界即止, 把剩余预算留给未来。
/* 全流程用时 2 天; 若无测量先行, 大概率先去"优化"解析代码而收益 1ms 级 */
```

### 51.17 技术反思与总结（十条原则 + 反模式清单）

| # | 原则 | 一句话展开 

| 1 | 测量先行 | 没有基线的"优化"是玄学；先建观测，再谈改进 

| 2 | 90/10 定律 | 时间花在热点 10% 代码上；火焰图找平顶而非凭感觉 

| 3 | 预算制设计 | CPU/内存/延迟预算写进模块头文件，超支即 CI 阻断 

| 4 | 可观测性是功能 | 指标/日志/追踪与业务代码同等级评审与测试 

| 5 | 简单性优先 | 能加缓存解决的先别上无锁；能单线程的别上多线程 

| 6 | 边界意识 | 识别物理极限(从站RTT/总线带宽)，优化到边界即止 

| 7 | 单变量推进 | 一次只改一件事，前后数据留档 

| 8 | 视角切换 | on-CPU 看热点，off-CPU 看等待，USE 看资源，RED 看服务 

| 9 | 固化成果 | 优化结论=配置进版本库+回归脚本+报告归档 

| 10 | 优化是循环 | SLO 会随业务升级，观测体系是长期资产而非一次性项目 

⚠️ 反模式清单（对照自查）
① 玄学调参：抄网上 sysctl 不理解含义；② 只看平均值宣布优化成功；③ 微优化（省几条指令）忽略架构级瓶颈；④ 无基线宣称"提升 10 倍"；⑤ 优化代码不更新测试预期；⑥ 在观测工具高开销下得出的结论当真；⑦ 把编译器会做的优化手写一遍。

### 常见问题 FAQ（避坑指南）
Q1：free 显示内存快用完了，要加内存吗？先看 available 列与 si/so。buff/cache 是页缓存可随时回收，不算压力；真正警报是 available 低 + 持续 si/so 换页 + major fault 高。

Q2：把所有进程都设成 SCHED_FIFO 最高优先级行不行？不行——实时任务互相无时间片(RR 除外)，全高优先级等于互相饿死且可能饿死内核线程触发 RT throttling 惩罚。优先级必须**按截止期严格分层**且只授予真正实时的任务。

Q3：优化后实验室达标，客户现场又复现尖刺？现场差异项逐一核对：温度降频(throttling)、电源质量、网络拓扑广播量、第三方软件混部、NTP 步进调整时钟。对策：现场版 sar 持续采集回传 + 远程一键抓取脚本（把 51.9 决策树做成工具）。

**🧪 动手实验 L51-1：完整优化项目（综合验收）**
以你的软 PLC 为对象执行一轮完整优化：① 定义三项 SLO（扫描抖动/Modbus RTT/启动时间）；② 按本章流程完成基线测量与三项优化（至少覆盖 CPU、内存、启动各一）；③ 产出《优化报告》含前后对比数据；④ 所有变更固化为配置文件进 Git，并写一个回归脚本自动验证 SLO。完成即达到「独立负责产品性能」的能力水位。

**📝 思考题**
- load average 很高但 CPU 使用率很低，可能是什么情况？如何验证？
- 为什么实时场景建议关闭 THP，而数据库服务器有时反而开 madvise 模式？决策变量是什么？
- 设计「性能回归门禁」：CI 中自动跑基线脚本，什么条件下判定为性能退化并阻断合并？

[← 上一篇第50章 SeL4微内核解析与实践](#ch50)
[下一篇 →附录A 面试题库·FPGA/ZYNQ专项](#appa)

---

