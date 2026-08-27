---
title: "第14章 嵌入式日志系统设计：分级、异步、RTT 与远程回传"
part: "[[P2-MOC]]"
chapter: 14
tags:
  - domain/fundamentals
  - topic/logging
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch07-嵌入式数据结构与算法]]"
  - "[[ch13-探针实战OpenOCD-JLink-probe-rs]]"
related:
  - "[[ch15-内存问题排查三板斧]]"
  - "[[ch30-Bootloader-IAP-OTA固件升级体系]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第14章 嵌入式日志系统设计：分级、异步、RTT 与远程回传

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch13-探针实战OpenOCD-JLink-probe-rs]] | → [[ch15-内存问题排查三板斧]]

printf 是最慢的外设操作之一。本章设计一套「开发期零阻塞、量产期可关闭」的日志体系：分级宏编译期蒸发、异步环形缓冲把 IO 移出关键路径、RTT 提供 MB 级吞吐通道、黑匣子负责量产回溯。

## 🎯 学习目标
- [ ] 实现带时间戳/级别/模块名的日志宏，`LOG_COMPILE_LEVEL` 编译期裁剪零开销
- [ ] 用 RTT/SWO 实现不占 UART 的实时日志通道，掌握主机接入与多通道用法
- [ ] 异步环形缓冲：ISR 内可调用、满载丢弃计数而非阻塞、pump 批量搬运
- [ ] 设计量产黑匣子：崩溃前最后 N 条日志落盘并支持运维接口导出

## 14.1 分级日志宏：编译期裁剪零开销

两级开关：`LOG_COMPILE_LEVEL` 编译期总闸（量产 `-DLOG_COMPILE_LEVEL=2` 只留 ERR），`g_log_runtime` 运行期细调。级别超过总闸时整个表达式消失——连格式字符串都不占 Flash。

```c
typedef enum { LOG_NONE=0,LOG_ERR,LOG_WARN,LOG_INFO,LOG_DBG } log_lv_t;
#ifndef LOG_COMPILE_LEVEL          /* 编译期总闸：-DLOG_COMPILE_LEVEL=2 只留ERR */
#define LOG_COMPILE_LEVEL LOG_INFO
#endif
extern log_lv_t g_log_runtime;     /* 运行期细调 */

#define LOG(lv,tag,fmt,...) \
    do{ if((lv)<=LOG_COMPILE_LEVEL && (lv)<=g_log_runtime){ \
        log_output((lv),(tag),(uint32_t)(xTaskGetTickCount()),fmt,##__VA_ARGS__); }}while(0)
#define LOGE(tag,...) LOG(LOG_ERR,(tag),__VA_ARGS__)
#define LOGW(tag,...) LOG(LOG_WARN,(tag),__VA_ARGS__)
#define LOGI(tag,...) LOG(LOG_INFO,(tag),__VA_ARGS__)
#define LOGD(tag,...) LOG(LOG_DBG,(tag),__VA_ARGS__)
/* 用法：LOGE("SHT31","crc fail seq=%u",seq); tag 统一模块名 grep 友好；tick 时间戳代替墙钟离线换算 */
```

## 14.2 后端选型：UART / SWO / RTT / 网络 / Flash 对比

| 后端 | 速度 | 侵入性 | 适用场景 |
|------|------|--------|----------|
| UART 同步 printf | 115200bps≈11.5KB/s，每字符 ~87µs 阻塞 | 严重破坏实时性 | 仅启动期/低频事件 |
| SWO (ITM) | 数 MB/s | 低；需 SWO 引脚+配套工具 | M3+ 芯片调试期 |
| **RTT (Segger)** | 最高 MB 级 | 几乎无：RAM 环形缓冲，探针 DMA 拉取 | 调试期首选 |
| USB CDC / 网络 | 高 | 依赖协议栈就绪 | 运行期远程采集 |
| Flash 黑匣子 | 写页级延迟 | 掉电安全设计要求高 | 量产故障回溯 |

## 14.3 关键代码：异步环形缓冲、pump 任务与 RTT 多通道

核心原则：`log_output` 只做内存拷贝不做 IO，ISR 中调用安全；写 RTT/UART 由后台 pump 批量完成；缓冲满时丢新保旧并计数，绝不阻塞。

```c
#define LOG_BUF_SZ 2048                 /* 取 2 的幂便于取模 */
static uint8_t log_buf[LOG_BUF_SZ];
static ring_t log_ring = {log_buf,LOG_BUF_SZ,0,0};

void log_output(log_lv_t lv,const char*tag,uint32_t t,const char*fmt,...){
    char tmp[96]; int n=snprintf(tmp,sizeof tmp,"[%10lu][%c]%s: ",t,"EWID"[lv],tag);
    va_list ap; va_start(ap,fmt);
    n+=vsnprintf(tmp+n,sizeof(tmp)-n,fmt,ap);      /* snprintf 保证不越界 */
    va_end(ap);
    if(n>=(int)sizeof(tmp)-2) n=sizeof(tmp)-2;
    tmp[n++]='\r'; tmp[n++]='\n';
    for(int i=0;i<n;i++){                          /* 满 则丢新保旧 */
        if(!ring_put(&log_ring,tmp[i])){ log_dropped++; break; }
    }
}
/* 后台 pump 骨架（log_pump.c）：
   for(;;){ int n=0; while(n<256 && ring_get(&log_ring,&b[n++])) ;
            if(n) rtt_write(0,b,n); vTaskDelay(n ? 1 : 20); }
   有数据紧跟，空闲让步 */
```

