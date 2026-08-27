---
title: "第69章 HAL演进与AIDL-HAL实战"
part: "[[P7-MOC]]"
chapter: 69
tags:
  - domain/android
  - topic/hal
difficulty: 4
est_minutes: 45
prerequisites:
  - "[[ch68-启动流程与Zygote]]"
related:
  - "[[ch70-Binder原理与实践]]"
  - "[[ch71-设备适配DTB-sepolicy-vendor-blobs]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第69章 HAL演进与AIDL-HAL实战

> [!info] 导航
> ⏱ 45min | ★★★★☆ | 前置 [[ch68-启动流程与Zygote]] | → [[ch70-Binder原理与实践]]

## 🎯 学习目标
- [ ] 说清三代 HAL（legacy/HIDL/AIDL）形态差异与迁移背景
- [ ] 完成 AIDL HAL 五步流程：接口定义→服务实现→VINTF 注册→sepolicy→客户端调用
- [ ] 遵守 stable AIDL 四条红线并用 aidl_api 冻结接口
- [ ] 会用 lshal/dumpsys/VTS 验证与调试 HAL 服务

## 69.1 三代演进速览

Treble 要解决的核心矛盾：legacy HAL 的 .so 直接链进 framework 进程，升级 framework 必须重编所有厂商代码，整机 OTA 痛苦不堪。解法是把 HAL 拆成独立进程、以稳定接口隔离。

| 世代 | 形态 | 问题/动机 |
|------|------|-----------|
| Legacy(≤7.x) | .so 直接链进 framework 进程 | 升级 framework 必须重编所有厂商代码 → 催生 Treble 改造 |
| HIDL(8.0~11) | 独立进程 + Binderized 接口(.hal 描述) | 稳定接口解耦 vendor/system；但语法笨重 |
| **AIDL(11+ 主推)** | 复用 App 层 AIDL 语法+稳定化注解 | 统一语言生态、工具成熟、支持 NDK/Rust 后端 ★新项目必选 |

## 69.2 AIDL-HAL 全流程五步

```java
// ① 接口定义 aidl/myco/mysensor/IMySensor.aidl（stable AIDL）
package myco.mysensor;
@VintfStability                          // 关键注解：进入 VINTF 稳定承诺
interface IMySensor {
    int readRaw(in int channel);
    void enableCalibration(boolean on);
}
```

```cpp
// ② 服务端 C++ 实现（放 hardware/interfaces 或 device 目录）
class MySensor : public BnMySensor {
  ndk::ScopedAStatus readRaw(int32_t ch, int32_t* _aidl_return) override {
    *_aidl_return = raw[ch];             // 读寄存器/IIO 节点略
    return ndk::ScopedAStatus::ok();
  }
};
int main() {
    auto s = ndk::SharedRefBase::make<MySensor>();
    const std::string inst = std::string(IMySensor::descriptor) + "/default";
    AIBinder_register(s->asBinder().get(), inst.c_str());  // 注册 ServiceManager
    ABinderProcess_joinThreadPool();
}
// ③ VINTF 注册：manifest.xml + 兼容矩阵声明——否则框架认为该 HAL 不存在
// ④ sepolicy：新增 hwservice_context 绑定标签 + allow 规则
// ⑤ 客户端：AIBinder_getService(inst) → cast → 直接调用(跨进程透明)
```

注册发现机制：hwservicemanager/ServiceManager 是所有 HAL 的「DNS」，descriptor+实例名字符串即身份证——必须与 VINTF manifest、rc 文件三处完全一致。

## 69.3 stable AIDL 与 App AIDL 的四条差异红线

| 约束 | 原因 |
|------|------|
| @VintfStability 注解强制 | 接口进入 VINTF 冻结清单，跨 vendor/system 版本承诺兼容 |
| 禁止非 stable 类型(如普通接口嵌套) | hash 冻结机制要求全图可计算 |
| 新方法只能追加不能改签名 | ABI hash 变化=破坏老 vendor——用扩展接口或版本号演进 |
| aidl_api/ 目录提交冻结快照 | CI 自动比对 hash——改动即编译失败，防手滑 |

## 69.4 关键代码：从接口到服务的目录全景

```text
aidl/myco/mysensor/IMySensor.aidl               # 接口
aidl_api/myco.mysensor/1/*.aidl                 # 冻结快照(v1)
hardware/interfaces/compatibility_matrices/*    # 兼容矩阵(或 vendor manifest 片段)
service cpp 实现 + mysensor-default.rc:
  service mysensor /vendor/bin/hw/mysensor
      interface myco.mysensor.IMySensor/default
      class hal  user halsensor  group input
sepolicy: hwservice_contexts + .te 文件
构建产物核对：lshal | grep mysensor 出现且 VINTF 校验绿 ✓
```

