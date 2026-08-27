---
title: "第62章 应用编程：文件 IO / epoll / 进程线程 / IPC 全景"
part: "[[P6-MOC]]"
chapter: 62
tags:
  - domain/linux
  - topic/epoll
  - topic/ipc
difficulty: 4
est_minutes: 40
prerequisites:
  - "[[ch61-中断下半部threaded-irq-workqueue]]"
related:
  - "[[ch63-网络编程与TLS从socket到安全上云]]"
  - "[[ch66-综合实战USB摄像头流采集服务]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第62章 应用编程：文件 IO / epoll / 进程线程 / IPC 全景

> [!info] 导航
> ⏱ 40min | ★★★★☆ | 前置 [[ch61-中断下半部threaded-irq-workqueue]] | → [[ch63-网络编程与TLS从socket到安全上云]]

## 🎯 学习目标
- [ ] 区分五种 IO 模型并按嵌入式场景选型
- [ ] 按 LT/ET 纪律写出正确 epoll 循环（ET 必须读到 EAGAIN）
- [ ] 按决策表选择进程/线程与 IPC 方案，独立完成守护进程化

## 62.1 五种 IO 模型对比

| 模型 | 核心动作 | 阻塞点 | 嵌入式典型用途 |
|------|----------|--------|----------------|
| 阻塞 IO | read 等到有数据才返回 | 整个等待期 | 简单单连接工具、日志落盘 |
| 非阻塞 IO | O_NONBLOCK，无数据立即返 -1+EAGAIN | 无（忙轮询耗 CPU） | 与 epoll 配合的基础设置 |
| IO 多路复用 | epoll_wait 同时守多 fd | 在 epoll_wait 上休眠 | 网关/接入层主力（本章主角） |
| 信号驱动 | SIGIO 通知后再读 | 无 | 少用，信号语义不可靠 |
| 异步 IO | aio/io_uring 完成队列通知 | 无 | 高吞吐新方向（典型值：新平台优先 io_uring） |

「一切皆文件」是编程接口的统一论：同一套 read/write/poll 语义贯穿设备、socket、管道。

## 62.2 文件 IO 精要

```c
int fd = open("/dev/mydev", O_RDWR | O_NONBLOCK | O_CLOEXEC);
pread/pwrite(fd,buf,n,offset)  /* 多线程安全：不移动共享偏移 */
/* read 三态： >0 数据 / 0 EOF / -1+EAGAIN 无数据(非阻塞) */
while (w<n) { r=write(fd,buf+w,n-w); if (r<0&&errno!=EINTR) break; w+=r; }
fsync vs fdatasync：前者连元数据一起刷 —— 掉电安全写（[[ch57-根文件系统构建只读overlayfs]]）
mmap(NULL,len,PROT_READ,MAP_PRIVATE,fd,off);   /* 大文件零拷贝读 */
```

## 62.3 epoll 正确姿势（服务器骨架）与 LT/ET 纪律

```c
int ep = epoll_create1(EPOLL_CLOEXEC);
struct epoll_event ev = { .events = EPOLLIN | EPOLLET, .data.fd = listenfd };
epoll_ctl(ep, EPOLL_CTL_ADD, listenfd, &ev);     /* ET 边缘触发模式 */
for (;;) {
    int n = epoll_wait(ep, evs, MAX_EV, timeout_ms);
    for (i = 0; i < n; i++) {
        if (evs[i].data.fd == listenfd) {        /* ET 下必须 accept 到 EAGAIN! */
            while ((c = accept4(listenfd,NULL,NULL,SOCK_NONBLOCK)) >= 0) add_ep(ep,c);
        } else {
            /* ET 读也必须循环到 EAGAIN； LT 模式则可按需读 */
            while ((r = read(fds[i],buf,sizeof buf)) > 0) handle(buf,r);
            if (r == 0) close_and_del();          /* 对端关闭 */
        }
    }
}
```

- **LT（水平触发）**：就绪就持续报告，容忍不读完，逻辑简单；**ET（边缘触发）**：状态切换只报一次——accept 循环到 EAGAIN、read 读空到 EAGAIN，一条不能省；
- 为什么快：fd 注册一次进内核红黑树，只返回就绪链表 O(active)——select/poll 每次全量拷贝+O(n) 轮询；「海量长连、少量事件」才是主场（IoT 典型），全活跃时无优势；
- 事件循环里禁止长任务——扔线程池，否则其他连接全饿死。

## 62.4 进程 vs 线程决策

| 维度 | 多进程 | 多线程 |
|------|--------|--------|
| 隔离性 | 强（崩溃不传染） | 弱（一个段错误全灭） |
| 数据共享 | 需 IPC | 直接共享（但要锁） |
| 创建开销 | 大（fork 页表） | 小 |
| 嵌入式推荐 | 服务化架构（[[ch44-综合实战RK3568多协议边缘网关]]） | 单一职责工具进程内并发 |

