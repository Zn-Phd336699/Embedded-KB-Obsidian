---
title: "第42章 Yocto 入门：layer / recipe / bbappend"
part: "[[P4-MOC]]"
chapter: 42
tags:
  - domain/soc
  - topic/buildsystem
difficulty: 3
est_minutes: 32
prerequisites:
  - "[[ch41-Buildroot定制rootfs全流程]]"
related:
  - "[[ch36-RK平台ATK-DLRK3568-RK3588-Luckfox]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第42章 Yocto 入门：layer / recipe / bbappend

> [!info] 导航
> ⏱ 32min | ★★★☆☆ | 前置 [[ch41-Buildroot定制rootfs全流程]] | → [[ch43-NPU-GPU应用开发RKNN-MPP]]

## 🎯 学习目标
- [ ] 用 Poky/Layer/Recipe/bitbake 四层心智模型解释一次完整构建发生了什么
- [ ] 独立写出最小 recipe，并用 bbappend 对既有配方做增量修改
- [ ] 说清 sstate 缓存键构成，用 kas yaml + devtool 三连完成 RK3568 可复现构建

## 42.1 核心概念四件套

| 概念 | 一句话 | 例子 |
|------|--------|------|
| Poky | 官方参考发行版（含构建器 bitbake） | `git clone` poky 即起点 |
| Layer（meta-\*） | 按域组织的配方集合，可叠加 | meta-openembedded / meta-rockchip |
| Recipe（.bb） | 一个软件包怎么取码/打补丁/编译/安装 | recipes-core/busybox/busybox_1.36.bb |
| .bbappend | 对已有 recipe 的增量修改 | busybox_%.bbappend 加自定义 defconfig 片段 |

心智模型：**bitbake 把所有 layer 的配方展开为任务图，按依赖执行并缓存产物**。BSP 层（meta-rockchip/meta-freescale 等）只管机器定义与内核/U-Boot 配方，业务逻辑放产品层——每多叠一层都是一份维护承诺。

## 42.2 最小 recipe 解剖

```bitbake
SUMMARY = "My sensor daemon"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://LICENSE;md5=xxxx"      # 许可证校验（合规强制项）
SRC_URI = "git://github.com/me/sensord.git;protocol=https;branch=main \
           file://sensord.service"
SRCREV = "a1b2c3..."                              # 锁 commit = 可复现构建灵魂
inherit cmake systemd                              # 复用现成构建类与服务类
EXTRA_OECMAKE += "-DENABLE_BLE=ON"
do_install:append() {                              # :append 是增量操作符
    install -D -m0644 ${WORKDIR}/sensord.service ${D}${systemd_system_unitdir}/sensord.service
}
SYSTEMD_SERVICE:${PN} = "sensord.service"   # 执行 bitbake sensord；devshell/oelint 调试
```

高频三坑：① SRCREV 不锁 commit → 不可复现；② 上游改 LICENSE → 校验和 fail（评审后再更新 md5）；③ 改上游配方写 bbappend，别 fork 别人的 layer。

## 42.3 构建 RK3568 镜像：kas 把构建环境写成代码

```bash
git clone https://github.com/ndechesne/meta-rockchip
source oe-init-build-env rkbuild
bitbake-layers add-layer ../meta-openembedded/meta-oe ../meta-rockchip
MACHINE=rk3568-atk-dlrk3568 bitbake core-image-minimal
# 产物 tmp/deploy/images/rk3568*/（ch36 的 rkdeveloptool 烧写）；首次全量约 1~3 小时
```

```yaml
# kas yaml 示意：layers/机器/版本全部声明式，CI 中 kas build 一条命令完整复现
header: {version: 14}
machine: rk3568-atk-dlrk3568
repos: {poky: "...", meta-rockchip: "..."}   # 分别声明 url + branch/refspec
local_conf_header:
  product: |
    IMAGE_INSTALL:append = " sensord"
```

## 42.4 原理深挖：bitbake 任务图与 sstate 缓存键

```text
每个 recipe 展开为 do_fetch/unpack/patch/configure/compile/install/package… 任务链；任务图(DAG)：bitbake -g myimage 生成 pn-buildlist 与 task-depends.dot
sstate 命中条件：任务输入签名一致 —— 源码哈希 + 配置变量 + 依赖链哈希
  → 「改一行代码」只击穿该包及其下游；换 GCC 版本则全线重编 —— 可复现与增量同时成立
PREFERRED_VERSION_busybox = "1.36.%"   # 版本偏好写在 machine/distro 层而非全局乱飘
```

## 42.5 devtool 三连：改上游代码的正确姿势

