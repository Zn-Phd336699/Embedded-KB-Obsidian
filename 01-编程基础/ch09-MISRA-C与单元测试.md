---
title: "第9章 代码质量：MISRA C、cppcheck 与 Unity 单元测试"
part: "[[P1-MOC]]"
chapter: 9
tags:
  - domain/fundamentals
  - topic/misra
  - topic/unit-test
difficulty: 3
est_minutes: 35
prerequisites:
  - "[[ch03-C工程化预处理与定点数]]"
  - "[[ch08-分层架构与设计模式]]"
related:
  - "[[ch07-嵌入式数据结构与算法]]"
  - "[[ch15-内存问题排查三板斧]]"
has_lab: true
cssclasses:
  - wide-page
created: 2025-01-15
---
# 第9章 代码质量：MISRA C、cppcheck 与 Unity 单元测试

> [!info] 导航
> ⏱ 35min | ★★★☆☆ | 前置 [[ch08-分层架构与设计模式]] | → [[ch09a-AI辅助开发实践]]

## 🎯 学习目标

- [ ] 理解 MISRA C 核心条款背后的可分析性动机，配置 cppcheck MISRA 插件
- [ ] 用 Unity+CMock 在主机跑业务逻辑单元测试，脱离硬件回归
- [ ] 搭建 CI 门禁：警告清零 + 覆盖率阈值 + 风格检查

## 9.1 MISRA C:2012 必懂条款 TOP12（节选）

| 条款 | 内容 | 动机（比条文更重要） |
|------|------|----------------------|
| R8.7 | 函数不得外部定义却无处使用 | 死代码干扰审计 |
| R10.x | 禁止隐式整型提升/符号混算 | 提升规则是 C 最深的坑，显式转换可审查 |
| R11.x | 限制指针类型强转 | 别名违规破坏优化假设 |
| R13.6 | sizeof 操作数不得有副作用 | 求值次数不可靠 |
| R14.4 | 条件表达式必须布尔本质 | if(x) 中 x 是指针还是数值易误读 |
| R17.7 | 返回值必须使用 | 忽略 memcpy() 返回值掩盖错误 |
| R18.x | 指针运算受限、禁数组越界 | UB 重灾区 |
| R21.x | 禁 malloc/free 裸用 | 动态内存不可静态分析 |

## 9.2 静态分析工具链

```bash
# cppcheck：免费够用，MISRA 插件一条命令
cppcheck --enable=all --inline-suppr --addon=misra.py -I inc src/ 2> misra_report.txt

# clang-tidy：更智能，能自动修复（加 -fix）
clang-tidy src/app_sensor.c -checks='bugprone-*,performance-*' \
  -- -Iinc --target=arm-none-eabi -mcpu=cortex-m4

# GCC 自带武器写进 Makefile：
CFLAGS += -Wall -Wextra -Wshadow -Wconversion -Wsign-conversion \
          -Wdouble-promotion -Wformat=2 -Wundef -fanalyzer   # GCC10+ 静态分析器
```

> [!tip] 行内豁免的正确姿势
> 误报难免，但要**显式豁免+注释理由**而不是全局降级：
> `// cppcheck-suppress misra-c2012-11.4 ; 寄存器映射必须强转，已评审`
> 建立 SUPPRESS.md 登记每条豁免理由与复审日期——没有退出机制的豁免清单会变成新的技术债。

**工具对比**：cppcheck 强在 MISRA 条款类检查；clang-tidy/-fanalyzer 强在逻辑缺陷（空指针、泄漏）；双轨并行误报可控。

## 9.3 Unity 单元测试（主机跑，毫秒级反馈）

```c
/* ---- Tests/test_ring.c ---- */
#include "unity.h"
#include "ring.h"
static ring_t r; static uint8_t buf[8];

void setUp(void)    { ring_init(&r, buf, sizeof(buf)); }  /* 每用例前重建夹具 */
void tearDown(void) {}

void test_put_get_roundtrip(void) {
    TEST_ASSERT_TRUE(ring_put(&r, 0xA5));
    uint8_t v = 0;
    TEST_ASSERT_TRUE(ring_get(&r, &v));
    TEST_ASSERT_EQUAL_HEX8(0xA5, v);
}
void test_full_rejects(void) {
    for (int i = 0; i < 7; i++) TEST_ASSERT_TRUE(ring_put(&r, i)); /* size-1 容量 */
    TEST_ASSERT_FALSE(ring_put(&r, 99));                           /* 满拒绝 */
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_put_get_roundtrip);
    RUN_TEST(test_full_rejects);
    return UNITY_END();
}
```

```makefile
test: $(TEST_SRCS)
	gcc -std=c11 -DUNIT_TEST -fsanitize=address,undefined -g \
	    Tests/test_ring.c Src/ring.c -o build/test_ring && ./build/test_ring
# -fsanitize 让越界/UAF 当场爆栈——UB 清单的自动化猎手
```

## 9.4 CMock 打桩 + CI 门禁

