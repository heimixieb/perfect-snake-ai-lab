export const BASELINE = [
 {
  "scenario": "basic",
  "strategy": "greedy-astar",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.3763,
  "avgCoverage": 0.94,
  "avgSteps": 329,
  "avgStepsPerFood": 8.6,
  "avgDecisionMs": 0.0068,
  "maxDecisionMs": 5.48,
  "avgPeakNodes": 134,
  "avgPeakMemKB": 5.7,
  "failReasons": {
   "no-move": 10
  }
 },
 {
  "scenario": "basic",
  "strategy": "safe-astar",
  "runs": 10,
  "winRate": 0.5,
  "avgFill": 0.9835,
  "avgCoverage": 1,
  "avgSteps": 2040,
  "avgStepsPerFood": 21.4,
  "avgDecisionMs": 0.0062,
  "maxDecisionMs": 3.71,
  "avgPeakNodes": 261,
  "avgPeakMemKB": 8.6,
  "failReasons": {
   "starved": 5
  }
 },
 {
  "scenario": "basic",
  "strategy": "hamilton",
  "runs": 10,
  "winRate": 1,
  "avgFill": 1,
  "avgCoverage": 1,
  "avgSteps": 2419,
  "avgStepsPerFood": 24.9,
  "avgDecisionMs": 0.0005,
  "maxDecisionMs": 0.37,
  "avgPeakNodes": 0,
  "avgPeakMemKB": 2.5,
  "failReasons": {}
 },
 {
  "scenario": "basic",
  "strategy": "hamilton-shortcut",
  "runs": 10,
  "winRate": 1,
  "avgFill": 1,
  "avgCoverage": 1,
  "avgSteps": 2133,
  "avgStepsPerFood": 22,
  "avgDecisionMs": 0.0006,
  "maxDecisionMs": 1.1,
  "avgPeakNodes": 0,
  "avgPeakMemKB": 2.5,
  "failReasons": {}
 },
 {
  "scenario": "basic",
  "strategy": "hybrid",
  "runs": 10,
  "winRate": 1,
  "avgFill": 1,
  "avgCoverage": 1,
  "avgSteps": 2133,
  "avgStepsPerFood": 22,
  "avgDecisionMs": 0.0002,
  "maxDecisionMs": 0.16,
  "avgPeakNodes": 0,
  "avgPeakMemKB": 2.5,
  "failReasons": {}
 },
 {
  "scenario": "medium",
  "strategy": "greedy-astar",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.2386,
  "avgCoverage": 0.9102,
  "avgSteps": 789,
  "avgStepsPerFood": 13.9,
  "avgDecisionMs": 0.0045,
  "maxDecisionMs": 0.26,
  "avgPeakNodes": 470,
  "avgPeakMemKB": 17.5,
  "failReasons": {
   "no-move": 10
  }
 },
 {
  "scenario": "medium",
  "strategy": "safe-astar",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.967,
  "avgCoverage": 1,
  "avgSteps": 11108,
  "avgStepsPerFood": 49.1,
  "avgDecisionMs": 0.0102,
  "maxDecisionMs": 0.78,
  "avgPeakNodes": 738,
  "avgPeakMemKB": 23.8,
  "failReasons": {
   "starved": 9,
   "no-move": 1
  }
 },
 {
  "scenario": "medium",
  "strategy": "hamilton",
  "runs": 10,
  "winRate": 1,
  "avgFill": 1,
  "avgCoverage": 1,
  "avgSteps": 13984,
  "avgStepsPerFood": 60,
  "avgDecisionMs": 0.0002,
  "maxDecisionMs": 0.26,
  "avgPeakNodes": 0,
  "avgPeakMemKB": 6.5,
  "failReasons": {}
 },
 {
  "scenario": "medium",
  "strategy": "hamilton-shortcut",
  "runs": 10,
  "winRate": 1,
  "avgFill": 1,
  "avgCoverage": 1,
  "avgSteps": 12955,
  "avgStepsPerFood": 55.6,
  "avgDecisionMs": 0.0002,
  "maxDecisionMs": 0.22,
  "avgPeakNodes": 0,
  "avgPeakMemKB": 6.5,
  "failReasons": {}
 },
 {
  "scenario": "medium",
  "strategy": "hybrid",
  "runs": 10,
  "winRate": 1,
  "avgFill": 1,
  "avgCoverage": 1,
  "avgSteps": 12955,
  "avgStepsPerFood": 55.6,
  "avgDecisionMs": 0.0002,
  "maxDecisionMs": 0.26,
  "avgPeakNodes": 0,
  "avgPeakMemKB": 6.5,
  "failReasons": {}
 },
 {
  "scenario": "medium-cell",
  "strategy": "greedy-astar",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.2108,
  "avgCoverage": 0.8681,
  "avgSteps": 580,
  "avgStepsPerFood": 13,
  "avgDecisionMs": 0.0032,
  "maxDecisionMs": 0.36,
  "avgPeakNodes": 356,
  "avgPeakMemKB": 14.1,
  "failReasons": {
   "no-move": 10
  }
 },
 {
  "scenario": "medium-cell",
  "strategy": "safe-astar",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.8613,
  "avgCoverage": 1,
  "avgSteps": 8316,
  "avgStepsPerFood": 47.2,
  "avgDecisionMs": 0.0088,
  "maxDecisionMs": 0.62,
  "avgPeakNodes": 623,
  "avgPeakMemKB": 20.3,
  "failReasons": {
   "starved": 10
  }
 },
 {
  "scenario": "medium-cell",
  "strategy": "hamilton",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.8613,
  "avgCoverage": 1,
  "avgSteps": 8316,
  "avgStepsPerFood": 47.2,
  "avgDecisionMs": 0.0078,
  "maxDecisionMs": 0.59,
  "avgPeakNodes": 623,
  "avgPeakMemKB": 20.3,
  "failReasons": {
   "starved": 10
  }
 },
 {
  "scenario": "medium-cell",
  "strategy": "hamilton-shortcut",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.8613,
  "avgCoverage": 1,
  "avgSteps": 8316,
  "avgStepsPerFood": 47.2,
  "avgDecisionMs": 0.0079,
  "maxDecisionMs": 4.47,
  "avgPeakNodes": 623,
  "avgPeakMemKB": 20.3,
  "failReasons": {
   "starved": 10
  }
 },
 {
  "scenario": "medium-cell",
  "strategy": "hybrid",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.8804,
  "avgCoverage": 1,
  "avgSteps": 9508,
  "avgStepsPerFood": 52.7,
  "avgDecisionMs": 0.0071,
  "maxDecisionMs": 2.22,
  "avgPeakNodes": 623,
  "avgPeakMemKB": 20.3,
  "failReasons": {
   "starved": 10
  }
 },
 {
  "scenario": "hard",
  "strategy": "greedy-astar",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.1296,
  "avgCoverage": 0.6674,
  "avgSteps": 480,
  "avgStepsPerFood": 10.2,
  "avgDecisionMs": 0.0141,
  "maxDecisionMs": 0.77,
  "avgPeakNodes": 383,
  "avgPeakMemKB": 19.1,
  "failReasons": {
   "no-move": 10
  }
 },
 {
  "scenario": "hard",
  "strategy": "safe-astar",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.9458,
  "avgCoverage": 1,
  "avgSteps": 11351,
  "avgStepsPerFood": 32.4,
  "avgDecisionMs": 0.0157,
  "maxDecisionMs": 4.09,
  "avgPeakNodes": 1757,
  "avgPeakMemKB": 51.3,
  "failReasons": {
   "starved": 9,
   "no-move": 1
  }
 },
 {
  "scenario": "hard",
  "strategy": "hamilton",
  "runs": 10,
  "winRate": 1,
  "avgFill": 1,
  "avgCoverage": 1,
  "avgSteps": 13814,
  "avgStepsPerFood": 37.8,
  "avgDecisionMs": 0.0002,
  "maxDecisionMs": 0.21,
  "avgPeakNodes": 0,
  "avgPeakMemKB": 10.2,
  "failReasons": {}
 },
 {
  "scenario": "hard",
  "strategy": "hamilton-shortcut",
  "runs": 10,
  "winRate": 1,
  "avgFill": 1,
  "avgCoverage": 1,
  "avgSteps": 12224,
  "avgStepsPerFood": 33.5,
  "avgDecisionMs": 0.0002,
  "maxDecisionMs": 0.29,
  "avgPeakNodes": 0,
  "avgPeakMemKB": 10.2,
  "failReasons": {}
 },
 {
  "scenario": "hard",
  "strategy": "hybrid",
  "runs": 10,
  "winRate": 1,
  "avgFill": 1,
  "avgCoverage": 1,
  "avgSteps": 12224,
  "avgStepsPerFood": 33.5,
  "avgDecisionMs": 0.0002,
  "maxDecisionMs": 0.28,
  "avgPeakNodes": 0,
  "avgPeakMemKB": 10.2,
  "failReasons": {}
 },
 {
  "scenario": "hard-cell",
  "strategy": "greedy-astar",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.1523,
  "avgCoverage": 0.7065,
  "avgSteps": 546,
  "avgStepsPerFood": 10,
  "avgDecisionMs": 0.0139,
  "maxDecisionMs": 0.36,
  "avgPeakNodes": 511,
  "avgPeakMemKB": 22.1,
  "failReasons": {
   "no-move": 10
  }
 },
 {
  "scenario": "hard-cell",
  "strategy": "safe-astar",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.8967,
  "avgCoverage": 0.9986,
  "avgSteps": 12399,
  "avgStepsPerFood": 36.5,
  "avgDecisionMs": 0.0158,
  "maxDecisionMs": 1.08,
  "avgPeakNodes": 1437,
  "avgPeakMemKB": 43.8,
  "failReasons": {
   "starved": 9,
   "no-move": 1
  }
 },
 {
  "scenario": "hard-cell",
  "strategy": "hamilton",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.8967,
  "avgCoverage": 0.9986,
  "avgSteps": 12399,
  "avgStepsPerFood": 36.5,
  "avgDecisionMs": 0.0148,
  "maxDecisionMs": 0.93,
  "avgPeakNodes": 1437,
  "avgPeakMemKB": 43.8,
  "failReasons": {
   "starved": 9,
   "no-move": 1
  }
 },
 {
  "scenario": "hard-cell",
  "strategy": "hamilton-shortcut",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.8967,
  "avgCoverage": 0.9986,
  "avgSteps": 12399,
  "avgStepsPerFood": 36.5,
  "avgDecisionMs": 0.0138,
  "maxDecisionMs": 2.16,
  "avgPeakNodes": 1437,
  "avgPeakMemKB": 43.8,
  "failReasons": {
   "starved": 9,
   "no-move": 1
  }
 },
 {
  "scenario": "hard-cell",
  "strategy": "hybrid",
  "runs": 10,
  "winRate": 0,
  "avgFill": 0.8978,
  "avgCoverage": 0.9986,
  "avgSteps": 12916,
  "avgStepsPerFood": 38,
  "avgDecisionMs": 0.0152,
  "maxDecisionMs": 1.07,
  "avgPeakNodes": 1437,
  "avgPeakMemKB": 43.8,
  "failReasons": {
   "starved": 9,
   "no-move": 1
  }
 }
] as const;
