# 架构说明

## 数据流

```text
ScenarioConfig + seed
        │
        ▼
      Game ───────────────► renderer / benchmark
        │ state snapshot
        ▼
     Strategy
        │
        ├── static Hamilton / A* / hybrid
        │
        └── hamilton-dyn
              ├── DynScheduler：预约、落地、解除与事件漏斗
              ├── DynamicCycle：全量候选重建与事务提交
              ├── TwoFactorCycle：可选局部修复引擎
              └── DegradeController：操作数主判据 + 墙钟保险丝
```

## 模块职责

- `game.ts`：唯一游戏状态机；负责边界、碰撞、食物、胜负与指标。
- `grid.ts`：网格、障碍位图和预计算邻接。
- `hamilton.ts`：静态回路构造，不依赖 UI。
- `strategies.ts`：把构造器、调度器和动作选择组合成策略。
- `dyn.ts`：动态回路事务、结构校验、降级控制与事件调度。
- `twofactor.ts`：二分图 b-matching、2-factor 圈合并和增量修复实验。
- `shadow.ts`：小而独立的参考检查器。

## 关键设计约束

- 引擎不得依赖 DOM；浏览器 UI、Web Worker 和 Node.js 脚本复用同一实现。
- 所有随机源必须从明确 seed 派生；食物、障碍和调度随机流分离。
- 正式回路只能由已验证候选替换；失败保留旧状态。
- 动态事件失败必须同时恢复网格与回路视图，不能只回滚一侧。
- 共享 CI 不使用墙钟作为正确性门。

## 扩展一个策略

1. 在 `StrategyId` 和 `STRATEGIES` 中注册名称。
2. 在 `strategies.ts` 实现 `decide(game)`，不要直接修改 `Game` 内部数组。
3. 给静态功能补基准；给动态功能补性质测试和故障注入。
4. 明确声明适用的网格、障碍和对手前置条件。
