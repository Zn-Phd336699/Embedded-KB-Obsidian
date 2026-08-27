---
title: "第67章 AOSP架构与源码编译"
part: "[[P7-MOC]]"
chapter: 67
tags:
  - domain/android
  - topic/aosp-build
difficulty: 3
est_minutes: 40
prerequisites:
  - "[[ch66-综合实战USB摄像头流采集服务]]"
related:
  - "[[ch68-启动流程与Zygote]]"
  - "[[ch71-设备适配DTB-sepolicy-vendor-blobs]]"
  - "[[ch42-Yocto入门-layer-recipe-bbappend]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第67章 AOSP架构与源码编译

> [!info] 导航
> ⏱ 40min | ★★★☆☆ | 前置 [[ch66-综合实战USB摄像头流采集服务]] | → [[ch68-启动流程与Zygote]]

## 🎯 学习目标
- [ ] 画出 AOSP 分层架构（App/Framework/Native/HAL/Kernel）并说出各层对应源码目录
- [ ] 用 repo+manifest 拉取源码，跑通 lunch → m 全量编译并获得镜像族
- [ ] 解释 Soong/Blueprint 构建链路与 product/device/vendor 三层配置体系
- [ ] 掌握 ccache 提速策略与增量构建开发循环

## 67.1 分层架构与目录地图

AOSP 是「操作系统级」单体仓库：约 200GB 源码、全量编译以小时计——第一次接触最容易迷路。先建分层心智模型，再只记高频目录。

| 层 | 职责 | 代表目录 |
|------|------|----------|
| App 层 | 系统应用：Launcher/Settings | packages/apps |
| Java Framework | AMS/WMS/PMS 等系统服务 | frameworks/base |
| Native 层 | C++ 框架/多媒体/Binder 库 | frameworks/{native,av} |
| HAL 层 | HIDL/AIDL 硬件抽象（见 ch69） | hardware/interfaces |
| Kernel 层 | Linux 内核/GKI 模块 | kernel（部分产品随仓库） |

其余必记目录：

| 目录 | 内容 |
|------|------|
| build/soong | 构建系统核心（Blueprint→Ninja） |
| system/{core,sepolicy} | init/logd 等 root 程序 / 安全策略 |
| device/\<vendor\>/\<board\> | 板级适配：BoardConfig.mk+dts+fstab ★BSP 主战场 |
| external/ | 第三方库 |

## 67.2 编译三步：repo → lunch → m

repo 按 manifest.xml 统一管理上百个 git 仓库（仓库清单+revision+分组），一条命令同步全部代码。

```bash
# ① 拉源码
repo init -u <manifest_url> && repo sync -j8    # 断续失败加 --no-clone-bundle；或换镜像源(清华站)
# ② 选目标：envsetup 提供 lunch/m 等命令
source build/envsetup.sh
lunch aosp_cf_x86_64_phone-trunk_staging-userdebug   # Cuttlefish 虚拟设备；真机例：rk3568_t-userdebug
# ③ 编译：m 是 soong_ui 的新入口
export CCACHE_DIR=/cache/ccache && export USE_CCACHE=1   # 提速三件套之首：二次构建快 3~10 倍
m -j$(nproc)
```

产物镜像族在 `out/target/product/<dev>/` 下：`boot.img`（kernel+ramdisk）、`system.img`（AOSP 公共部分）、`vendor.img` 等。刷机用 `fastboot flashall`，虚拟设备用 launch_cvd 启动 Cuttlefish。

## 67.3 product/device/vendor 三层配置体系

```text
device/myco/rk3568/AndroidProducts.mk        → 选定产品入口
  myco_rk3568.mk    PRODUCT_PACKAGES += MySensorHAL          ← 加组件
                    PRODUCT_COPY_FILES += fstab.rk3568:...   ← 拷贝文件
  BoardConfig.mk    TARGET_BOARD_PLATFORM / PARTITION_SIZES / SELinux 策略开关
Treble vendor 分离：vendor.img 装芯片厂私有(HAL/固件)，system.img 装 AOSP
                   ——两者通过稳定 HIDL/AIDL 接口解耦，可独立升级
```

动态分区时代 system/vendor/product 再打包进 `super.img` 动态挂载，刷机命令变为 `fastboot flash super`——与传统整镜像刷法差异要重学。

## 67.4 关键代码：Soong/Blueprint 模块声明即代码