```bash
devtool modify busybox        # 解压到 workspace/sources/busybox 改码，自动建立 .bbappend 关联
devtool build busybox && devtool deploy-target busybox root@board   # 秒上板验证
devtool update-recipe busybox # 改动沉淀回自己 layer 的 .bbappend/补丁，可追溯可回滚
```

## 42.6 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 全量构建过慢 | buildstats 统计各任务耗时 | 共享 sstate-cache、扩大 DL_DIR | 团队二次构建分钟级内 |
| do_fetch 反复超时 | temp/log.do_fetch 看 URL | PREMIRRORS 指向内网镜像 | 连续多次 fetch 稳定通过 |
| 包版本不受控 | bitbake-getvar 查 PREFERRED_VERSION | 版本偏好收敛进 distro/machine 层 | 变 layer 叠加顺序版本不变 |

## 42.7 实测数据表：Buildroot vs Yocto 选型

| 维度 | Buildroot | Yocto |
|------|-----------|-------|
| 学习曲线 | 平缓，一两天上手 | 陡峭，两周才敢动生产 |
| 构建速度 | 快而直接 | 慢但 sstate 缓存团队共享强 |
| 多产品多版本矩阵 | 弱（靠 external tree 硬撑） | 强（machine/distro/image 多维正交） |
| 许可证合规报表 | 基础 legal-info | 完善 manifest/license 扫描 |
| 适合 | 单产品中小团队/教学 | 多产品线车规医疗大厂 |

## 42.8 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| bitbake 报 Nothing RPROVIDES | layer 未加入 bblayers.conf / 配方名拼错 | bitbake-layers show-recipes \| grep 名字 |
| LIC_FILES_CHKSUM mismatch | 上游改了 LICENSE 文件 | 重算 md5 并评审变更内容后再更新 |
| do_fetch 慢或失败 | git 大仓克隆 / 网络问题 | PREMIRRORS 指向内网镜像；DL_DIR 缓存复用 |
| 镜像缺我的包 | IMAGE_INSTALL 没加 / 变量名写错 | local.conf：IMAGE_INSTALL:append = " sensord" |

## 42.9 部署注意事项

1. 发布镜像移除 `debug-tweaks`（免密 root）；用 `read-only-rootfs ssh-server-dropbear` 这类 IMAGE_FEATURES 声明式组合替代一堆手配。
2. 许可证合规自动化：`IMAGE_CLASSES += license_image` 生成 license manifest——车规客户审计的敲门砖。
3. sstate-cache 规划数十 GB 独立磁盘，以只读方式共享给团队（写权限仅归 CI）；升级 Poky 分支前先锁 SRCREV 全量验证一次。

> [!example]- 🧪 动手实验 L42-1：给 busybox 加一条自定义命令（50 分钟）
> **步骤**：① `devtool modify busybox`；② 写一个 `mysay` 小命令并注册进 Kbuild；③ `deploy-target` 上板验证；④ `update-recipe` 固化到自己的 layer；⑤ 清理 workspace 后从干净环境完整复现一次。
> **验收**：干净环境一条 `bitbake` 链产出含 mysay 的镜像，上板执行 mysay 输出符合预期；沉淀一页「上游定制标准流程」文档——Yocto 新人最常走弯路的地方。

## 42.10 进阶话题

- **multiconfig 多板同构**：一次 bitbake 同时出 A/B 两块板的镜像，跨机器依赖用 mcdepends 声明；
- **toaster(Web UI) / `bitbake -c menuconfig`**：可视化辅助工具链；
- **平台层+产品层双层组织**：BSP 平台层管 machine/内核配方，产品层只做 IMAGE_INSTALL 与差异化配置。

> [!warning]- ❓ FAQ
> **Q1：sstate-cache 为什么能让「换一行代码」的增量构建接近秒级？** 输入签名未变的任务直接从缓存解包产物，只有被击穿包的下游真正重跑。
> **Q2：bbappend 里想删掉上游某条配置怎么办？** 用同名覆盖或 `:remove` 操作符显式删除，不要赌变量叠加顺序。

> [!question] 📝 思考题
> 1. 解释 sstate-cache 为什么能让「换一行代码」的增量构建接近秒级。
> 2. 把 [[ch41-Buildroot定制rootfs全流程]] 的 external tree 项目迁移成 Yocto layer，列出等价物映射表。
> 3. 设计公司级「BSP 平台层 + 产品层」的双层 Yocto 组织结构图。

---
🏷️ #domain/soc #topic/buildsystem | 🔗 [[ch41-Buildroot定制rootfs全流程]] ← **本章** → [[ch43-NPU-GPU应用开发RKNN-MPP]] | 📚 [[P4-MOC]]
