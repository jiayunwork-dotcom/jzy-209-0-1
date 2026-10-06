# 真空网络计算服务 (Vacuum Network Calculation Service)

镀膜线真空系统的稳态极限压力与抽气过程计算 HTTP 服务。系统描述为一张网络：

- **节点 (node)**：腔室（容积、随时间衰减的表面放气率）或管道连接点（零容积代数节点）；
- **边 (edge)**：圆管（内径、长度）、阀门（开/关，开态流导视为常数）或泵（抽速-入口压力折线表 + 启动压力上限）；
- **全局参数**：气体种类与温度。

气体与温度是全局参数；压力相关的管道流导使整个网络的稳态压力分布成为非线性问题。

技术栈：TypeScript（严格模式）、Node.js 20、Fastify 4、PostgreSQL 16；数值部分全部自行实现（稠密高斯消元、Newton 法、Dormand–Prince 自适应 RK）。测试框架 Vitest。

---

## 1. 物理模型

### 1.1 单位约定

| 量 | 单位 | 输入字段 |
|---|---|---|
| 压力 | mbar | `pressureMbar` / `startPressureMbar` |
| 容积 | L | `volumeL` |
| 长度 | m | `lengthM` |
| 管径 | mm | `innerDiameterMm` |
| 流导 / 抽速 | L/s | `conductanceLps` / `speedLps` |
| 气载（throughput） | mbar·L/s | 内部计算、报告字段 |
| 时间 | s | `maxTimeS` |
| 温度 | K | `temperatureK` |

### 1.2 管道流导

长直圆管，采用两种极限的标准公式，过渡区用 Knudsen **叠加式** `C = C_mol + C_visc` 光滑衔接：

**分子流**（长管传输概率）：

```
C_mol = v̄ · π · d³ / (12 L)      [m³/s]
v̄ = sqrt(8 R T / (π M))          平均热运动速率
```

对 20 °C 空气即常用经验式 `C_mol[L/s] ≈ 12.1 · d[mm]³ / L[m]`。
**参考值：d = 25 mm, L = 1 m → 1.89 L/s（本实现 1.893 L/s）。**

**粘滞（层流，Poiseuille）流**：

```
Q = π d⁴ (p1² − p2²) / (256 η L)
C_visc = Q/(p1 − p2) = π d⁴ (p1 + p2) / (256 η L)
```

粘度 η 用 Sutherland 公式随温度计算。分子流极限下流导与压力无关；粘滞流极限下流导随平均压力线性变化（高压时自动占主导）。

**流动区域**由 Knudsen 数 `Kn = λ/d`（λ 用硬球模型 `λ = kT/(√2 π d_mol² p)`）标注：`Kn > 1` 分子流，`Kn < 0.01` 粘滞流，其间过渡区。该标注用于报告（每条边的 `regime`），叠加式本身在全压力范围连续。

气体物性表覆盖 air、N₂、O₂、H₂、He、Ar、Ne、CO₂、水蒸气（摩尔质量、Sutherland 常数、分子直径）。

### 1.3 泵模型

- 抽速 `S(p)`：压力点上的分段线性插值；超出表范围按最近端值平延；单点表即恒速泵。
- 启动（前级/罗茨/分子泵切换）压力 `startPressureMbar`：仅当 `p_in ≤ startPressure` 时泵接入（`S>0`），否则抽速为 0。气载 `Q = S(p)·p`。

有效抽速满足 `1/S_eff = 1/S + 1/C`。
**参考值：10 L/s 泵经 25 mm × 1 m 管抽气，腔室处 S_eff ≈ 1.59 L/s（本实现 1.592 L/s）。**

### 1.4 放气率（可随时间衰减）

- `constant`: `q`
- `power`: `q100·(t/100s)^(−α)`（常用烘烤定律；t<1 s 按 1 s 截断，避免 t=0 发散）
- `exponential`: `q∞ + (q0−q∞)e^(−t/τ)`，稳态极限为 q∞
- `rational`: `q0/(1+t/τ)`

