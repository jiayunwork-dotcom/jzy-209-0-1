import { describe, expect, it } from 'vitest';
import { runSteady } from '../src/compute/steady';
import { buildNetwork, edgeFlow } from '../src/physics/network';
import { assemble } from '../src/physics/network';
import { steadyOutgassing } from '../src/physics/outgassing';
import { seriesConductance } from '../src/physics/conductance';
import type { SystemVersion } from '../src/types';

const T = 293.15;

function version(partial: Partial<SystemVersion> & Pick<SystemVersion, 'nodes' | 'edges'>): SystemVersion {
  return {
    systemId: 'sys',
    versionId: 'ver',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    fingerprint: 'fp',
    name: 'test',
    gas: 'air',
    temperatureK: T,
    ...partial
  };
}

/** node inflow algebraic sum: max |outflow - outgassing| across nodes. */
function nodeBalanceResidual(v: SystemVersion, pressures: Record<string, number>): number {
  const net = buildNetwork(v);
  const P = net.nodes.map((n) => pressures[n.id]);
  const extIn = net.nodes.map((n) => (n.kind === 'chamber' ? steadyOutgassing(n.outgassing) : 0));
  const { F } = assemble(net, P, extIn);
  return Math.max(...F.map(Math.abs));
}

describe('reference: effective pumping speed', () => {
  it('10 L/s pump behind d=25 mm, L=1 m tube gives ~1.59 L/s at the chamber', async () => {
    const v = version({
      nodes: [
        { id: 'C', kind: 'chamber', volumeL: 100, outgassing: { type: 'constant', q: 1e-6 } },
        { id: 'J', kind: 'junction' }
      ],
      edges: [
        { id: 'pipe', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        { id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
          speedTable: [{ pressureMbar: 0, speedLps: 10 }] }
      ]
    });
    const res = await runSteady(v);
    expect(res.convergence.converged).toBe(true);
    const q = 1e-6;
    const seff = q / res.chamberPressuresMbar['C'];
    expect(seff).toBeCloseTo(1.59, 1);
    // Explicit conductance identity: S_eff = C S/(C+S).
    const pC = res.chamberPressuresMbar['C'];
    const pJ = res.pressuresMbar['J'];
    const pipeReport = res.edges.find((e) => e.edgeId === 'pipe')!;
    const qThrough = pipeReport.throughputMbarLps;
    expect(Math.abs(qThrough - q) / q).toBeLessThan(1e-6);
    expect(pC).toBeGreaterThan(pJ);
  });
});

describe('steady-state mass balance', () => {
  it('algebraic sum of flows at every node is zero', async () => {
    const v = version({
      nodes: [
        { id: 'C1', kind: 'chamber', volumeL: 50, outgassing: { type: 'constant', q: 2e-5 } },
        { id: 'C2', kind: 'chamber', volumeL: 80, outgassing: { type: 'exponential', q0: 1e-4, qInf: 1e-6, tau: 3600 } },
        { id: 'J1', kind: 'junction' },
        { id: 'J2', kind: 'junction' },
        { id: 'P', kind: 'junction' }
      ],
      edges: [
        { id: 'p1', kind: 'pipe', from: 'C1', to: 'J1', innerDiameterMm: 25, lengthM: 1 },
        { id: 'p2', kind: 'pipe', from: 'C2', to: 'J2', innerDiameterMm: 40, lengthM: 2 },
        { id: 'p3', kind: 'pipe', from: 'J1', to: 'J2', innerDiameterMm: 35, lengthM: 0.5 },
        { id: 'v1', kind: 'valve', from: 'J2', to: 'P', openConductanceLps: 200 },
        { id: 'pump', kind: 'pump', node: 'P', startPressureMbar: 1e9,
          speedTable: [
            { pressureMbar: 0, speedLps: 30 },
            { pressureMbar: 1e-3, speedLps: 25 },
            { pressureMbar: 10, speedLps: 5 }
          ] }
      ]
    });
    const res = await runSteady(v);
    expect(res.convergence.converged).toBe(true);
    const maxBal = nodeBalanceResidual(v, res.pressuresMbar);
    expect(maxBal).toBeLessThan(1e-8);
  });
});

describe('series/parallel inequalities on the network', () => {
  it('adding a second pipe in parallel lowers chamber pressure', async () => {
    const common = {
      nodes: [
        { id: 'C', kind: 'chamber' as const, volumeL: 100, outgassing: { type: 'constant' as const, q: 1e-5 } },
        { id: 'J', kind: 'junction' as const }
      ],
      pump: {
        id: 'pump', kind: 'pump' as const, node: 'J', startPressureMbar: 1e9,
        speedTable: [{ pressureMbar: 0, speedLps: 100 }]
      }
    };
    const single = version({
      nodes: common.nodes,
      edges: [
        { id: 'a', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        common.pump
      ]
    });
    const parallel = version({
      nodes: common.nodes,
      edges: [
        { id: 'a', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        { id: 'b', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        common.pump
      ]
    });
    const r1 = await runSteady(single);
    const r2 = await runSteady(parallel);
    expect(r2.chamberPressuresMbar['C']).toBeLessThan(r1.chamberPressuresMbar['C']);
  });

  it('two pipes in series conduct no more than either one alone', () => {
    const net = buildNetwork(
      version({
        nodes: [
          { id: 'A', kind: 'junction' },
          { id: 'B', kind: 'junction' },
          { id: 'D', kind: 'junction' }
        ],
        edges: []
      })
    );
    void net;
    const P = 1e-5;
    const mk = (id: string, aId: string, bId: string, cMol: number, a: number, b: number) =>
      edgeFlow(
        { id, kind: 'pipe', a, b, aId, bId, cMol, kVis: 0, diameterM: 0.025, lengthM: 1, species: 'air', temperatureK: T },
        a === 0 ? [P, 0] : [0, P]
      ).c;
    const c1 = mk('a', 'A', 'B', 1.89, 0, 1);
    const c2 = mk('b', 'B', 'D', 3.0, 0, 1);
    const cSeries = seriesConductance([c1, c2]);
    expect(cSeries).toBeLessThanOrEqual(c1);
    expect(cSeries).toBeLessThanOrEqual(c2);
  });
});

describe('doubling all outgassing doubles molecular-regime limiting pressure', () => {
  it('p(C, 2q) = 2 p(C, q)', async () => {
    const make = (q: number) =>
      version({
        nodes: [
          { id: 'C', kind: 'chamber', volumeL: 100, outgassing: { type: 'constant', q } },
          { id: 'J', kind: 'junction' }
        ],
        edges: [
          { id: 'pipe', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 25, lengthM: 1 },
          { id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e9,
            speedTable: [{ pressureMbar: 0, speedLps: 10 }] }
        ]
      });
    const r1 = await runSteady(make(2e-9));
    const r2 = await runSteady(make(4e-9));
    // molecular regime: viscous part negligible
    const edge1 = r1.edges.find((e) => e.edgeId === 'pipe')!;
    expect(edge1.regime).toBe('molecular');
    expect(r2.chamberPressuresMbar['C'] / r1.chamberPressuresMbar['C']).toBeCloseTo(2, 6);
  });
});

describe('non-convergence is reported honestly', () => {
  it('returns the last iterate with converged=false when the iteration cap is hit', async () => {
    const v = version({
      nodes: [
        { id: 'C', kind: 'chamber', volumeL: 100, outgassing: { type: 'constant', q: 1 } },
        { id: 'J', kind: 'junction' }
      ],
      edges: [
        // pump starts only below 1e-3 mbar while q=1 keeps the network above
        // that pressure through the small pipe: no self-consistent steady state
        { id: 'pipe', kind: 'pipe', from: 'C', to: 'J', innerDiameterMm: 25, lengthM: 1 },
        { id: 'pump', kind: 'pump', node: 'J', startPressureMbar: 1e-3,
          speedTable: [{ pressureMbar: 0, speedLps: 10 }] }
      ]
    });
    const res = await runSteady(v, { maxIterations: 8, tolerance: 1e-12 });
    expect(res.convergence.converged).toBe(false);
    expect(['max_iterations', 'line_search_failed', 'singular_matrix']).toContain(
      res.convergence.stopReason
    );
    expect(res.convergence.iterations).toBeLessThanOrEqual(8);
    expect(res.convergence.finalResidual).toBeGreaterThan(1e-12);
    expect(Number.isFinite(res.convergence.finalResidual)).toBe(true);
    // current pressures are still returned
    expect(res.pressuresMbar['C']).toBeGreaterThan(0);
  });
});