```text
RTT 接入：① SEGGER_RTT.c/.h 入工程，尾端换 SEGGER_RTT_WriteString(0,line);
② 主机查看：JLinkRTTClient / probe-rs rtt --chip STM32F407ZGTx /
   VSCode Cortex-Debug 配 "rttConfig": {"enabled":true}
③ CH0 默认上行 1KB 下行 16B；高频日志扩到 4KB 并开 CH1 二进制流
④ 控制块靠 RAM 特征串 "SEGGER RTT" 扫描定位——别优化进 CCM 盲区
```

## 14.4 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 日志滞后到达 | 统计 pump 每轮搬运字节数 | pump 优先级提高一档 | 出队速率 ≥ 入队峰值 |
| dropped 计数增长 | 采样读取 log_dropped 差值 | 缓冲翻倍（保持 2 的幂） | 长跑后不再增长 |
| 高频日志刷屏淹没关键行 | 统计各级别条目占比 | 占用超 70% 自动 INFO→WARN | 白名单 tag 永不丢 |

## 14.5 实测数据表：写一行 60 字节日志的成本

| 后端 | 阻塞耗时 | ISR 内可用 | 备注 |
|------|----------|------------|------|
| UART@115200 同步 | ≈5.2ms | ❌ 灾难 | 60B×10bit/115200 |
| UART+DMA 队列 | ~2µs 入队 | ✅ | 需管理发送队列深度 |
| RTT | ~1.5µs（memcpy 量级） | ✅ | 探针不在时静默丢（可计数） |
| Flash 黑匣子 | 页编程 ms 级 | ❌ 仅 ERR 级专用 | 掉电安全见 [[ch77-SPI-QSPI与Flash驱动JEDEC-XIP磨损均衡]] |

## 14.6 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 加日志后变慢/复位 | ISR 内同步 IO；缓冲太小频繁满载 | 改异步入环；扩大 buf 并统计 dropped 率 |
| 多任务日志交错乱码 | 共享格式化缓冲无锁 | 先 vsnprintf 到栈内临时区再原子入队，或每任务独立行缓冲 |
| RTT 偶发丢数据 | 探针轮询间隙缓冲溢出 | 加大 RingBuffer；降低非关键级别；关键路径用 SWO 备份 |
| 量产固件体积没变小 | 只关运行开关，字符串仍在 .rodata | 同时降 LOG_COMPILE_LEVEL 让宏整体蒸发（配 -gc-sections） |

## 14.7 部署注意事项

1. ISR 里只允许 `log_output`（纯内存拷贝）；在 ISR 同步 printf 会错过中断窗口引发新 Bug。
2. 缓冲满必须「丢弃 + `dropped++`」，禁止阻塞等待——实时任务不能被日志拖死。
3. 量产黑匣子只留 ERR 级 + 关键状态机迁移，写外部 Flash/FRAM 循环区；HardFault Handler 把取证现场连同最近 32 条日志索引一起落盘（联动 [[ch30-Bootloader-IAP-OTA固件升级体系]]）。
4. 时间基准用「开机秒数 + 上次校时快照」双段表示，避免 RTC 未配的时间黑洞；上电先读上次异常记录，经 Modbus 扩展寄存器/BLE 特征值导出。

> [!example]- 🧪 动手实验 L14-1：迁移 printf 并量化 dropped 率（35 分钟）
> **步骤**：① 全局替换业务 printf 为 LOGI 宏（保留启动段直出）；② 高频路径故意灌 2000 行/秒压满环形缓冲；③ 从 dropped 计数器读取丢失率；④ 调整缓冲大小与 pump 优先级把丢失率压到 0 并记录 RAM 代价；⑤ 断开探针运行验证「无探针不卡死」。**验收**：产出一张「缓冲大小×丢失率×RAM」权衡表进仓库。

## 14.8 进阶话题
- **时间戳补偿**：tickless 下 tick 不连续，维护 last_tick/last_wall 快照在唤醒钩子里线性插值（联动 [[ch50-FreeRTOS中断管理与Tickless低功耗]]）
- **二进制遥测通道**：高频曲线别走文本！紧凑结构体直写 RTT CH1，主机按 magic+length 解析——带宽省 5 倍且免格式化 CPU
- **采样降级**：占用>70% 时仅丢白名单外的 INFO 条目，比全局静默优雅

> [!warning]- ❓ FAQ
> **Q1：为什么用 tick 而不是墙钟时间戳？** tick 免依赖 RTC 且获取廉价；RTC 未配置时墙钟会产生时间黑洞，离线用校时快照换算更可靠。
> **Q2：RTT 与 SWO 如何取舍？** 有 J-Link/probe-rs 探针首选 RTT（吞吐更高、不占引脚）；需要 ITM 硬件通道或无 RAM 预算时用 SWO。

> [!question] 📝 思考题
> 1. 估算 115200 波特率下一行 80 字节日志的阻塞时间，对比 RTT 的传输耗时差几个数量级？
> 2. 设计「日志采样率自适应」：缓冲占用超 70% 时自动降级 INFO→WARN，写出伪代码。
> 3. 把 HardFault 取证结构与黑匣子打通，画出断电重启后的完整数据流。

---
🏷️ #domain/fundamentals #topic/logging | 🔗 [[ch13-探针实战OpenOCD-JLink-probe-rs]] ← **本章** → [[ch15-内存问题排查三板斧]] | 📚 [[P2-MOC]]