稳态计算使用 `t→∞` 极限值。

### 1.5 节点平衡方程

对每个节点 i，定义净流出气载：

```
F_i(P) = Σ_edges  C_ij(p̄)(P_i − P_j) + S_i(P_i)·P_i − q_ext,i = 0
```

腔室的外部输入为放气率；连接点（junction）无容积，是纯代数约束。
**参考值：100 L 腔室、无放气、恒速 10 L/s，1000 → 1 mbar 需时 V/S·ln(1000) = 69.08 s（本实现 69.077 s）。**

需求中的关系在测试中均有验证：串联流导不大于任一段；并联不减小；节点气载代数和为零；分子流区域放气率加倍极限压力加倍。

---

## 2. 数值方法（选型与精度/耗时权衡）

### 2.1 稳态：Newton–Raphson

- 解析残差与解析雅可比（管道流导对 p1、p2 的导数、泵 `Q=S(p)p` 的导数均手推，无有限差分噪声）；
- 线性子系统用**带部分选主元的稠密高斯消元**（网络规模为腔室+连接点数，通常几十以内，稠密求解简单稳健；每步 O(n³) 对该规模可忽略）；
- 残差按节点总吞吐尺度归一化（`r_i/(Σ|流量项|+|q|)`，尺度下限 1e-40），使同一容差在 1000 mbar 粘滞流和 1e-8 mbar 分子流下都有意义；**尺度中不含残差自身**，否则无放气的真零解处归一化残差会恒为 ~1；
- 压力允许取到恰好为 0（无放气时的物理极限解），线搜索只拒绝使残差增大的非负尝试；
- **回溯线搜索**（半步、保证压力非负）防止冷启动远离子解时发散；在线搜索彻底失败时，会先把停在泵闸门折点上的入口节点跳过窄平滑带、或做相对小扰动后重试数次；
- 泵开关在物理上是阶跃，直接套 Newton 会在折点处失败：数值路径在启动压力附近使用一个很窄（δ = max(1e-4·pstart, 1e-12) mbar）的**二次平滑闸门** g(p)（带内 g 从 1 平滑降到 0，带外与严格闸门完全相同）。报告的开关时刻仍用严格闸门（p = pstart）经事件定位确定，不受平滑带影响。
- 默认 `maxIterations=60`、`tolerance=1e-9`（归一化残差）。

收敛判定：**归一化残差 ≤ tolerance 或迭代次数达到上限，任一命中即停**。达到上限时返回当前压力、`converged=false`、`stopReason`（`max_iterations / line_search_failed / singular_matrix / no_pumps`）与**如实的最终残差**，不冒充收敛。

### 2.2 抽气过程：微分–代数方程（DAE）

腔室有状态量、连接点无状态量：

```
腔室:    V_i dP_i/dt = q_out,i(t) − 流出_i
连接点:  0           = q_out,i − 流出_i
```

- 时间积分采用 **Dormand–Prince 5(4) 嵌入式自适应 Runge–Kutta**（每个时间步 7 级，4、5 阶估计给出局部误差，混合相对/绝对误差控制 `scale = absTol + relTol·|p|`，默认 `relTol=1e-8, absTol=1e-12 mbar`）；
- 每个 RK 级用 **Newton 隐式求解连接点压力**（腔室压力在该级固定，雅可比降为 junction 子矩阵），以上一级的解热启动——准静态近似在抽气这种慢过程上非常准且便宜；
- 默认步长上限 5 s（`maxStepS` 可调），误差大自动缩步、连续接受自动放大；
- **事件定位**（泵跨过启动压力、到达目标压力）：先在步内扫描各 RK 级找到穿越区间，再用二分（腔室压力用三次 Hermite 插值、连接点重新 Newton 求解）把事件时刻定位到远小于一个时间步的精度，事件后重启积分器。这保证泵切换时刻与到目标时刻报告准确（参考工况误差 < 0.01 s）。泵切换后该泵在代数求解中被**临时强制到新分支**（窄平滑带在真阶跃两侧各允许一个稳定支，单纯的连续暖启动会停在旧支），当入口压力确实进入新区间、平滑闸门与强制状态完全一致时再解除，整个过程连续。

