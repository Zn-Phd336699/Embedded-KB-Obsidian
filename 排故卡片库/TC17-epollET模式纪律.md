---
title: "TC17 epoll 边缘触发模式下连接假死、数据滞留"
tags:
  - troubleshooting
  - linux/epoll-network
severity: high
frequency: common
source: "[[ch62-应用编程epoll进程线程IPC]]"
date: 2025-01-15
---
# TC17 epoll ET 模式读空纪律

## 现象
ET 模式下客户端明明发了数据，服务端从此收不到（连接假死），对端分片发送或负载高时必现；改回 LT 立即恢复。典型触发：一次 EPOLLIN 没把接收缓冲读完。

## 环境与适用范围
适用 Linux epoll + 非阻塞 socket 反应堆模型（nginx/redis 同款）。不适用 select/poll（无 ET 概念）与阻塞 IO。

## 取证过程
1. 复现构造：客户端单次 send 大块数据（大于 socket 接收缓冲），服务端停止响应。
2. `strace -f -e trace=read,recvfrom,epoll_wait -p <pid>`：观察每次 read 返回值——事件处理后是否从未读到 EAGAIN 就退出。
3. `ss -tnmp | grep <port>`：Recv-Q 有积压却无新 EPOLLIN，坐实「事件已消费、数据没读完」。
4. 核对 fd 属性与代码审查：确认 O_NONBLOCK 已设——ET 下阻塞 read 会卡死整个事件循环。
5. 对照实验：临时改回 LT 复测，若恢复即锁定根因。

## 根因
ET 只在状态跳变时通知一次。一次 EPOLLIN 中没读到 EAGAIN，剩余数据不再产生新事件，永久滞留；写侧同理，可写通知也只用一次。

## 修复方案
```c
for (;;) {
    ssize_t n = read(fd, buf, sizeof buf);
    if (n > 0) { append(conn, buf, n); continue; }      /* 继续读 */
    if (n == 0) { close_conn(conn); break; }            /* 对端关闭 */
    if (errno == EAGAIN || errno == EWOULDBLOCK) break; /* 读空，本次结束 */
    if (errno == EINTR) continue;
    close_conn(conn); break;
}
/* 写侧：数据发不完挂输出队列并注册 EPOLLOUT，
   写完立即 epoll_ctl(MOD) 撤销，否则 busy-loop */
```

## 预防措施
- ET 必配 O_NONBLOCK；读写循环到 EAGAIN/EWOULDBLOCK 才退出
- 发送不完的数据挂应用层输出队列，写完即撤销 EPOLLOUT
- 评审 checklist：每个 read/write 必须有 EAGAIN 分支
- 上线前用大报文 + 慢速客户端专项压测
- 连接级看门狗：空闲超时主动踢除，让假死无处藏身

## 关联
- 源章节：[[ch62-应用编程epoll进程线程IPC]]
- 相关章节：[[ch63-网络编程与TLS从socket到安全上云]] [[ch80-以太网与lwIP协议栈源码导读]]