## 69.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| HAL 未出现在列表 | lshal / dumpsys --pid 列注册 HAL 及 PID | 检查 manifest fragment 是否打包进镜像 | lshal 出现 descriptor |
| 调用被拒 | dmesg 过滤 avc denied | hwservice_context+.te 补 allow 规则 | audit2allow 起草后调用成功 |
| 响应慢/卡顿 | atrace hal 采集 + perfetto 解析(ch73) | 慢回调 oneway 化或拆接口 | 泳道无跨进程等待环 |
| 兼容性回归 | VTS(Vendor Test Suite) 子集测试 | 接口冻结/版本演进方式 | VTS 绿=GMS 认证门票之一 |

## 69.6 实测数据表：调用开销对比（典型值）

| 场景 | 指标A | 指标B |
|------|-------|-------|
| legacy 同进程直调(.so 链入) | ns~μs 级函数调用（典型值） | 无序列化/跨进程开销 |
| Binderized HAL 跨进程往返(AIDL/HIDL) | 数十 μs 级（典型值） | 含打包+binder 往返+线程池调度 |

结论：Binderized 用可控开销换来 system/vendor 独立升级能力——这正是 Treble 的交换条件。

## 69.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| getService 返回 null | 未进 VINTF manifest/名字不符 | dumpsys 对比 descriptor 字符串；检查 manifest fragment 打包 |
| 调用即 SecurityException | sepolicy 缺 allow 规则 | avc denied 日志按 neverallow 外补规则；audit2allow 起草 |
| 跨版本兼容报错 | @VintfStability 接口改动未冻结 hash | frozen ABI 检查工具；新方法走扩展接口而非改旧签名 |
| binder 线程耗尽死等 | 服务端同步回调客户端成环 | 改为 oneway 异步或拆双向接口 |

## 69.8 部署注意事项
1. descriptor 字符串是唯一身份标识——接口名/实例名在 aidl/rc/manifest 三处必须一字不差
2. 低频硬件用 lazy HAL：声明 lazy-service，首次调用由 hwservicemanager 拉起省内存
3. 客户端必配 death recipient 监听——HAL 升级重启是常态而非异常，死亡后自动重绑
4. 接口演进走 aidl_interface 的 freeze 流程，破坏性改动会被 CI hash 比对拦下
5. 发布前跑 VTS 子集——上 GMS 认证的门票之一（量产关联 S4）

> [!example]- 🧪 动手实验 L69-1：AIDL HAL 全生命周期（2 小时）
> **步骤**：① 按 69.4 骨架建接口并走 freeze 流程(m help 查目标)；② 实现服务端注册与客户端绑定调用；③ 补 manifest+sepolicy 刷机验证；④ 故意改已冻结方法观察 CI hash 报错；⑤ 用 VTS 子集跑一个接口测试。**验收**：完整走通「声明→实现→注册→调用→冻结」闭环。

## 69.9 进阶话题
- **lazy HAL 模式**：服务不常驻，首次调用拉起——低频硬件省内存的标准姿势
- **AIDL NDK 后端**：同一接口生成 C++/NDK/Rust 三后端绑定——传感器算法团队用 Rust 直连成为现实
- **death recipient 必配**：监听服务端死亡自动清理重绑
- **官方样板间**：hardware/interfaces 的 camera/sensors/vibration 目录——vibration 是最简单的完整 AIDL HAL 范本

> [!warning]- ❓ FAQ
> **Q1：为什么 HIDL 被 AIDL 取代？** AIDL 复用 App 层语言生态与成熟工具链，支持 NDK/Rust 多后端，语法远轻于 .hal 描述文件。
> **Q2：getService 返回 null 但服务进程明明活着？** 九成是没进 VINTF manifest 或 descriptor 名字不一致——框架按清单判断存在性。

> [!question] 📝 思考题
> 1. Treble 解决的核心矛盾是什么？为什么 HIDL 被 AIDL 取代？
> 2. 为你的传感器 HAL 增加「批量异步读取」oneway 接口的注意事项。
> 3. 画出一次 readRaw 调用的完整进程间数据流(含 SM 查询)。

---
🏷️ #domain/android #topic/hal | 🔗 [[ch68-启动流程与Zygote]] ← **本章** → [[ch70-Binder原理与实践]] | 📚 [[P7-MOC]]
