const DAYS_PER_MONTH = 365.2425 / 12;
const QUANTILE_TARGETS = [
  ["p25", 0.75],
  ["median", 0.5],
  ["p75", 0.25],
];

function rounded(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function durationValue(days) {
  return {
    days,
    months: rounded(days / DAYS_PER_MONTH, 1),
  };
}

export class KaplanMeierAccumulator {
  constructor() {
    this.buckets = new Map();
    this.n = 0;
    this.events = 0;
    this.censored = 0;
    this.censorReasons = new Map();
  }

  add(durationDays, { event, censorReason = "unspecified" }) {
    if (!Number.isInteger(durationDays) || durationDays < 0) {
      throw new Error(`durationDays must be a non-negative integer; received ${durationDays}`);
    }

    const bucket = this.buckets.get(durationDays) ?? { events: 0, censored: 0 };
    if (event) {
      bucket.events += 1;
      this.events += 1;
    } else {
      bucket.censored += 1;
      this.censored += 1;
      this.censorReasons.set(censorReason, (this.censorReasons.get(censorReason) ?? 0) + 1);
    }
    this.buckets.set(durationDays, bucket);
    this.n += 1;
  }

  finalize() {
    const quantileDays = Object.fromEntries(QUANTILE_TARGETS.map(([name]) => [name, null]));
    let atRisk = this.n;
    let survival = 1;
    let lastEventTimeDays = null;

    for (const durationDays of [...this.buckets.keys()].sort((left, right) => left - right)) {
      const bucket = this.buckets.get(durationDays);
      if (bucket.events > 0 && atRisk > 0) {
        survival *= 1 - bucket.events / atRisk;
        lastEventTimeDays = durationDays;
        for (const [name, survivalThreshold] of QUANTILE_TARGETS) {
          if (quantileDays[name] === null && survival <= survivalThreshold + Number.EPSILON) {
            quantileDays[name] = durationDays;
          }
        }
      }
      atRisk -= bucket.events + bucket.censored;
    }

    const lastObservedTimeDays = this.buckets.size > 0 ? Math.max(...this.buckets.keys()) : null;
    return {
      n: this.n,
      events: this.events,
      censored: this.censored,
      censorReasons: Object.fromEntries([...this.censorReasons.entries()].sort()),
      quantiles: Object.fromEntries(
        QUANTILE_TARGETS.map(([name]) => [
          name,
          quantileDays[name] === null ? null : durationValue(quantileDays[name]),
        ]),
      ),
      lastObservedFollowUp:
        lastObservedTimeDays === null ? null : durationValue(lastObservedTimeDays),
      lastEventTime: lastEventTimeDays === null ? null : durationValue(lastEventTimeDays),
      survivalAtLastObservedTime: this.n === 0 ? null : rounded(survival),
      quantileRule:
        "First observed day where the Kaplan-Meier survival estimate is at or below the corresponding survival threshold.",
    };
  }
}

export function calculateKaplanMeier(observations) {
  const accumulator = new KaplanMeierAccumulator();
  for (const observation of observations) accumulator.add(observation.durationDays, observation);
  return accumulator.finalize();
}
