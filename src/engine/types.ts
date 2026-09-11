/** 方向索引：0=上 1=右 2=下 3=左 */
export type Dir = 0 | 1 | 2 | 3;
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

export type StrategyId =
  | 'greedy-astar'
  | 'safe-astar'
  | 'hamilton'
  | 'hamilton-shortcut'
  | 'hybrid'
  | 'hamilton-dyn'
  | 'manual';

export interface StrategyInfo {
  id: StrategyId;
  name: string;
  short: string;
  color: string;
}

export const STRATEGIES: StrategyInfo[] = [
  { id: 'greedy-astar', name: '贪心 A*（无安全检查）', short: 'Greedy A*', color: '#f97316' },
  { id: 'safe-astar', name: '安全 A*（虚拟蛇 + 追尾 + 最长路径）', short: 'Safe A*', color: '#3b82f6' },
  { id: 'hamilton', name: '纯哈密顿回路', short: 'Hamilton', color: '#8b5cf6' },
  { id: 'hamilton-shortcut', name: '哈密顿回路 + 捷径', short: 'Ham+Shortcut', color: '#10b981' },
  { id: 'hybrid', name: '混合（推荐）：有回路走捷径回路，否则安全 A*', short: 'Hybrid', color: '#ec4899' },
  { id: 'hamilton-dyn', name: '动态障碍回路：事务重建 + p99 保险丝降级', short: 'Ham+Dyn', color: '#22d3ee' },
  { id: 'manual', name: '手动控制（方向键 / WASD，演示用，不参与基准）', short: 'Manual', color: '#94a3b8' },
];

export interface FoodItem {
  cell: number;
  /** 出生步数 */
  bornAt: number;
  /** 过期步数（Infinity 表示永不过期） */
  expiresAt: number;
}

export interface ScenarioConfig {
  id: string;
  name: string;
  level: '基础' | '中等' | '困难' | '极限';
  width: number;
  height: number;
  /** 障碍密度（占全部格子比例） */
  obstacleDensity: number;
  /**
   * 障碍生成模式：
   * - block：障碍对齐 2×2 宏格（要求地图边长为偶数），可用“宏格生成树法”构造覆盖全部自由格的哈密顿回路；
   * - cell：任意单格随机障碍，一般不存在哈密顿回路，只能依赖搜索类策略。
   */
  obstacleMode: 'block' | 'cell';
  /** 同时存在的食物数 */
  foodCount: number;
  /** 食物有效期（步），Infinity 表示不过期 */
  foodTTL: number;
  /** 每步决策时间预算（ms），仅用于统计超时 */
  timeBudgetMs: number;
  /** 是否可在本程序中运行（极限难度仅给出设计） */
  runnable: boolean;
  description: string;
  /** 动态障碍（极限难度）：障碍周期性出现/消失，带 T 步预告（预约位） */
  dynamicObstacles?: boolean;
  /** 动态障碍的宏格数（同时存在的变动宏格数上限） */
  dynCount?: number;
  /** 动态障碍事件周期（步）：每 period 步发生一次增/减 */
  dynPeriod?: number;
  /** 预告期（步）：预约位在落地前多少步标记，策略期内即可规避 */
  dynNotice?: number;
  /** A2-like 过滤对手：允许近头候选并做公平性检查；当前维护器仍可拒绝候选。 */
  forceLand?: boolean;
}

export type FailReason =
  | 'none'
  | 'wall'
  | 'self'
  | 'obstacle'
  | 'starved'
  | 'no-move'
  | 'maintenance'
  | 'step-limit';

export interface GameResult {
  strategy: StrategyId;
  scenario: string;
  seed: number;
  won: boolean;
  /** 吃满率 = 实际长度增量 / 目标增量 */
  fillRate: number;
  /** 格子覆盖率 = 蛇头经过的可通行格数 / 可通行格总数 */
  coverage: number;
  steps: number;
  foods: number;
  freeCells: number;
  finalLength: number;
  /** 每吃一个食物的平均步数 */
  stepsPerFood: number;
  totalDecisionMs: number;
  avgDecisionMs: number;
  maxDecisionMs: number;
  /** 超过时间预算的决策次数 */
  overBudget: number;
  /** 单次决策峰值搜索节点数（内存代理指标） */
  peakNodes: number;
  /** 峰值内存估算（KB）：节点 × 每节点约 24B + 栅格数组 */
  peakMemKB: number;
  failReason: FailReason;
  expiredFoods: number;
}

export interface AggregateResult {
  strategy: StrategyId;
  scenario: string;
  runs: number;
  winRate: number;
  avgFill: number;
  avgCoverage: number;
  avgSteps: number;
  avgStepsPerFood: number;
  avgDecisionMs: number;
  maxDecisionMs: number;
  avgPeakNodes: number;
  avgPeakMemKB: number;
  overBudgetRate: number;
  failReasons: Record<string, number>;
  results: GameResult[];
}
