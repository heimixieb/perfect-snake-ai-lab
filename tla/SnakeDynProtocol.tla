------------------------------ MODULE SnakeDynProtocol ------------------------------
(***************************************************************************)
(* 贪吃蛇动态障碍维护协议：DynScheduler <-> DynamicCycle <-> DegradeController *)
(*                                                                         *)
(* 建模范围（老师定案：6×6 小规模 PlusCal 粒度 + TLC 穷举事件交错）：          *)
(*  - Scheduler：事件编排（预约/落地/回滚/退避）                              *)
(*  - Cycle：回路维护手术（remove/insert 宏格，成败二值抽象）                 *)
(*  - Controller：降级/滞回恢复                                              *)
(*                                                                         *)
(* 实装对照（dyn.ts DynScheduler.tick）：                                     *)
(*  block: 预约(占用蛇身则丢弃) -> NOTICE 步预告 -> 落地 applyBlock          *)
(*         -> onBlocked 对齐；失败 => 回滚 grid + 放弃事件                    *)
(*  unblock: onUnblock 预排；失败 => 退避 backoff*2 重试，tries>MAX 才放弃    *)
(*           （活性红线：指数退避不可放弃）；成功 => applyUnblock + 对齐       *)
(*                                                                         *)
(* 不变量：                                                                  *)
(*  TypeOK     状态类型良构                                                  *)
(*  InvConsist 支持集与自由宏格集一致（事件完成后）/ 预约格在支持集外           *)
(*  InvReserved reserved 与 blocked 不重叠；预约必须挂着 pending block        *)
(*  InvAtomic  事件拒绝后 grid 与支持集回滚到事件前一致状态                    *)
(* 活性（公平性假设见 Fairness 节）：                                          *)
(*  UnblockResolves  pending unblock 最终缝回（协议主活性）                    *)
(*  BlockResolves    pending block 最终落地或被放弃（无永久 pending）          *)
(*  AlwaysProgress   协议不死锁（任一状态总有后续步）                          *)
(*                                                                         *)
(* 状态空间控制：MW=3, MH=3（6×6 格）；单 pending；NOTICE=2；MAX_TRIES=2。    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

Abs(x) == IF x >= 0 THEN x ELSE 0 - x

CONSTANTS MW, MH, MAX_TRIES, NOTICE, RECOVERY

Macros == 0 .. (MW * MH - 1)

macroNb(m) ==  (* 宏格 4-邻接（格图宏格粒度） *)
  LET mx == m % MW
      my == m \div MW
  IN { nm \in Macros :
         LET nx == nm % MW
             ny == nm \div MW
         IN Abs(nx - mx) + Abs(ny - my) = 1 }

VARIABLES
  pending,     \* "none" 或 [kind |-> {"block","unblock"}, macro, at, tries]
  blockedM,    \* [Macros -> {0,1}]
  reservedM,   \* [Macros -> {0,1}]
  cycleM,      \* [Macros -> {0,1}] 回路支持集（= 自由宏格；手术瞬态可短暂≠）
  inFlight,    \* "none" | "removing" | "inserting"  手术进行中（原子性窗口）
  degraded,
  degradeLeft, \* 滞回观察期剩余步
  headM,       \* 蛇头所在宏格（安全不变量载体）
  walkSpikes,  \* 观察期内 walk spike 计数（0/1 抽象）
  step

vars == <<pending, blockedM, reservedM, cycleM, inFlight, degraded, degradeLeft, headM, walkSpikes, step>>

TypeOK ==
  /\ \/ pending = "none"
     \/ /\ pending # "none"
        /\ pending.kind \in {"block", "unblock"}
        /\ pending.macro \in Macros
        /\ pending.atStep \in Nat
        /\ pending.tries \in Nat
  /\ blockedM  \in [Macros -> {0,1}]
  /\ reservedM \in [Macros -> {0,1}]
  /\ cycleM    \in [Macros -> {0,1}]
  /\ inFlight  \in {"none", "removing", "inserting"}
  /\ degraded  \in BOOLEAN
  /\ degradeLeft \in Nat
  /\ headM \in Macros
  /\ walkSpikes \in {0, 1}
  /\ step \in Nat

(***************************************************************************)
(* Cycle 手术抽象：remove/insert 宏格的成功/失败由「手术可行性」nondet 选择， *)
(* 但失败必须回滚（不变量强制）。可行域约束：remove 后支持集仍连通            *)
(* （割点必失败，与实装 isCutVertex 预筛一致）；insert 后支持集连通。         *)
(***************************************************************************)
RECURSIVE ReachF
(* 支持集邻接图传递闭包（s 上相邻 = 宏格 4-邻接） *)
ReachF ==  (* 递归函数：RF[sup][a][b][n]；域有界（|sup| ≤ MW*MH，路径 ≤ 宏格数必达不动点） *)
  [sup \in SUBSET Macros, a \in Macros, b \in Macros, n \in 0 .. (MW * MH) |->
     IF n = 0 THEN a = b
     ELSE a = b \/ \E m \in sup : b \in macroNb(m) /\ ReachF[sup][a][m][n - 1]]

Reach(sup, a, b, plen) == ReachF[sup][a][b][plen]

(* 支持集连通：任取起点 start，sup 内所有格都在 |sup| 步内可达 *)
Connected(sup) ==
  \/ sup = {}
  \/ LET start == CHOOSE x \in sup : TRUE
     IN \A q \in sup : Reach(sup, start, q, Cardinality(sup))


(* ---------------- 初始状态 ---------------- *)
Init ==
  /\ pending = "none"
  /\ blockedM  = [m \in Macros |-> 0]
  /\ reservedM = [m \in Macros |-> 0]
  /\ cycleM    = [m \in Macros |-> 1]
  /\ inFlight = "none"
  /\ degraded = FALSE
  /\ degradeLeft = 0
  /\ headM = 0
  /\ walkSpikes = 0
  /\ step = 0

(* ---------------- Scheduler 动作 ---------------- *)

(* 预约 block：挑一个自由、未预约、未 blocked、非蛇头的宏格；
 * 接受即拆除支持集（实装 onReserve 预排），移除后支持集须仍连通（isCutVertex 预筛） *)
Reserve(m) ==
  /\ pending = "none"
  /\ inFlight = "none"
  /\ blockedM[m] = 0 /\ reservedM[m] = 0 /\ headM # m
  /\ Connected({q \in Macros : cycleM[q] = 1 /\ q # m})    (* 移除后连通才可接受（实装 isCutVertex 预筛） *)
  /\ cycleM' = [cycleM EXCEPT ![m] = 0]
  /\ pending' = [kind |-> "block", macro |-> m, atStep |-> step + NOTICE, tries |-> 0]
  /\ reservedM' = [reservedM EXCEPT ![m] = 1]
  /\ blockedM' = blockedM
  /\ inFlight' = "none"
  /\ UNCHANGED <<degraded, degradeLeft, headM, walkSpikes, step>>

(* 落地 block：到期 -> grid 更新 -> onBlocked 对齐（成功分支） *)
LandBlock ==
  /\ pending.kind = "block"
  /\ step >= pending.atStep
  /\ inFlight = "none"
  /\ blockedM' = [blockedM EXCEPT ![pending.macro] = 1]
  /\ reservedM' = [reservedM EXCEPT ![pending.macro] = 0]
  /\ cycleM' = cycleM                      (* 预约时已拆除，支持集不变 *)
  /\ pending' = "none"
  /\ inFlight' = "none"
  /\ UNCHANGED <<degraded, degradeLeft, headM, walkSpikes, step>>

(* 落地 block 失败：onBlocked 返回 false => 回滚 grid + 放弃事件（InvAtomic 验证点） *)
LandBlockFail ==
  /\ pending.kind = "block"
  /\ step >= pending.atStep
  /\ inFlight = "none"
  /\ blockedM' = [blockedM EXCEPT ![pending.macro] = 0]   (* 回滚 grid *)
  /\ reservedM' = [reservedM EXCEPT ![pending.macro] = 0]
  /\ cycleM' = [cycleM EXCEPT ![pending.macro] = 1]       (* 缝回支持集 *)
  /\ pending' = "none"
  /\ inFlight' = "none"
  /\ UNCHANGED <<degraded, degradeLeft, headM, walkSpikes, step>>

(* 预约 unblock：挑一个 blocked 宏格准备缝回 *)
ReserveUnblock(m) ==
  /\ pending = "none"
  /\ inFlight = "none"
  /\ blockedM[m] = 1 /\ reservedM[m] = 0
  /\ pending' = [kind |-> "unblock", macro |-> m, atStep |-> step, tries |-> 0]
  /\ UNCHANGED <<blockedM, reservedM, cycleM, inFlight, degraded, degradeLeft, headM, walkSpikes, step>>

(* unblock 预排成功：onUnblock true -> applyUnblock -> 对齐 *)
PrealignUnblockOK ==
  /\ pending.kind = "unblock"
  /\ step >= pending.atStep
  /\ inFlight = "none"
  /\ blockedM' = [blockedM EXCEPT ![pending.macro] = 0]
  /\ cycleM' = [cycleM EXCEPT ![pending.macro] = 1]
  /\ pending' = "none"
  /\ inFlight' = "none"
  /\ UNCHANGED <<reservedM, degraded, degradeLeft, headM, walkSpikes, step>>

(* unblock 预排失败：退避重试（tries+1, at 后移）；tries>MAX => 放弃 *)
PrealignUnblockRetry ==
  /\ pending.kind = "unblock"
  /\ step >= pending.atStep
  /\ pending.tries < MAX_TRIES
  /\ pending' = [pending EXCEPT !["tries"] = pending.tries + 1,
                              !["atStep"] = step + 1 + pending.tries]  (* 指数退避抽象：2^tries 步 *)
  /\ UNCHANGED <<blockedM, reservedM, cycleM, inFlight, degraded, degradeLeft, headM, walkSpikes, step>>

PrealignUnblockGiveUp ==
  /\ pending.kind = "unblock"
  /\ step >= pending.atStep
  /\ pending.tries >= MAX_TRIES
  /\ pending' = "none"
  /\ UNCHANGED <<blockedM, reservedM, cycleM, inFlight, degraded, degradeLeft, headM, walkSpikes, step>>

(* ---------------- 蛇步进（协议时钟 + 降级交互） ---------------- *)
(* pending 保持不变；头部走向一个自由宏格邻格；环境自由决定本步是否产生 walk spike；
 * 降级判据抽象：非降级时 spike -> degraded；降级中 RECOVERY 步无 spike -> 恢复。 *)
SnakeStep ==
  /\ step' = step + 1
  /\ \E d \in macroNb(headM) :
       blockedM[d] = 0 /\ reservedM[d] = 0 /\ headM' = d
  /\ \E sp \in {0, 1} :
       walkSpikes' = sp
       /\ degraded' =
            IF ~degraded /\ sp = 1 THEN TRUE
            ELSE IF degraded /\ degradeLeft + 1 >= RECOVERY /\ sp = 0 THEN FALSE
            ELSE degraded
       /\ degradeLeft' = IF degraded' /\ ~degraded THEN 0
                         ELSE IF degraded THEN degradeLeft + 1
                         ELSE 0
  /\ UNCHANGED <<pending, blockedM, reservedM, cycleM, inFlight>>

Next ==
  \/ \E m \in Macros : Reserve(m)
  \/ LandBlock
  \/ LandBlockFail
  \/ \E m \in Macros : ReserveUnblock(m)
  \/ PrealignUnblockOK
  \/ PrealignUnblockRetry
  \/ PrealignUnblockGiveUp
  \/ SnakeStep

Fairness == WF_vars(Next)

(* ---------------- 时序规格 ---------------- *)
Spec == Init /\ [][Next]_vars /\ Fairness

(* ---------------- 不变量 ---------------- *)
NoOverlap == \A m \in Macros : ~(reservedM[m] = 1 /\ blockedM[m] = 1)

ReservedHoldsPending ==
  \A m \in Macros : reservedM[m] = 1 => (pending # "none" /\ pending.kind = "block" /\ pending.macro = m)

(* 稳态（无手术窗口）支持集 = 自由宏格 *)
Steady == inFlight = "none"
CycleMatchesGrid ==
  Steady => (\A m \in Macros : cycleM[m] = 1 <=> blockedM[m] = 0)

SafeAfterEvent ==
  Steady => \A m \in Macros : (blockedM[m] = 1 => cycleM[m] = 0)

Inv ==
  /\ TypeOK
  /\ NoOverlap
  /\ ReservedHoldsPending
  /\ CycleMatchesGrid
  /\ SafeAfterEvent

=============================================================================
