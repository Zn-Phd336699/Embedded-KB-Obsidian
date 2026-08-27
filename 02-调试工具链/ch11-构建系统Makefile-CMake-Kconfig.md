---
title: "第11章 构建系统 Makefile-CMake-Kconfig"
part: "[[P2-MOC]]"
chapter: 11
tags:
  - domain/fundamentals
  - topic/build-system
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch10-GCC交叉编译全景]]"
related:
  - "[[ch12-GDB深度实战]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第11章 构建系统：Makefile / CMake / Kconfig

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch10-GCC交叉编译全景]] | → [[ch12-GDB深度实战]]

## 🎯 学习目标
- [ ] 手写带依赖自动生成、多目录的生产级 Makefile
- [ ] 掌握 CMake toolchain 文件套路与 Kconfig select/depends on 语义差异
- [ ] 会用 west 完成 Zephyr 的构建、菜单配置与烧写

## 11.1 生产级 Makefile 骨架（可直接抄）

```makefile
TARGET := fw
BUILD  := build
CROSS  := arm-none-eabi-
CC := $(CROSS)gcc
CPUFLAGS := -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard
CFLAGS := $(CPUFLAGS) -std=c11 -g3 -O2 -Wall -Wextra -Werror \
          -ffunction-sections -fdata-sections \
          -I Core/Inc -I App -I Drivers/CMSIS/Include
LDFLAGS := $(CPUFLAGS) -specs=nano.specs -specs=nosys.specs \
           -T link.ld -Wl,--gc-sections -Wl,-Map=$(BUILD)/$(TARGET).map
SRCS := $(shell find Core App Bsp -name '*.c')
OBJS := $(patsubst %.c,$(BUILD)/%.o,$(SRCS))
$(BUILD)/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) -c $(CFLAGS) -MMD -MP $< -o $@      # -MMD 自动生成 .d 依赖
$(BUILD)/$(TARGET).elf: $(OBJS)      # 默认目标；bin 用 arm-none-eabi-objcopy -O binary
	$(CC) $^ $(LDFLAGS) -o $@
-include $(shell find $(BUILD) -name '*.d')   # 头文件改动也触发重编
```

配套目标两行搞定：`flash:` 执行 `openocd -f board/st_nucleo_f4.cfg -c "program build/fw.elf verify reset exit"`；bin 产物用 `arm-none-eabi-objcopy -O binary`。

## 11.2 CMake 交叉编译三件套

```cmake
# ---- arm-toolchain.cmake ----
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_C_COMPILER   arm-none-eabi-gcc)
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)  # 跳过可执行试编译(无OS)
# ---- CMakeLists.txt ----
project(fw C)
file(GLOB_RECURSE SRCS Core/*.c App/*.c Bsp/*.c)
add_executable(fw ${SRCS})
target_include_directories(fw PRIVATE Core/Inc App)
target_link_options(fw PRIVATE -Tlink.ld -Wl,--gc-sections -Wl,-Map=fw.map)
# POST_BUILD 追加： arm-none-eabi-size fw 与 objcopy -Obinary fw fw.bin
```

使用：`cmake -B build -DCMAKE_TOOLCHAIN_FILE=arm-toolchain.cmake && cmake --build build`；把配置固化进版本库可用 CMakePresets.json（configurePresets/buildPresets），「在我机器上能编」彻底绝迹。

## 11.3 Kconfig 裁剪体系与语义细节

```text
config LOG_LEVEL_DEFAULT
    int "Default log level (0=none..5=debug)"
    default 3
config ENABLE_OTA
    bool "Enable MCUboot OTA support"
    select MBEDTLS      # 自动拉起依赖
流程： menuconfig/west menus → sdkconfig → 变成 -DCONFIG_ENABLE_OTA=1 注入 → #ifdef 生效
```

| 体系 | 配置入口 | 产物 |
|------|----------|------|
| Linux 内核 | make menuconfig / nconfig | .config → autoconf.h |
| Zephyr | west build -t menuconfig | prj.conf 合并 → zephyr/.config |
| ESP-IDF | idf.py menuconfig | sdkconfig（含默认值快照） |

| 语法 | 语义 | 实践准则 |
|------|------|----------|
| depends on A | 我只在 A 开启时可见（被动约束，用户仍可关我） | 策略类配置一律用它 |
| select B | 我被选中时强制打开 B（可能违反 B 自己的 depends！） | 仅库类符号允许被 select |

