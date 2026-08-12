/**
 * WakeEngine — Kli Wakeup Activation V1
 * 
 * "自发Wake是机会，不是欠账。"
 * 
 * 三个内部状态持续演化，λ(t) 给出此刻"多容易自然醒"的瞬时倾向，
 * 每个 Activation Cycle 只抽一次 Exp(1) 阈值，累积 hazard 触线即 Wake。
 * 
 * Wake 后不替 Agent 决定说什么——只给一次运行机会。
 */

// ============================================================
// Types
// ============================================================

export interface WakeActivationPolicy {
  version: string;
  params: {
    // Drive
    D_initial: number;
    mu_D: number;
    D_min: number;
    D_max: number;
    k_run: number;
    tau_D_min: number;       // half-life in minutes

    // Tone
    T_initial: number;
    mu_T: number;
    tau_T_h: number;         // half-life in hours
    sigma_T: number;
    T_min: number;
    T_max: number;

    // Drift
    X_initial: number;
    mu_X: number;
    tau_X_min: number;       // half-life in minutes
    sigma_X: number;
    X_min: number;
    X_max: number;

    // Lambda
    lambda_base_per_hour: number;
    beta_D: number;
    beta_T: number;
    beta_X: number;
    lambda_min_per_hour: number;
    lambda_max_per_hour: number;

    // Modulation
    Mmod_default: number;
    Mmod_min: number;
    Mmod_max: number;
  };
}

export interface WakeState {
  activationDrive: number;
  latentActivityTone: number;
  stochasticDriftState: number;
  lastTickTimestamp: number;   // ms since epoch
  lastRunTimestamp: number;    // ms since epoch — for run kick
  currentTheta: number;        // Exp(1) threshold for this cycle
  cumulativeHazard: number;    // H(t) accumulated since last cycle reset
  cycleSeed: number;           // entropy seed for this cycle
  stateVersion: number;        // monotonic, for stale-timer detection
}

export interface WakeTickResult {
  wakeTriggered: boolean;
  newState: WakeState;
  lambdaAtTick: number;
  driveBefore: number;
  toneBefore: number;
  driftBefore: number;
}

// ============================================================
// Helpers
// ============================================================

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** ρ = 2^(-Δ / τ) — decay factor for mean reversion & AR(1) */
function decayFactor(deltaMinutes: number, halfLifeMinutes: number): number {
  if (halfLifeMinutes <= 0) return 0;
  return Math.pow(2, -deltaMinutes / halfLifeMinutes);
}

/** Box-Muller: N(0,1) */
function gaussian(seed: number): { value: number; nextSeed: number } {
  // Simple linear congruential generator
  const a = 1664525;
  const c = 1013904223;
  const m = 2 ** 32;
  let s = (seed * a + c) % m;

  const u1 = (s / m);
  s = (s * a + c) % m;
  const u2 = (s / m);

  // Box-Muller
  const r = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10)));
  const theta = 2 * Math.PI * u2;
  return { value: r * Math.cos(theta), nextSeed: s };
}

/** Sample Exp(1) from uniform via inverse CDF */
function exp1FromUniform(seed: number): { value: number; nextSeed: number } {
  const a = 1664525;
  const c = 1013904223;
  const m = 2 ** 32;
  const s = (seed * a + c) % m;
  const u = (s / m);
  return { value: -Math.log(Math.max(u, 1e-10)), nextSeed: (s * a + c) % m };
}

// ============================================================
// WakeEngine
// ============================================================

export class WakeEngine {
  private policy: WakeActivationPolicy;
  private state: WakeState;

  constructor(policy: WakeActivationPolicy, state?: Partial<WakeState>) {
    this.policy = policy;
    const p = policy.params;
    const now = Date.now();

    const seed = state?.cycleSeed ?? Math.floor(Math.random() * 2 ** 31);
    const { value: theta, nextSeed } = exp1FromUniform(seed);

    this.state = {
      activationDrive: state?.activationDrive ?? p.D_initial,
      latentActivityTone: state?.latentActivityTone ?? p.T_initial,
      stochasticDriftState: state?.stochasticDriftState ?? p.X_initial,
      lastTickTimestamp: state?.lastTickTimestamp ?? now,
      lastRunTimestamp: state?.lastRunTimestamp ?? now,
      currentTheta: state?.currentTheta ?? theta,
      cumulativeHazard: state?.cumulativeHazard ?? 0,
      cycleSeed: nextSeed,
      stateVersion: (state?.stateVersion ?? 0) + 1,
    };
  }