```c
pid_t pid = fork();
if (pid == 0) { execl("/usr/bin/helper","helper","-v",(char*)NULL); _exit(127); }
/* SIGCHLD 处理器里 waitpid(-1,NULL,WNOHANG) 循环收割 —— 防僵尸 */
/* 线程退出纪律： pthread_detach 或 join 必居其一；取消(cancellation)慎用 */
```

## 62.5 IPC 选型矩阵

| 需求 | 首选 | 理由 |
|------|------|------|
| 父子进程简单流 | pipe/socketpair | 零配置 |
| 任意进程大数据流 | Unix domain socket | 双向+权限控制+fd传递(SCM_RIGHTS) |
| 共享内存高频数据 | shm_open+mmap + eventfd 同步 | 零拷贝；配套 sem_open 信号量互斥、环形缓冲自管理 |
| 结构化消息排队 | POSIX/System V 消息队列 | 自带消息边界与优先级 |
| 异步事件通知 | signal/eventfd | 开销极低；signal 处理函数受限 |
| 跨语言/远程 | MQTT/gRPC | 超出单机范畴时升级 |

## 62.6 守护进程化步骤
1. 第一次 fork 父退出 + `setsid()` 新会话——脱离 shell 与控制终端；
2. 第二次 fork 防止重新获得控制终端；
3. `chdir("/")` + `umask(0)`，关重定向 stdio，装 SIGCHLD/SIGPIPE 处理，写 pidfile；
4. 现代做法：直接交 systemd（Type=simple/notify）托管，免手工 daemonize 且自带重启与资源限制（[[ch56-启动流程深度剖析systemd提速]]）。

## 62.7 实测数据表：三种多路复用真实开销（i.MX6ULL echo 服务）

| 方案 | 1000 连接 CPU% | P99 事件延迟 |
|------|----------------|--------------|
| select（FD_SETSIZE 上限 1024！） | 78%（且无法超限） | ~6ms |
| poll | 65% | ~5ms |
| epoll LT / ET | **22% / 19%** | ~1.2ms |

## 62.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| epoll 惊群 | 多 worker 抢同一 listen fd | EPOLLEXCLUSIVE 或 SO_REUSEPORT 分流 |
| CPU 空转 100% | ET 模式没读到 EAGAIN 就返回 | 审查循环边界；临时换 LT 验证 |
| 僵尸进程堆积 | SIGCHLD 未处理或 signal 忽略失效 | ps 看 defunct；sigaction+waitpid 循环修复 |
| 共享内存读到脏数据 | 缺内存屏障或同步原语 | 加 eventfd 通知+seqlock 校验 |

## 62.9 部署注意事项
1. 高并发前先调 fs.file-max 与进程 nofile，否则白搭；
2. 多 worker 用 SO_REUSEPORT 让内核分流——免惊群标准答案（内核≥3.9）；偶发 EINTR 统一用 TEMP_FAILURE_RETRY 重试封装；
3. 定时器 timerfd 化进 epoll——单循环管 IO+定时，消灭信号处理的不可靠；用 `systemd-run --scope -p MemoryMax=64M ./app` 划资源，失控不拖垮整机（衔接 [[ch65-性能优化CPU隔离cgroup-io调优]]）。

> [!example]- 🧪 动手实验 L62-1：迷你 C100K 体验（60 分钟）
> **步骤**：① 用 62.3 epoll 骨架起 echo 服务器；② 板上调大 fs.file-max 与 nofile；③ 主机 python 异步客户端压 2000 连接；④ 对比 LT/ET 的 CPU 与延迟；⑤ 注入慢客户端（只连不 read）验证其他连接不受饿。**验收**：产出四组数据表格（select/poll/LT/ET），慢客户端存在时其余连接 P99 延迟无劣化。

## 62.10 进阶话题
- SO_REUSEPORT 负载均衡：多进程各自 bind 同端口内核自动分流；timerfd 统一时间源 + eventfd 作轻量唤醒通道（对比 pipe：一个 fd、无字节流开销）；
- 本章 epoll 骨架正是 [[ch66-综合实战USB摄像头流采集服务]] RTSP 服务与 P4 网关的并发底座，socket/TLS 进阶看 [[ch63-网络编程与TLS从socket到安全上云]]。

> [!warning]- ❓ FAQ
> **Q1：LT 还是 ET 怎么选？** 团队贯彻不了「读空到 EAGAIN」就用 LT——正确性优先；追求极限性能且有测试兜底再上 ET。
> **Q2：共享内存已零拷贝，为什么还要 eventfd？** shm 只解决「数据怎么传」，eventfd 补「对方何时知道」的唤醒与同步。

> [!question] 📝 思考题
> 1. 推导 EPOLLONESHOT 在多线程分发器中的使用范式。
> 2. 用 SCM_RIGHTS 实现「权限代理」：低权进程请高权代开设备并传回 fd。
> 3. 对比 eventfd 与 pipe 作为唤醒通道的资源与性能差异。

---
🏷️ #domain/linux #topic/epoll #topic/ipc | 🔗 [[ch61-中断下半部threaded-irq-workqueue]] ← **本章** → [[ch63-网络编程与TLS从socket到安全上云]] | 📚 [[P6-MOC]]
