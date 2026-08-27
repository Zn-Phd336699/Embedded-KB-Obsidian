---
title: "第66章 综合实战：USB摄像头流采集服务"
part: "[[P6-MOC]]"
chapter: 66
tags:
  - domain/linux
  - topic/v4l2
  - topic/video
difficulty: 5
est_minutes: 45
prerequisites:
  - "[[ch65-性能优化CPU隔离cgroup-io调优]]"
related:
  - "[[ch79-USB协议与驱动枚举描述符HID-CDC-Gadget]]"
  - "[[ch91-P5-RK3568边缘AI盒子多路视频检测推流]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第66章 综合实战：USB摄像头流采集服务

> [!info] 导航
> ⏱ 45min | ★★★★★ | 前置 [[ch65-性能优化CPU隔离cgroup-io调优]] | → [[ch67-AOSP架构与源码编译]]

## 🎯 学习目标
- [ ] 独立实现 V4L2 MMAP 流式采集循环并检测丢帧
- [ ] 说清 MJPEG vs YUYV 的带宽账并完成硬编码推流出图
- [ ] 用 epoll 单线程完成多客户端分发，一次编码多路转发
- [ ] 落地 systemd 看门狗托管与 USB 掉线自恢复状态机

## 66.1 V4L2 采集核心循环（MMAP 四步曲）
```c
/* ① 设备协商 */
int fd = open("/dev/video0", O_RDWR);
ioctl(fd, VIDIOC_S_FMT, &fmt);       /* 宽高/像素格式 YUYV/MJPEG */
ioctl(fd, VIDIOC_REQBUFS, &req);     /* 申请 N 个内核缓冲 */
/* ② MMAP 映射全部缓冲到用户态（零拷贝基础） */
for (i = 0; i < n; i++){ ioctl(fd, VIDIOC_QUERYBUF, &buf); bufs[i]=mmap(...); }
/* ③ 入队启动 */
for (i = 0; i < n; i++) ioctl(fd, VIDIOC_QBUF, ...);
enum v4l2_buf_type t = V4L2_BUF_TYPE_VIDEO_CAPTURE; ioctl(fd, VIDIOC_STREAMON, &t);
/* ④ 循环取帧 */
poll(&pfd, 1, -1);                   /* 等帧就绪 */
ioctl(fd, VIDIOC_DQBUF, &buf);       /* 出队拿到 buf.index 数据 */
process(bufs[buf.index], buf.bytesused);
ioctl(fd, VIDIOC_QBUF, &buf);        /* 还回去继续填 */
/* 关键认知：DQBUF 拿到的可能是「旧帧」——用 buf.sequence/timestamp
   检测丢帧与延迟堆积，必要时丢旧追新 */
```

## 66.2 格式选择：为何优先 MJPEG
USB 2.0 UVC 单端点等时传输有效带宽约 24MB/s（典型值）。720p30 的 YUYV 裸流 ≈1280×720×2B×30 ≈ 53MB/s，**必超带宽**导致 DQBUF 偶发 EPIPE 后设备失联；MJPEG 压缩后仅 3~8MB/s（典型值），代价是接收端需解码（硬解/IJPG）。结论：USB 摄像头默认选 **MJPEG**，带宽充裕且要零解码延迟才回 YUYV。

## 66.3 编码与推流两条路线
| 路线 | 栈 | CPU 占用(1080p) |
|------|----|-----------------|
| GStreamer 一条龙 ★快速 | v4l2src ! videoconvert ! v4l2h264enc ! rtspclientsink | <15%(硬编) |
| 自研服务(ch44 架构) | V4L2 直采→厂商编码库(libimxvpu/mpp)→自管 RTSP(live555) | <10%，可控性最高 |

```bash
# GStreamer 十分钟出图验证硬件通路（i.MX 示例），主机 VLC 打开 rtp:// 即见画面：
gst-launch-1.0 v4l2src device=/dev/video0 ! image/jpeg,width=1280,height=720 ! jpegparse ! jpegdec !
videoconvert ! vpuenc_h264 ! h264parse ! rtph264pay config-interval=1 ! udpsink host=192.168.1.100 port=5000
```

## 66.4 epoll 单线程分发：一次编码多路转发
架构原则（[[ch62-应用编程epoll进程线程IPC]]）：采集线程 DQBUF→硬编→RTP 包入队列即返回；主循环只做 `epoll_wait` 分发已编码 RTP 包给各客户端 socket。**客户端增删绝不触碰采集管线**，多客户端卡顿的根因几乎都是「每路触发独立转码」。

```c
struct epoll_event evs[32];
for (;;) {
    sd_notify(0, "WATCHDOG=1");                    /* 喂狗，见 66.6 */
    int n = epoll_wait(ep, evs, 32, 1000);
    for (int i = 0; i < n; i++) client_send(evs[i].data.ptr, rtp_queue_pop()); /* RTP转发 */
}
```

## 66.5 USB 掉线自恢复：udev 规则 + 状态机
```text
# /etc/udev/rules.d/99-uvc.rules —— 热插拔通知采集服务
ACTION=="add",    SUBSYSTEM=="video4linux", RUN+="/usr/local/bin/cam-ctl add"
ACTION=="remove", SUBSYSTEM=="video4linux", RUN+="/usr/local/bin/cam-ctl remove"
```

