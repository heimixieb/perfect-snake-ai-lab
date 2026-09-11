# Contributing

感谢你愿意改进 Perfect Snake AI Lab。

## 本地检查

```bash
npm ci
npm run typecheck
npm run build
npm run test:property
npm run test:shadow
```

提交 PR（Pull Request，拉取请求）前建议运行 `npm run verify`。完整 100-seed 性能门耗时较长，可用 `npm run bench:dyn` 单独执行。

## 正确性声明

新增结论时，请标记它属于：

- 推导：列出前置条件和不变量；
- 运行时验证：指出检查器和失败路径；
- 实验：记录命令、seed、样本数、环境和指标公式。

不要用“样本全胜”表示总体成功率已被证明，也不要用一般问题的 NP-完备性解释某个具体启发式的失败率。

## 性能结果

至少附上 CPU、操作系统、Node.js 版本、命令、seed 范围和 pooled p99。不要把“逐局 p99 再取 p99”标成总体单步 p99。

## 代码风格

- 使用严格 TypeScript 和现有 ES module 导入风格。
- 核心引擎保持无 DOM 依赖。
- 不硬编码密钥或机器路径。
- 新的动态状态变更必须有失败回滚测试。
- 新指标必须在注释或 `docs/verification.md` 中给出精确定义。
