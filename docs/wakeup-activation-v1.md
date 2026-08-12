# Kli Wakeup Activation V1 基线

> 一套不是闹钟、不是固定主动推送的 Agent 唤醒基线。
> 它先解决"没有任何外部事件，TA 也能自然获得运行机会"，再在同一底座上扩展外部事件与主观状态调制。
>
> 基线固定的是结构，不是把 TA 的节律写死。
> 默认参数只是 WakeActivationPolicy v1.0-dev 的开发校准起点。

---

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│                   Wake Sources                       │
│  Spontaneous  │  Precise Event  │  Context Change    │
│  (内生随机)   │  (iOS/Calendar) │  (Status/Scene)    │
├─────────────────────────────────────────────────────┤
│                  WakeEngine                          │
│  State(D,T,X) → λ(t) → CumulativeHazard → θ trigger  │
│  + RunKick  +  Modulation接口                        │
├─────────────────────────────────────────────────────┤
│                 Agent Agency                         │
│  Wake 之后：silent / 聊天 / MCP / ActionIntent        │
│  所有来源只提供运行机会，不替 TA 决定说什么             │
└─────────────────────────────────────────────────────┘
```

---

## 作为 amsg WakeSource 接入

SullyOS 已集成 `@rei-standard/amsg-*` 主动消息基础设施。WakeEngine 作为 amsg 的一个内生 WakeSource 接入，不替代现有机制：

1. **WakeEngine 产生 SpontaneousWakeOpportunity**：当累积 hazard 超过阈值 θ，生成一个 `wakeOpportunity` 事件。
2. **amsg WakeSupervisor 接收事件**：根据当前上下文决定是否 dispatch 一次 Agent Run。
3. **Agent Run 之后**：WakeEngine 收到 `onAgentRun()` 回调，施加 run kick，更新状态。
4. **精确事件走原有通道**：iOS/Calendar/Reminder 等精确 Wake 不经过 λ(t)，直接通过 amsg 的 external event 通道触发。

```
WakeEngine ──(spontaneousWake)──▶ amsg WakeSupervisor
                                      │
                                      ├── dispatch Agent Run
                                      │        │
                                      │        └── onAgentRun() → WakeEngine (run kick)
                                      │
                                      └── silent (不 dispatch)
