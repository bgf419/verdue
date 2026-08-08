import rawBenchmarks from "../data/duration-benchmarks.json";

type DurationPoint = { days: number; months: number } | null;
type DurationClock = {
  label: string;
  n: number;
  events: number;
  censored: number;
  competingRiskCaveat?: string;
  quantiles: {
    p25: DurationPoint;
    median: DurationPoint;
    p75: DurationPoint;
  };
};

type DurationCohort = {
  id: string;
  label: string;
  interpretation: string;
  recordCounts: {
    included: number;
    terminated: number;
    pendingAtSnapshot: number;
  };
  clocks: {
    allTermination: DurationClock;
    recordedSettlement: DurationClock;
  };
};

type DurationBenchmarks = {
  generatedAt: string;
  scope: { statement: string };
  source: {
    provider: string;
    landingPageUrl: string;
    snapshotDate: string;
    updateCadence: string;
  };
  methodology: {
    estimator: string;
    classActionQuality: string;
    settlementQuality: string;
    defaultCohortId: string;
  };
  quality: {
    rowsRead: number;
    classActionRows: number;
    ambiguousEndpointRowsSkipped: number;
  };
  cohorts: DurationCohort[];
};

export const durationBenchmarks = rawBenchmarks as DurationBenchmarks;
export const defaultDurationCohort =
  durationBenchmarks.cohorts.find(
    (cohort) => cohort.id === durationBenchmarks.methodology.defaultCohortId,
  ) ?? durationBenchmarks.cohorts[0]!;

export function durationRange(clock: DurationClock) {
  const { p25, median, p75 } = clock.quantiles;
  return {
    p25Months: p25?.months ?? null,
    medianMonths: median?.months ?? null,
    p75Months: p75?.months ?? null,
  };
}