经典事故链：X select Y 而 Y depends on Z 未满足 → 警告级破坏依赖。defconfig 合并机制（Zephyr/IDF 同构）：prj.conf → 板级 defconfig → Kconfig.defaults 三层合并，后者只供默认值；改板级默认放 board.defconfig 而非手改生成物。

## 11.4 west 命令速查

- `west init` / `west update`：按 manifest 初始化工作区并拉取全部仓库
- `west build -b <board>` 一键构建；`west build -t menuconfig` / `west menus` 打开 Kconfig；`west flash` / `west debug` 烧写与调试（IDF 对应 idf.py menuconfig/build/flash）

## 11.5 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 改头文件没重编 | 查看 .d 是否生成 | 规则补 -MMD -MP 并 -include | 触头文件即重编 |
| 并行编译偶发失败 | 复跑定位竞态目录 | mkdir -p 入规则；目录用 order-only 前置 | make -j 稳定通过 |
| ccache 命中率归零 | ccache -s 统计 | CCACHE_BASEDIR + -fdebug-prefix-map 归一路径 | 命中率回到正常量级 |

## 11.6 实测数据表：三档构建体积对比（典型值）

| 构建档位 | 相对 Flash 占用（典型值） | 适用场景 |
|----------|---------------------------|----------|
| -Og | 100%（基线） | 日常开发，调试友好 |
| -O2 | 95~105% | 量产速度优先 |
| -Os | 80~90%（-flto 通常再省 5~15%） | Flash 紧张的量产构建 |

## 11.7 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| 改了头文件没触发重编 | 没用 -MMD/-MP 自动依赖 | 检查 include .d 规则；make clean 验证差异 |
| CMake compiler check 失败 | 缺 TRY_COMPILE_TARGET_TYPE 或环境污染 | toolchain 补齐；清空 build 重配 |
| menuconfig 改了不生效 / sdkconfig 手改被覆盖 | 改错层级、旧宏名；或手改了生成物 | fullclean 重建；grep CONFIG_ 核对生成头；改动落 prj.conf/defconfig 层 |

## 11.8 部署注意事项

1. `.d` 依赖必须 `-include`，否则头文件改动漏重编；目录类目标用 order-only prerequisite（`|` 语法）根治时间戳抖动。
2. presets 与 toolchain 文件入库，build 目录永不入库。
3. Kconfig 思维直接迁移 Buildroot/Yocto；Zephyr 的 cmake/ 目录是集成天花板，ESP-IDF tools/cmake/ 是组件化范本。

> [!example]- 🧪 动手实验 L11-1：双档构建体积对比流水线（30 分钟）
> **步骤**：① 给工程加 `size` 目标输出 text/data/bss；② 脚本依次以 -Og/-O2/-Os 构建并把三次 size 追加进 size-history.csv；③ 提交一次真实功能改动观察三档增量并挂 CI 留档。**验收**：能回答「这次改动 Flash 多花在哪一档、值不值」。

## 11.9 进阶话题

- **order-only 正确姿势**：`$(OBJS): \| $(BUILD_DIR)`——目录只作存在性依赖不参与时间戳比较。
- **idf.py build 内部真相**：CMake+Ninja 编排器+组件注册注入，读懂 build/project_description.json 即掌握全部输入。
- **Kconfig 预处理宏**：`$(dt_nodelabel_path,...)` 让 Kconfig 与 devicetree 联动（Zephyr 独门），不再硬抄 DT 配置。

> [!warning]- ❓ FAQ
> **Q1：Makefile 还是 CMake？** 两三人裸机项目 Makefile 足够；要 IDE 无关、生态集成或多平台时上 CMake；IDF/Zephyr 用户直接用内置体系。
> **Q2：select 和 depends on 记不住怎么判？** 问「这是库还是策略」——库可被别人 select，策略只能 depends on。

> [!question] 📝 思考题
> 1. 给 11.1 的 Makefile 增加 size/gdbserver/cppcheck 三个目标。
> 2. 解释 order-only prerequisite 为何能解决目录时间戳抖动问题。

---
🏷️ #domain/fundamentals #topic/build-system | 🔗 [[ch10-GCC交叉编译全景]] ← **本章** → [[ch12-GDB深度实战]] | 📚 [[P2-MOC]]