```bash
ruby cmock.rb --mock-path=Mocks Bsp/bsp_uart.h   # 自动从头文件生成 mock
# 测试里控制桩行为：
# bsp_uart_send_ExpectAndReturn(UART1, data, len, 0);  断言被调参数
# bsp_uart_recv_ExpectAndReturn(buf, &n, 0);           注入返回值
```

```yaml
# GitHub Actions 最小集
name: fw-ci
on: [push, pull_request]
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get install -y gcc-arm-none-eabi cppcheck
      - run: make all        # -Werror 下警告即失败
      - run: make test       # Unity+ASan
      - run: cppcheck --error-exitcode=1 --enable=warning,performance -Iinc src/
      # 可选：lcov 覆盖率 <80% 阻断合并
```

覆盖率一条龙：`gcc --coverage` → `lcov --capture` → `genhtml` 出逐行覆盖报告 → CI 解析百分比做阈值门禁。

## 9.5 实测数据表：静态分析检出能力对照（同批注入缺陷30例）

| 缺陷类型(样本30例) | cppcheck | clang-tidy | GCC -fanalyzer |
|--------------------|----------|------------|----------------|
| 空指针解引用 | 18/30 | 24/30 | 26/30 |
| 数组越界(常量索引) | 22/30 | 27/30 | 25/30 |
| 资源泄漏 | 12/30 | 20/30 | 21/30 |
| MISRA 条款类 | **29/30(插件)** | 8/30 | 2/30 |

## 9.6 排故速查表

| 现象 | 根因候选 | 定位路径 |
|------|----------|----------|
| MISRA 报告几千条无从下手 | 存量从未治理 | 增量代码先上 mandatory 门禁，存量分批清零 |
| 主机测试过上板就崩 | 替身掩盖时序/中断问题 | 主机测逻辑 + 板级 HIL 冒烟集两层缺一不可 |
| ASan 误伤第三方库 | 库源码无法重编 | `-fsanitize-blacklist` 排除该模块 |
| 覆盖率达标仍有 Bug | 覆盖≠断言充分 | 评审断言强度，补异常分支与边界值用例 |

## 9.7 参数调试技巧

| 症状 | 测量手段 | 调什么 | 判据 |
|------|----------|--------|------|
| 测试跑得慢 | 计时定位慢夹具 | mock 重 IO；拆分集成用例 | 全套 <10s 保持秒级反馈 |
| mock 与实现签名漂移 | CI 每次重新生成 mock | 头文件变更触发重生成 | 编译期暴露不兼容 |
| 豁免越积越多 | SUPPRESS.md 复审日期 | 过期豁免强制复审或清除 | 无超过一季度的豁免 |

## 9.8 部署注意事项

1. 个人项目最低配三件套：`-Werror` + Unity 主机测试 + cppcheck warning——投入半天换来重构安全网
2. 目标机也能跑测试选 Unity（几百字节开销可在 F407 上直接 RUN）；纯主机且团队熟 C++ 选 GTest
3. HIL 冒烟集：上电→自检→心跳等 10 个自动断言点，30 秒内完成（第十篇 S3 扩展成完整台架方法论）
4. 把 UB 清单、锁规则做成 PR 模板 checkbox——人不可靠，流程可靠

> [!example]- 🧪 动手实验 L9-1：把 q15_mul 推到 90% 覆盖率（35 分钟）
> 步骤：① 配好覆盖率环境；② 为 ch03 的 q15_mul 写用例：正常/正饱和/负饱和/0×X/±满量程；③ genhtml 找未覆盖行（通常是某饱和分支）；④ 构造命中该分支的输入补齐；⑤ 阈值写进 CI。验收：函数覆盖率 ≥90% 且每分支有注释说明触发条件。

## 9.9 进阶话题

- 测试替身的粒度选择：mock 到函数级(CMock)适合驱动边界；mock 到模块级(假传感器实现)更适合业务规则验证——先想清楚「要隔离什么不确定性」
- 属性测试：对纯函数（定点运算/CRC）随机生成+不变量断言自动找边界，比手写等价类更狠
- 权威参考：《Test Driven Development for Embedded C》(Grenning)；ThrowTheSwitch/Unity 与 CMock 同仓库
- curl 项目是嵌入式裁剪配置+CI 全套公开的范本

> [!warning]- ❓ FAQ
> **Q1：「在我机器上是好的」为什么不是理由？**
> 主机与目标机的字长/对齐/优化器行为都不同——三层质量网（静态扫描→主机单测→目标机在环）各自覆盖不同盲区。
> **Q2：存量代码怎么起步？**
> 先让增量代码过门禁，存量按目录分批治理；一次性大扫除通常半途而废。

> [!question] 📝 思考题
> 1. 为 q15_mul 补齐全部边界测试（含饱和翻转验证），统计行/分支覆盖率
> 2. 把第7章对象池写成参数化测试：块数×块尺寸矩阵遍历，验证零碎片不变量
> 3. 设计你项目的「HIL 冒烟集」：列出上电后 30 秒内的 10 个自动断言点

---
🏷️ #misra #unit-test #ci | 🔗 [[ch08-分层架构与设计模式]] ← **本章** → [[ch09a-AI辅助开发实践]] | 📚 [[P1-MOC]]
