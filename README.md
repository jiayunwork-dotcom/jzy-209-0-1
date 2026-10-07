# Vacuum Network Calculation Service

HTTP service for steady-state ultimate-pressure and transient pump-down calculations on a vacuum coating line network.

- Runtime: Node.js 20, TypeScript, Fastify
- Storage: PostgreSQL 16 (an in-memory repository is also provided for unit tests)
- Numerical code is implemented in this repository; no solver library is used

## Physical model

A system is a graph:

- Nodes are either:
  - `chamber`: volume in L and optional surface outgassing in mbar·L/s; or
  - `junction`: a massless connection point.
- Edges are:
  - `pipe`: inner diameter and length in cm;
  - `valve`: ideal zero-resistance connection when open, removed from the network when closed;
  - `pump`: tabulated speed curve S(p), linear interpolation between points and clamping at the ends.
- Gas species and temperature are global.

### Conductance

For a long circular tube,

- molecular flow: `C_m = 1.89 L/s * (d/2.5 cm)^3 * (100 cm/L) * sqrt((T/293.15 K)*(M_air/M_gas))`;
- viscous flow: `C_v = k_v * p_mean`, using the Poiseuille coefficient and gas viscosity from a Sutherland correlation;
- transition regime: the molecular and viscous contributions are added, `C = C_m + C_v`.

The additive model is continuous, has the correct molecular and viscous limits, and is differentiable for Newton's method. End-aperture corrections are not included.

### Pumps

Pump removal throughput is `Q = S(p)p`. A pump may carry a startup pressure limit; above that pressure it is idle. Once the inlet pressure reaches the limit it latches on.

### Steady state

Open valves merge nodes into super-nodes. At every super-node the inflow/outflow algebraic sum is zero. The resulting nonlinear system is solved with damped Newton iteration using analytic Jacobians.

- Stop condition: residual threshold or maximum iteration count.
- If the iteration limit is reached, the current pressures and final residual are returned with `converged: false`.
- Pump interlocks are handled as an outer fixed-point loop: the nonlinear system is solved for the active pump set, newly permitted pumps are latched, and the solve is repeated.

The reported `finalResidual` is a relative per-node throughput residual. `rawResidual` is the maximum absolute residual in mbar·L/s.

### Transient pump-down

Chamber super-nodes use `V dp/dt = outgassing - net outflow`; massless junctions use algebraic balance. All equations are solved together.

- Time integration: implicit midpoint rule, second order and A-stable.
- Each step is solved by damped Newton iteration with analytic Jacobians.
- Step control: the log-pressure change per accepted step is limited (default 2%). Steps are rejected and halved/shrunk when Newton fails or the change is too large; steps grow cautiously after accepted easy steps.
- Pump startup and target-pressure events are located by bisection, so reported switch and arrival times are sharper than one time step.
- Target arrival is interpolated from the bracketing states; pump switch events record the bracketed inlet pressure.

Tighter residual tolerance and a smaller log-change cap improve accuracy but increase Newton work and the number of accepted steps. Larger steps make high-pressure rough pumping faster but can smooth short events; bisection bounds target/event timing error.

## Versions, jobs and reuse

- Every submitted system is stored as an immutable version with an incrementing version number and optional parent version.
- Calculations are jobs (`steady` or `transient`), returning a job id immediately.
- Jobs can be polled and cancelled.
- Results contain the version id of their source system.
- Repeating the same version, calculation kind and physical parameters returns an existing succeeded/queued/running job rather than recalculating.
- Hot start is supported for steady calculations: a previous job's result supplies initial pressures. Nodes are matched by stable node id. Added nodes use the cold-start nominal pressure; removed nodes are ignored. Hot start changes iteration count, not the converged answer; tests verify agreement with cold start within tolerance.

Rejected input includes:

- non-positive volume, pipe diameter or length;
- negative outgassing or pump curve values;
- non-strictly-monotonic pump pressure points;
- chambers with no path, under the requested valve state, to any pump (the chamber ids are reported);
- transient target pressure not below the initial pressure.

## HTTP API