**精度/耗时权衡**：收紧 `relTol/absTol/tolerance` 会增加接受步与代数求解次数但给出更平滑的曲线和更准的事件时刻；`maxStepS` 限制大步长（在高压粘滞流阶段流导随压力剧变，限制步长有助于稳定）。输出曲线最多保留 4000 点（事件点、目标点始终保留），避免大时间跨度的结果体过大。

作业级 `maxIterations` 是所有代数 Newton 迭代的总预算；报告 `acceptedSteps / rejectedSteps / totalNonlinearSolves / failedStageSolves` 与最终连接点残差。收敛标志只在 `target_reached`（所有指定腔室到目标）或正常到达 `maxTimeS`（`time_limit`）时为真。

### 2.3 事件循环与取消

稳态 Newton 每 5 次迭代、抽气过程每个外时间步都向事件循环让出一次，取消令牌在这些检查点生效——CPU 密集计算不会把 HTTP 状态查询/取消请求饿死。排队作业直接不出队，运行中作业在最近的检查点停止并标记 `cancelled`。

---

## 3. 版本化、作业与热启动

- 每次 `POST /systems/:id/versions` 生成**不可变**新版本（版本号自增），定义做规范化 JSON 的 SHA-256 指纹；结果携带所依据的 `versionId` 与 `versionFingerprint`。
- 计算以**作业**提交：返回 `jobId`，可 `GET` 查状态/进度/结果，可 `POST .../cancel` 取消。
- **重复提交复用**：同版本、同指纹、同物理参数（阀门状态、初压、目标、放气时间等）的作业共享同一记录；排队中/运行中/已完成都命中。热启动指针与求解容差不参与去重键（它们只改变初值与精度，不改变物理解）。
- **热启动**：按**节点 id**把旧版本解的压力映射到新版本（删除的节点忽略，新增节点回退冷启动 1e-4 mbar）；抽气作业中腔室初压仍严格由 `initialPressureMbar` 决定，旧解只用于连接点初猜。热启动与冷启动的最终解差异必须在收敛容差内（测试以相对差 < 1e-7 验证）。
- **版本对比**：`POST /compare` 对同一系统的两个版本各取/复用一个作业，逐腔室比较极限压力或到目标时间的相对变化，超过给定比例阈值则标记，并列出新增/删除腔室。

### 拒收（400，返回全部问题）

容积/内径/长度非正；放气率为负；泵曲线压力点非严格单调或出现负值；网络中存在当前阀门状态下没有任何开放路径连到泵的腔室（**逐个列出 id**）；目标压力不小于初始压力；未知阀门/腔室引用；温度/气体非法。

---

## 4. HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/systems` | 建系统（v1） |
| POST | `/systems/:systemId/versions` | 追加版本 |
| GET | `/systems/:systemId/versions` | 列版本 |
| GET | `/versions` / `/versions/:id` | 列全部 / 取版本 |
| POST | `/jobs` | 提交稳态或抽气作业（202，返回 jobId、reused） |
| GET | `/jobs` / `/jobs/:id` | 列表 / 查进度与结果 |
| POST | `/jobs/:id/cancel` | 取消 |
| POST | `/compare` | 两版本结果对比 |
| GET | `/health` | 健康检查 |

### 快速上手

```bash
# 起服务（开发，无 DATABASE_URL 时使用进程内内存存储）
npm ci && npm test          # 运行测试
npm run build && npm start  # 构建并监听 :3000

# 或完整 PostgreSQL 编排
docker compose up --build
```