服务内状态机：`RUNNING →(udev remove 或 DQBUF EPIPE)→ LOST → BACKOFF(指数退避 1s,2s..30s 封顶重开 /dev/video*)→ RUNNING`；收到 add 事件立即尝试重开。拔线、EMI 复位、供电跌落三类故障统一收敛到这一条恢复路径。

## 66.6 systemd 托管与看门狗
```ini
[Service]
ExecStart=/usr/bin/camstream --dev /dev/video0
Type=notify
Restart=always
RestartSec=2
WatchdogSec=10
MemoryMax=256M
[Install]
WantedBy=multi-user.target
```

采集循环每轮 `sd_notify(0,"WATCHDOG=1")` 喂狗；任何原因卡死（USB 半死不活/内存泄漏）超时未喂狗，systemd 杀掉重启——比裸 while(1) 服务的可靠性高一个量级。

## 66.7 参数调试技巧
| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 端到端延迟 800ms+ | LED 秒表对拍逐段打点 | 缓冲数减到2/关B帧/config-interval=1/VLC caching=100 | <300ms（典型值） |
| 多客户端卡顿 | 观察是否每路转码 | 改一次编码多路转发 | 客户数↑CPU 恒定 |

## 66.8 实测数据表：两条路线对比与水位四指标
| 场景 | CPU 占用(1080p) | 说明 |
|------|------------------|------|
| GStreamer 一条龙（硬编） | <15%（实测值） | 快速验证首选 |
| 自研服务（libimxvpu/mpp 硬编） | <10%（实测值） | 可控性最高 |
| 软编 x264 | 显著更高（典型值） | 仅作反面基线 |
生产水位：帧率/丢帧率/CPU/温度四指标每秒采样上报（复用 [[ch44-综合实战RK3568多协议边缘网关]] 监控代理），任一越限告警。

## 66.9 排故速查表
| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| DQBUF 偶发 EPIPE 后设备失联 | USB 带宽不足(UVC 等时抢占)/供电跌落 | lsusb -t 看带宽；换 MJPEG；独立 LDO 供电 |
| 画面撕裂绿条 | bytesused 处理不全/DMA 未完成即读 | 校验 flags 有无 ERROR；缓存一致性(ch26 思想) |
| CPU 高且软编发热 | 走了 x264 而非硬编码器 | gst-inspect 确认元素名；enable 硬件 enc 插件 |
| 客户端多则卡顿 | 每路独立转码 | 一次编码多路分发(rtp 转发而非重编) |

## 66.10 部署注意事项
1. 多客户端：RTSP 会话管理+最大连接数限制+digest 鉴权；
2. 自适应码率：监测发送队列积压动态降分辨率（联动编码器参数热更）；
3. 资源守护：WatchdogSec + MemoryMax 双保险；泄漏检测用 ASan 版本定期回归；
4. 性能水位四指标每秒采样上报，形成 72h 稳定性数据存档；
5. BOM 参考：UVC 摄像头(支持 MJPEG 优先)；i.MX6ULL 上限 720p，RK3568 跑 1080p 舒适。
> [!example]- 🧪 动手实验 L66-1：从十分钟出图到可靠性闭环（70 分钟）
> **步骤**：① `v4l2-ctl --list-formats` 确认能力，gst-launch 出图到 UDP，VLC 验证；② 自研 MMAP 四步曲封装+帧率统计；③ 接入硬编与 systemd WatchdogSec；④ 注入故障：kill -9 服务、运行中拔插摄像头各三次。
> **验收**：VLC 见画面；kill -9 后 ≤12s 自动拉起；拔插后 ≤30s 恢复出图；全程水位四指标有记录。

## 66.11 进阶话题
- **开源对照**：mediamtx(原 rtsp-simple-server) 学会话管理；MotionEyeOS 学产品化形态；rockchip-rga demos 学零拷贝 pipeline 接法；
- **事件链设计**：「移动侦测触发录像」在哪一环做检测最省 CPU——编码前抽帧降采样；
- **产品化下一步**：ONVIF 协议栈；叠加检测能力即 [[ch91-P5-RK3568边缘AI盒子多路视频检测推流]] 项目雏形。

> [!warning]- ❓ FAQ
> **Q1：DQBUF 偶发 EPIPE 后设备「消失」？** USB 带宽不足或供电跌落导致 UVC 断开；换 MJPEG 减带宽、独立供电、走 66.5 状态机自愈。
> **Q2：端到端延迟 800ms+？** 逐段测都有账可查：采集缓冲数(减到 2)、编码 B 帧(关)、RTP 打包(config-interval)、播放端缓存(VLC network-caching=100)。

> [!question] 📝 思考题
> 1. 推导 UVC 等时传输带宽公式并计算 720p30 YUYV 是否可行。
> 2. 设计「移动侦测触发录像」的事件链：在哪一环做检测最省 CPU？
> 3. 把本服务迁移到 Luckfox Pico（RV1103）需要动哪些环节？

---
🏷️ #domain/linux #topic/v4l2 #topic/video | 🔗 [[ch65-性能优化CPU隔离cgroup-io调优]] ← **本章** → [[ch67-AOSP架构与源码编译]] | 📚 [[P6-MOC]]
