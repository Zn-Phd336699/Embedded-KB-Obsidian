---
title: "蜂窝网下 MQTT 设备假在线，发布悄悄丢失"
tags:
  - troubleshooting
  - protocol/mqtt
severity: high
frequency: common
source: "[[ch84-NB-IoT-Cat1蜂窝IoT-AT指令PPP组网]]"
date: 2025-01-15
---
# TC13 MQTT NAT 超时保活双保险

## 现象
NB-IoT/Cat1 设备表面在线，实际 publish 全部石沉大海，十几分钟后才收到 socket 错误；触发条件：运营商 NAT/防火墙会话超时远短于 MQTT KeepAlive 设定值。

## 环境与适用范围
蜂窝模组（BC26/A7670/ECSIM 等）经 PPP 或 AT 透传上云；家宽 NAT 场景同理。局域网直连 Broker 或专线固定 IP 不适用。

## 取证过程
1. Broker 端 `tcpdump -i any port 1883`：看 PINGREQ 到达间隔、断连时有无 RST/FIN。
2. 统计「最后一条报文→断连判定」的时间差，逼近真实 NAT 表项超时（运营商常见 60~300s）。
3. 设备端记录每次 publish 成败与重连耗时分布，定位静默丢包窗口。
4. 换 WiFi/有线环境对照测试，确认是蜂窝链路特异行为。

## 根因
NAT 网关靠五元组表项维持映射，流量静默超过超时即删除表项且不通知任何一方；此后设备的 PINGREQ 成为无主之包被丢弃，TCP 层要经历多次重传超时才报错。协议层 KeepAlive 若大于 NAT 超时，等于形同虚设。

## 修复方案
```python
import threading, time, mqtt

cli = mqtt.Client(client_id="dev001")
cli.connect("broker.example.com", keepalive=90)  # 协议保活 <= NAT 超时 1/2
state = {"interval": 120}                        # 应用心跳初始周期(s)

def hb():
    try:
        info = cli.publish("dev/hb", str(int(time.time())), qos=1)
        info.wait_for_publish(timeout=10)        # 必须确认真正送达
        state["interval"] = min(state["interval"] * 2, 600)
    except Exception:                            # 失败则收紧周期并重连
        state["interval"] = max(state["interval"] // 2, 30)
        cli.reconnect()
    threading.Timer(state["interval"], hb).start()

hb(); cli.loop_start()
```

## 预防措施
- KeepAlive 按各运营商实测 NAT 超时的一半以下分别配置
- QoS1 发布必须 wait_for_publish 并检查结果，禁止发完不管
- 重连采用指数退避+随机抖动，防止基站级雪崩重连
- 注册 Last Will 遗嘱消息，让云端第一时间识破假在线

## 关联
- 源章节：[[ch84-NB-IoT-Cat1蜂窝IoT-AT指令PPP组网]]
- 相关章节：[[ch80a-MQTT-CoAP云协议本体与实现]]、[[ch63-网络编程与TLS从socket到安全上云]]