```text
// Android.bp：新代码一律 bp；.mk 只剩产品配置/拷贝文件类杂务
cc_binary {
    name: "myd",
    srcs: ["myd.cpp"],
    shared_libs: ["liblog"],
    vendor: true,           // 装入 vendor 分区
    init_rc: ["myd.rc"],    // init 启动脚本一条龙(ch68)
}
// 条件化：target: { android_arm64: {...} }，arch 变体自动展开
// 与 Kati 的边界：PRODUCT_PACKAGES 等「产品级聚合」仍在 mk——
// 因为它需要跨模块全局视图（bp 是局部声明的）
```

## 67.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 全量编译太慢 | time m；观察 soong_ui 各阶段耗时 | 开 ccache；--soong-only 局部验证 | 二次构建进入 30min 量级 |
| 改一行等半天 | 确认是否误触发全量 | 改用模块级循环 m \<module\> + adb sync | 单模块 ~20s 出包 |
| ninja 阶段内存爆 | free -g 观察 swap 占用 | m -j8 限流；扩 swap | 编译不再 OOM 中断 |

## 67.6 实测数据表：编译资源与耗时基线（Android 14，源自材料）

| 配置 | 全量耗时 | 增量(改一文件) | 磁盘占用 |
|------|----------|----------------|----------|
| 16C/32G NVMe 无缓存 | ~2.5h | ~3min | ~250GB |
| +ccache 热缓存 | **~35min** | <1min | +50GB 缓存 |
| 只编一个模块(m myd) | - | ~20s | - |

## 67.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| ninja 失败 out of memory | 并行度过高 | m -j8 限流；加 swap；分模块 m \<target\> |
| repo sync 断续失败 | 网络/磁盘 inode 耗尽 | --no-clone-bundle；镜像源(清华站) |
| 刷机后卡 logo | dtb/fstab 分区表不匹配 | 串口看 kernel log；fastboot boot 临时镜像二分 |
| SELinux 拒绝服务起不来 | avc denied 缺策略 | dmesg \| grep avc 收集 deny → auditallow 补规则 |

## 67.8 部署注意事项
1. 团队协作：不共享 out 目录，改为共享 CCACHE_DIR 缓存目录
2. VINTF manifest 校验已前移到构建期(libvintf)：HAL 清单缺失直接编不过（ch69）
3. GKI(Android 12+)：内核由 Google 统一提供，厂商只写可加载模块——BSP 重心从改内核转向模块+bootconfig
4. 磁盘规划：源码 200GB+产物 250GB 量级，NVMe 必备，CCACHE_DIR 放大容量分区
5. 刷机工具链注意动态分区差异（super.img），别拿旧整镜像流程硬套

> [!example]- 🧪 动手实验 L67-1：Cuttlefish 云手机从零起飞（90 分钟）
> **步骤**：① 按 AOSP 官网装 Cuttlefish 依赖(cvd host 包)；② lunch aosp_cf_x86_64_phone 后 m 全量编译；③ launch_cvd 启动并 adb connect 连上；④ 改 frameworks/base 一处字符串 → m 增量编译 + adb sync 验证生效；⑤ 截图存档。**验收**：跑通「改框架→看到变化」的完整闭环——这是所有 AOSP 开发的最小信心单元。

## 67.9 进阶话题
- **GKI(通用内核镜像)革命**：Android 12+ 内核由 Google 统一提供，厂商侧只交付可加载模块
- **动态分区(super)**：多镜像打包 super.img 动态挂载，刷机与升级路径随之改变
- **VINTF manifest 校验前移**：构建期 libvintf 即检查 HAL 清单完整性——接口声明漏了编不过，好事

> [!warning]- ❓ FAQ
> **Q1：为什么 PRODUCT_PACKAGES 不放进 Android.bp？** bp 是局部模块声明，产品级聚合需要跨模块全局视图，仍由 Kati(.mk) 承担。
> **Q2：团队想复用编译成果怎么办？** 共享 ccache 缓存即可（二次构建快 3~10 倍）；共享 out 目录不可行。

> [!question] 📝 思考题
> 1. Treble 之前为什么整机 OTA 如此痛苦？vendor/system 解耦解决了什么？
> 2. 估算 ccache 对团队 20 人仓库的首次/后续编译时间影响。
> 3. 设计一个最小自定义 product：只含 launcher+设置两项应用。

---
🏷️ #domain/android #topic/aosp-build | 🔗 [[ch66-综合实战USB摄像头流采集服务]] ← **本章** → [[ch68-启动流程与Zygote]] | 📚 [[P7-MOC]]