```bash
# 1) 建系统版本（20°C 空气，100 L 腔室，25mm×1m 管，恒速 10 L/s 泵）
curl -s localhost:3000/systems -H 'content-type: application/json' -d '{
  "gas": "air", "temperatureK": 293.15,
  "nodes": [
    {"id": "C", "kind": "chamber", "volumeL": 100},
    {"id": "J", "kind": "junction"}
  ],
  "edges": [
    {"id": "tube", "kind": "pipe", "from": "C", "to": "J", "innerDiameterMm": 25, "lengthM": 1},
    {"id": "pump", "kind": "pump", "node": "J", "startPressureMbar": 1013,
     "speedTable": [{"pressureMbar": 0, "speedLps": 10}]}
  ]
}'

# 2) 稳态极限压力（加放气率才有非零极限压力）
curl -s localhost:3000/jobs -H 'content-type: application/json' -d '{
  "kind": "steady", "versionId": "<verId>"}'

# 3) 抽气过程：1000 -> 1 mbar
curl -s localhost:3000/jobs -H 'content-type: application/json' -d '{
  "kind": "pumpdown", "versionId": "<verId>",
  "initialPressureMbar": 1000,
  "target": {"pressureMbar": 1}}'
# 然后 GET /jobs/<jobId>，result 中含 targetTimeS、pumpEvents、curve、convergence
```

稳态结果包含 `pressuresMbar`、`limitingPressureMbar`、每条边的 throughput/流导/流动区域、活动泵列表与 `convergence`；抽气结果包含 `targetTimesS`（逐腔室）、`targetTimeS`（全部到达）、`pumpEvents`（切换时刻/方向/入口压力）、`targetHits`、采样 `curve` 与完整收敛统计。

### 泵切换示例（机械泵 + 分子泵）

```json
"edges": [
  {"id": "mech",  "kind": "pump", "node": "C", "startPressureMbar": 1013,
   "speedTable": [{"pressureMbar": 0, "speedLps": 5}]},
  {"id": "turbo", "kind": "pump", "node": "C", "startPressureMbar": 1,
   "speedTable": [{"pressureMbar": 0, "speedLps": 50}]}
]
```
入口压力降到 1 mbar 时 `turbo` 自动接入，事件记录在 `pumpEvents`。

---

## 5. 目录结构

```
src/
  physics/        gas.ts          气体物性（v̄, Sutherland η, λ）
                  conductance.ts  分子/粘滞/叠加流导、串并联
                  pump.ts         抽速折线插值、启动闸门
                  outgassing.ts   放气率衰减模型
                  network.ts      网络构建、边流/雅可比组装
  numeric/        linalg.ts       稠密高斯消元
                  newton.ts       Newton 法（任意节点子集、线搜索、归一残差）
  compute/        steady.ts       稳态作业
                  pumpdown.ts     DP54 DAE 时间推进 + 事件定位
                  runner.ts       作业执行、热启动映射
  storage/        store.ts        持久化接口
                  memory.ts       内存实现（默认/测试）
                  postgres.ts     PostgreSQL 16 实现
                  migrations/     建表 SQL（启动时幂等执行）
  jobs/           scheduler.ts    FIFO 调度、去重、取消
  versioning/     compare.ts      版本对比
  validation/     validate.ts     全部拒收规则
  http/           app.ts, routes/ Fastify 装配与路由
  server.ts       入口
tests/            Vitest：参考值、物理关系、拒收、未收敛如实上报、
                  取消、去重复用、热启动一致、版本对比、HTTP E2E
```

## 6. 持久化

设置 `DATABASE_URL`（compose 已配）即用 PostgreSQL：系统/版本（定义存 JSONB，版本不可变）、作业（请求 JSONB、状态、结果 JSONB、去重键唯一约束）。启动时幂等迁移，并把上次崩溃遗留的 running/queued 作业标记 failed。未设置时回退内存存储（进程退出即失效，便于本地与测试）。