  /** Read current state (for persistence / debugging) */
  getState(): Readonly<WakeState> {
    return this.state;
  }

  /** Read current policy */
  getPolicy(): Readonly<WakeActivationPolicy> {
    return this.policy;
  }

  // ----------------------------------------------------------
  // STATE EVOLUTION
  // ----------------------------------------------------------

  private evolveDrive(
    D: number,
    deltaMin: number,
    sinceLastRunMin: number,
  ): number {
    const p = this.policy.params;

    // Step 1: mean-revert toward μD (always)
    const rhoD = decayFactor(deltaMin, p.tau_D_min);
    let Dnext = p.mu_D + (D - p.mu_D) * rhoD;

    // Step 2: if a real Agent Run happened during this interval,
    //   apply the negative kick. We approximate: if sinceLastRunMin <= deltaMin,
    //   the kick happened "inside" this step.
    //   The kick is applied to the *pre-reversion* D for simplicity,
    //   then reversion proceeds from the kicked value.
    if (sinceLastRunMin <= deltaMin && sinceLastRunMin >= 0) {
      // Re-compute: kick first, then revert from kicked value
      const Dkicked = clamp(D - p.k_run, p.D_min, p.D_max);
      Dnext = p.mu_D + (Dkicked - p.mu_D) * rhoD;
    }

    return clamp(Dnext, p.D_min, p.D_max);
  }

  private evolveTone(
    T: number,
    deltaMin: number,
    seed: number,
  ): { value: number; nextSeed: number } {
    const p = this.policy.params;
    const tauMin = p.tau_T_h * 60;
    const rhoT = decayFactor(deltaMin, tauMin);
    const { value: eps, nextSeed } = gaussian(seed);

    const Tnext = p.mu_T + (T - p.mu_T) * rhoT + p.sigma_T * Math.sqrt(1 - rhoT * rhoT) * eps;
    return { value: clamp(Tnext, p.T_min, p.T_max), nextSeed };
  }

  private evolveDrift(
    X: number,
    deltaMin: number,
    seed: number,
  ): { value: number; nextSeed: number } {
    const p = this.policy.params;
    const rhoX = decayFactor(deltaMin, p.tau_X_min);
    const { value: eps, nextSeed } = gaussian(seed);

    const Xnext = X * rhoX + p.sigma_X * Math.sqrt(1 - rhoX * rhoX) * eps;
    return { value: clamp(Xnext, p.X_min, p.X_max), nextSeed };
  }

  // ----------------------------------------------------------
  // λ(t) COMPUTATION
  // ----------------------------------------------------------

  computeLambda(
    D: number,
    T: number,
    X: number,
    Mmod: number = 1.0,
  ): number {
    const p = this.policy.params;
    const exponent =
      p.beta_D * (D - p.mu_D) +
      p.beta_T * (T - p.mu_T) +
      p.beta_X * X;

    const lambda = p.lambda_base_per_hour * Math.exp(exponent) * Mmod;
    return clamp(lambda, p.lambda_min_per_hour, p.lambda_max_per_hour);
  }

  // ----------------------------------------------------------
  // MODULATION
  // ----------------------------------------------------------

  /**
   * Aggregate multiple modulation sources.
   * Each source provides (confidence, m) where m is the modulation factor.
   * Uses log-space aggregation with clamping.
   */
  static aggregateModulation(
    sources: Array<{ confidence: number; m: number }>,
    clampMin: number = 0.60,
    clampMax: number = 3.00,
  ): number {
    if (sources.length === 0) return 1.0;

    let sumLog = 0;
    let totalConfidence = 0;
    for (const { confidence, m } of sources) {
      // Clamp individual m to prevent outliers
      const mClamped = clamp(m, clampMin, clampMax);
      sumLog += confidence * Math.log(mClamped);
      totalConfidence += confidence;
    }

    if (totalConfidence === 0) return 1.0;
    const lnM = clamp(sumLog, Math.log(clampMin), Math.log(clampMax));
    return Math.exp(lnM);
  }