### Versions

```http
POST /versions
GET  /versions
GET  /versions/:id
```

Create body:

```json
{
  "parentVersionId": null,
  "system": {
    "gas": "air",
    "temperature": 293.15,
    "nodes": [
      {
        "id": "chamber-a",
        "kind": "chamber",
        "volume": 100,
        "outgassing": { "kind": "constant", "rate": 0.001 }
      },
      { "id": "pump-inlet", "kind": "junction" }
    ],
    "edges": [
      { "id": "main-pipe", "kind": "pipe", "a": "chamber-a", "b": "pump-inlet", "diameter": 2.5, "length": 100 },
      { "id": "gate", "kind": "valve", "a": "chamber-a", "b": "pump-inlet", "defaultOpen": true },
      {
        "id": "backing-pump",
        "kind": "pump",
        "from": "pump-inlet",
        "startPressure": 1013.25,
        "curve": [
          { "pressure": 0, "speed": 10 },
          { "pressure": 1200, "speed": 10 }
        ]
      }
    ]
  }
}
```

Outgassing may be:

- `{ "kind": "constant", "rate": 1e-4 }`
- `{ "kind": "exponential", "rate0": 1e-3, "tau": 3600 }`
- `{ "kind": "power", "rate0": 1e-3, "alpha": 1, "t0": 3600 }`

### Jobs

```http
POST /jobs
GET  /jobs?versionId=...
GET  /jobs/:id
POST /jobs/:id/cancel
```

Steady request example:

```json
{
  "versionId": "<uuid>",
  "kind": "steady",
  "params": {
    "initialPressure": 1013.25,
    "maxIterations": 100,
    "residualTolerance": 1e-8,
    "valveStates": { "gate": false }
  },
  "hotStartFromJobId": null
}
```

Transient request example:

```json
{
  "versionId": "<uuid>",
  "kind": "transient",
  "params": {
    "initialPressure": 1000,
    "targetPressure": 1,
    "maxTime": 10000,
    "initialStep": 0.01,
    "maxStep": 10,
    "minStep": 1e-9,
    "maxIterations": 50,
    "residualTolerance": 1e-8
  }
}
```

The transient result includes the sampled pressure curve, target arrivals, pump switch events, final residual and convergence/finish flags.

### Version comparison

```http
POST /compare
```

```json
{
  "fromVersionId": "<uuid>",
  "toVersionId": "<uuid>",
  "kind": "steady",
  "threshold": 0.1,
  "hotStart": true,
  "params": { "initialPressure": 1000, "residualTolerance": 1e-8 }
}
```

Steady comparisons report relative ultimate-pressure changes; transient comparisons report relative pump-down-time changes. Added and removed chamber ids are listed separately.

## Reference checks

The tests include the requested reference values:

- 20 °C air, 2.5 cm diameter, 100 cm long tube: molecular conductance ≈ 1.89 L/s.
- 10 L/s pump through that tube: effective speed ≈ 1.59 L/s.
- 100 L chamber, no outgassing, constant 10 L/s pump, 1000 mbar → 1 mbar: ≈ 69.1 s.
- Series conductance cannot exceed either segment; adding a parallel pipe cannot reduce network conductance.
- Steady node mass balances are zero at convergence.
- Doubling molecular-regime outgassing doubles ultimate pressure.
- Non-convergence, cancellation, comparisons, hot/cold-start agreement and repeated-job reuse are all tested.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run without PostgreSQL for local experiments:

```bash
STORAGE=memory npm run dev
```

## Docker Compose

```bash
docker compose up --build
```

This starts:

- `postgres:16-alpine` on port 5432;
- the Node 20 bookworm-slim API image on port 3000.

The API container applies SQL migrations before starting.

## Project layout

```text
src/
  physics/      gas properties, conductance, pumps, outgassing, validation
  solver/       network preparation, linear algebra, steady Newton, transient integrator
  service/      calculation facade, version comparison, scheduler
  db/           PostgreSQL and in-memory repositories, migrations
  http/         Fastify routes
test/           Vitest suites
```