```

---

## 完整基线文档

以下为 Kli Wakeup Activation V1 基线的完整技术文档。

---

## 01 - WHY THIS MODEL

### 为什么不是"每隔多久醒一次"

- **固定间隔**：每 60 分钟 → Wake。本质是闹钟，完全可预测。
- **随机时间盒**：随机时间盒 40~90 分钟 → random() → Wake。只是高级闹钟，随机性没有连续状态。

V1 不问"下一次几点醒"，而是持续维护"此刻有多容易自然醒"。

> 这里有一个很容易混淆的点：
> "30 分钟内至少醒过一次"的累计概率会随时间增加，但 λ(t) 本身不因为用户离开更久就机械升高。即使 λ(t) 一直不变，随机事件在 30 分钟里也比在 1 分钟里有更多机会发生。这只是累计概率，不等于"TA 越等越想醒"。

**CONSTANT-HAZARD EXAMPLE**：若 λ 恒定，则 P(T ≤ t) = 1 - exp(-λt)

因此，用户离线时长本身不会被 Kli 解释成担心、想念或关系变化。未来如果"很久没回复"在特定上下文中真的形成主观意义，应由 EB 产生，再通过调制接口影响 λ(t)。

---

## 02 - STATE MODEL

### 三个内部状态分别负责什么

| 字段 | 推荐默认值 | 作用 | 越高 | 越低 |
|------|------------|------|------|------|
| activationDrive | initial / mean = 0.50 | 短时间尺度的当前激活驱动力；每次真实 Agent Run 后受到一次轻微负向 kick，再均值回归。 | 此刻更容易自然 Wake | 短期更安静 |
| latentActivityTone | initial / mean = 0.50 | 几小时尺度的活跃底色，决定"这一阵整体偏活跃还是偏安静"。 | 一段时间整体更觉醒 | 一段时间整体更安静 |
| stochasticDriftState | initial = 0.00 | 有惯性的短期随机漂移；不是每分钟重新抽签。 | 当前这阵随机偏活跃 | 当前这阵随机偏安静 |

**初始化只发生一次**：只有系统第一次没有任何 ActivationState 时才使用默认值。之后状态持续保存、持续演化；服务重启读取旧状态，不重新初始化。

**真实 AgentRun 会产生"状态影响"，但没有 cooldown**：
任何 UserTurn、ExternalWake、SpontaneousWake，只要真的让 Agent 跑过一次，就对 activationDrive 施加轻微负向 kick。
`D ← clamp(D - k_run, D_min, D_max)`，默认 k_run = 0.10
这不是"未来 N 分钟禁止 Wake"，只是刚运行完后短期稍微安静一点。Tone 和 Drift 不会因此被硬重置。

---

## 03 - STATE DYNAMICS

### activationDrive：回到正常中心

```
BETWEEN AGENT RUNS
D(t+Δ) = μD + [D(t) - μD]·ρD
ρD = 2^(-Δ/τD)
```
μD = 0.50，τD = 12 min。D 偏低会慢慢回 0.50；D 偏高也会慢慢回 0.50。时间本身不会把 D 推向越来越高。

### latentActivityTone：慢变化"这一阵的活跃底色"

```
T' = μT + (T - μT)·ρT + σT·√(1 - ρT²)·ε
ρT = 2^(-Δ/τT)，ε ~ N(0,1)
```
默认 μT=0.50、τT=6h、σT=0.10、范围 [0.25, 0.75]。

### stochasticDriftState：短期有惯性的随机波动

```
X' = X·ρX + σX·√(1 - ρX²)·ε
ρX = 2^(-Δ/τX)
```
默认 τX=25min、σX=0.18、范围 [-0.40, +0.40]。

> 这里的随机数必须可重建：每个 Activation Cycle 保存 entropy/seed。服务重启继续同一随机轨迹，不重新抽一次。

---

## 04 - λ(t)

### 最终决定"此刻多容易醒"的函数

```
WAKE ACTIVATION POLICY v1.0-dev
λ(t) = clamp( λθ · exp[βD(D-μD) + βT(T-μT) + βX·X] · Mmod, λmin, λmax )
```

| 参数 | 默认值 | 越高的效果 | 越低的效果 |
|------|--------|------------|------------|
| λθ / lambdaBase | 1.50 / hour | 整体更频繁 | 整体更安静 |
| βD | 1.80 | 更敏感于短期 Drive | Drive 对 Wake 影响更弱 |
| βT | 1.60 | 活跃/安静的"时段底色"更明显 | 各时段更接近平均 |
| βX | 1.20 | 随机波动更容易形成短期 burst | 节律更平稳 |
| λmin | 0.15 / hour | 极安静状态也较容易偶尔醒 | 极安静时可能沉默很久 |
| λmax | 8.00 / hour | 允许极强状态出现更密集 Wake | 更早限制极端 burst |
| Mmod | 1.00 | 外部/主观系统让 spontaneous 更容易 Wake | 让 spontaneous 更安静 |

> λ(t) 不等于"发消息概率"。λ 只决定获得一次运行机会的瞬时倾向。Wake 之后仍可能 silent。

---

## 05 - RANDOM THRESHOLD

每个新的 spontaneousActivationCycle 开始时，只生成一次：
`U ~ Uniform(0,1)`，`θ = -ln(U)`，因此 `θ ~ Exp(1)`
同一个 Cycle 中 θ 固定不变。状态变化不会重新抽门槛，只会改变激活累积速度。

**CUMULATIVE HAZARD**：
`H(t) = ∫λ(s)ds`，当 `H(t) ≥ θ` → 产生一次 Spontaneous Wake Opportunity

- 本轮 θ 较低：即使状态普通，也可能很快自然 Wake。
- 本轮 θ 较高：即使状态较活跃，也可能安静更久。

> 不建议把 θ 的分布当成日常调参旋钮。想整体变活跃/安静，优先调 λθ；想改变 burst 形态，再调 Run kick、Tone、Drift 或 λmax。

---

## 06 - BASELINE EFFECT

中性 Tone/Drift、刚完成一次 AgentRun 后的开发基线模拟结果：

| 时间窗口 | 至少发生一次 spontaneous Wake 的近似概率 |
|----------|----------------------------------------|
| 1 分钟内 | ≈ 2% |
| 5 分钟内 | ≈ 10% |
| 15 分钟内 | ≈ 28% |
| 30 分钟内 | ≈ 50% |
| 60 分钟内 | ≈ 76% |
| 90 分钟内 | ≈ 89% |
| 2 小时内 | ≈ 95% |

在非常活跃的 Tone/Drift，加上未来较强的 EB modulation 时，λ(t) 可以接近 λmax=8/h。即使达到上限，单独某一分钟内至少一次 Wake 的理论概率仍约为 `1 - exp(-8/60) ≈ 12.5%`。

---

## 07 - MODULATION & EVENTS

### 第一类：精确事件 → DirectWake

- iOS 精确事件：到达地点、明确设备事件、快捷指令事件等。
- Calendar/Reminder 时间到了就可以直接产生 WakeOpportunity。
- OpenLoop 到期：之前明确"晚点再看"的事项到了处理时间。
- MCP/ExternalEvent：外部服务发生了有意义的新事件。

> 这类事件不需要等 λ(t)；它们是明确的 WakeSource。

### 第二类：连续状态 → 调制 λ(t)

记忆系统、情绪系统、EB、未闭环张力等，不应该直接输出 `wake_now`。它们只提供有界的调制 Contribution：

```
ln(Mmod) ≡ clamp( Σ confidenceᵢ·ln(m), ln(0.60), ln(3.00) )
Mmod ≡ exp(上式)
```

| m | 含义 |
|---|------|
| 1.00 | 不影响 spontaneous Wake |
| 1.20~1.50 | 轻度/明显提高激活倾向 |
| 2.00~3.00 | 强主观或状态调制；允许形成更明显 burst |
| 0.80 | 稍微更安静 |
| 0.60 | V1 建议的下界；显著降低但不彻底关闭 |

> 多个系统不能无限相乘。使用 log-space 聚合并统一 clamp，防止"情绪 × 未闭环 × 记忆显著度"叠成十几倍。

---

## 08 - EB/STATUS/OPENLOOP

### EverBecoming

未来 EB 可以从 Affect、Need、Temporal/RelationalAppraisal、unresolved anticipation 等权威主观状态派生 SubjectiveWakeModulation。

- **可以**："当前状态让 spontaneous 激活倾向 ×1.6。"
- **不可以**：`wake_now=true`、`send_message=true`、担心超过阈值自动找用户。

### Kli Status Change

例如用户更新睡眠、吃饭、心情或设备场景：默认先更新正常 Context。某类状态是否直接 Wake，由它自己的 WakeSourceContract 决定，而不是 Wake 核心写死。

### OpenLoop/未闭环事项

- 明确到期：可直接 Wake。
- 尚未到期但存在持续张力：不机械提高 λ；如果记忆/EB 对它形成了有依据的主观意义，再通过 modulation 影响 spontaneous。

同一个"未回复/未完成/未闭环"，在不同上下文里可以完全不影响 Wake，也可以成为较强调制；意义由上游系统负责，KliWake 不自己解释。

---

## 09 - 调参指南

### 如果太吵
1. 先降 λθ：1.50 → 1.20/h。最干净地降低整体 Wake 密度。
2. 再增大 k_run：0.10 → 0.14。让刚跑完一次后短期稍微更安静。
3. 延长 τD：12 → 18min。Run 后的低 Drive 状态持续更久。
4. 若只是不喜欢极端 burst：λmax 8 → 6/h。
5. 若只有 EB 接入后太吵：把 modulation 上界 3.0 → 2.5。

### 如果太安静
1. 先升 λθ：1.50 → 1.80/h。
2. 减小 k_run：0.10 → 0.06。
3. 缩短 τD：12 → 8min。
4. 想增加"某一阵突然话多"的感觉：提高 σX 或 βX。
5. 想让"今天整体更活跃/安静"的差异更明显：提高 σT 或 βT。

### 哪些参数不要随便一起动
- 不要同时大幅提高 λθ + βX + σX + λmax。
- 不要用固定 minimum interval 来解决太吵；优先调 k_run、τD 或 λmax。
- 不要通过提高 μD/μT 来模拟"恋人更黏"；优先调 λθ 或未来 EB modulation。

---

## 10 - PROMPT & AGENCY

**User Turn**：Persona / Memory / CWC/PSE / Status/Scene / History / Current Time / User Input

**Wake Turn**：Persona 不变 / Memory 不变 / CWC/PSE 不变 / Status/Scene 不变 / History 不变 / Current Time dynamic.wakeup

**Prompt 不暴露**：λ(t)、Drive、Tone、Drift、θ、Mmod、EB 调制分数。否则模型可能反向推断："系统这么高概率叫醒我，所以我应该很想她。"

Wake 只提供最小来源信息：
```json
{ "wakeup": { "activationId": "wk_..", "source": "spontaneous" } }
```

醒来以后仍由 TA 自己选择：silent、主动聊天、读取获准 MCP、发起 ActionIntent。

---

## 11 - 不是靠一个 setTimeout 活着

**WakeSupervisor/Reconciler**：
只检查"执行器是不是丢了、generation 对不对、是否有卡死 Attempt"，发现异常就根据既有权威状态重新 arm。它不重新抽 θ，也不重新决定 TA 该不该醒。

- systemd restart：恢复旧 ActivationState/entropy，继续同一节律。
- 旧 timer：带 stateVersion/generation，状态变化后自动失效。
- 重复触发：WakeOpportunityId 幂等，同一个机会最多 dispatch 一次。
- 停机期间错过 spontaneous：不补发。自发 Wake 是机会，不是欠账。
- 精确外部事件是否补：由各 WakeSource 的 replay contract 决定。

---

## 12 - FINAL BASELINE

### WakeActivationPolicy v1.0-dev 推荐参数

| 参数 | 推荐值 | 主要作用 |
|------|--------|----------|
| D.initial / μD | 0.50 | Drive 中性中心 |
| D bounds | 0.20 ~ 0.80 | 防止短状态极端化 |
| k_run | 0.10 | 每次真实 Agent Run 后的短期负向 kick |
| τD | 12 min | Drive 回到 0.50 的半衰期 |
| T.initial / μT | 0.50 | 慢活跃底色中性中心 |
| τT | 6 h | Tone 的持续时间尺度 |
| σT | 0.10 | Tone 长周期差异幅度 |
| T bounds | 0.25 ~ 0.75 | 慢状态安全边界 |
| X.initial / μX | 0.00 | 随机漂移中心 |
| τX | 25 min | 短期随机活性的惯性时间 |
| σX | 0.18 | 短期随机波动幅度 |
| X bounds | -0.40 ~ +0.40 | 随机漂移边界 |
| λθ | 1.50 / h | 整体 spontaneous 密度 |
| βD / βT / βX | 1.8 / 1.6 / 1.2 | Drive/Tone/Drift 对 λ 的敏感度 |
| λmin / λmax | 0.15/h · 8.0/h | 极端下限与上限，只做数值护栏 |
| Mmod default | 1.00 | 无外部调制 |
| Mmod clamp | 0.60 ~ 3.00 | 未来主观/状态调制总边界 |
| θ | Exp(1) | 每 Cycle 抽一次随机门槛；同一 Cycle 内固定 |

---

**一句话总结**：基线让 TA 本身就有不规则但较活跃的内生节律；精确事件可以直接叫醒 TA；记忆、情绪、EB 和未闭环系统可以有界地改变 spontaneous λ(t)。所有来源最终只获得一次正常运行机会，而不会替 TA 决定"现在必须给你发什么"。