  // ----------------------------------------------------------
  // TICK — the main entry point
  // ----------------------------------------------------------

  /**
   * Advance state by (now - lastTickTimestamp) and check whether
   * cumulative hazard crosses θ.
   * 
   * @param now - current timestamp in ms
   * @param Mmod - external modulation factor (default 1.0)
   * @param agentDidRun - true if the Agent had a real run since last tick
   */
  tick(
    now: number,
    Mmod: number = 1.0,
    agentDidRun: boolean = false,
  ): WakeTickResult {
    const deltaMs = now - this.state.lastTickTimestamp;
    const deltaMin = deltaMs / 60_000;

    // Clamp delta to reasonable range (prevent giant jumps after restart)
    const deltaClamped = Math.min(deltaMin, 120); // max 2 hours in one tick

    const Dbefore = this.state.activationDrive;
    const Tbefore = this.state.latentActivityTone;
    const Xbefore = this.state.stochasticDriftState;

    let seed = this.state.cycleSeed;

    // Run kick timing
    const sinceLastRunMin = agentDidRun
      ? (now - this.state.lastRunTimestamp) / 60_000
      : Infinity;

    // Evolve states
    const Dnext = this.evolveDrive(Dbefore, deltaClamped, sinceLastRunMin);
    
    const { value: Tnext, nextSeed: seed1 } = this.evolveTone(Tbefore, deltaClamped, seed);
    seed = seed1;
    
    const { value: Xnext, nextSeed: seed2 } = this.evolveDrift(Xbefore, deltaClamped, seed);
    seed = seed2;

    // Compute λ(t) — use the mid-point approximation (average of before & after)
    const lambdaAvg = this.computeLambda(
      (Dbefore + Dnext) / 2,
      (Tbefore + Tnext) / 2,
      (Xbefore + Xnext) / 2,
      Mmod,
    );

    // Update cumulative hazard
    const dH = lambdaAvg * (deltaClamped / 60); // λ is per hour, delta in minutes
    let cumulativeHazard = this.state.cumulativeHazard + dH;

    let wakeTriggered = false;
    let currentTheta = this.state.currentTheta;

    // Check threshold
    if (cumulativeHazard >= currentTheta) {
      wakeTriggered = true;
      // Reset for next cycle: new θ, reset H
      const { value: newTheta, nextSeed: seed3 } = exp1FromUniform(seed);
      currentTheta = newTheta;
      cumulativeHazard = 0;
      seed = seed3;
    }

    const newState: WakeState = {
      activationDrive: Dnext,
      latentActivityTone: Tnext,
      stochasticDriftState: Xnext,
      lastTickTimestamp: now,
      lastRunTimestamp: agentDidRun ? now : this.state.lastRunTimestamp,
      currentTheta,
      cumulativeHazard,
      cycleSeed: seed,
      stateVersion: this.state.stateVersion + 1,
    };

    const driveBefore = Dbefore;
    const toneBefore = Tbefore;
    const driftBefore = Xbefore;

    this.state = newState;

    return {
      wakeTriggered,
      newState,
      lambdaAtTick: lambdaAvg,
      driveBefore,
      toneBefore,
      driftBefore,
    };
  }

  // ----------------------------------------------------------
  // SERIALISATION
  // ----------------------------------------------------------

  /** Export state for persistence */
  serialize(): string {
    return JSON.stringify(this.state);
  }

  /** Import state from persistence */
  static deserialize(json: string): Partial<WakeState> {
    return JSON.parse(json) as Partial<WakeState>;
  }

  /** Export full snapshot: policy + state */
  snapshot(): { policy: WakeActivationPolicy; state: WakeState } {
    return { policy: this.policy, state: this.state };
  }
}
