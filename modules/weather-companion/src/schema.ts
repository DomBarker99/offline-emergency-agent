import { z } from 'zod';

const time = z.iso.datetime();
const quality = z.object({
  freshness: z.literal('current'),
  temporalCoverage: z.literal('complete'),
  geographicFit: z.literal('scenario-area'),
  validity: z.literal('passed'),
  provenance: z.literal('synthetic'),
  consistency: z.literal('scenario-consistent'),
});
const measurement = z.object({ value: z.number().finite(), unit: z.string() });
const hourly = z.object({
  id: z.string(), start: time, end: time,
  precipitation: measurement, windMean: measurement, windGust: measurement,
  temperature: measurement, pressure: measurement, humidity: measurement,
});
const window = z.object({
  hours: z.union([z.literal(1), z.literal(4), z.literal(8), z.literal(12)]),
  start: time, end: time, precipitation: measurement,
  windMean: measurement, windGustMax: measurement,
  coveredHours: z.number(), evidenceIds: z.array(z.string()),
});
const resource = z.object({
  id: z.string(), name: z.string(), status: z.string(),
  accessibility: z.array(z.string()), verifiedAt: time,
});
export const ContextSchema = z.object({
  schemaVersion: z.literal('0.1.0'), simulation: z.literal(true),
  scenarioId: z.literal('fictional-california-flood'), revision: z.number().int(),
  asOf: time, area: z.object({ id: z.string(), name: z.string(), geography: z.literal('fictional') }),
  stage: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    name: z.enum(['steady', 'prepare', 'event']), summary: z.string(),
    basis: z.enum(['scripted-normal', 'scripted-worsening', 'scripted-confirmed-flood']),
    evidenceIds: z.array(z.string()),
  }),
  quality,
  weather: z.object({
    current: hourly, history: z.array(hourly).length(12),
    pastWindows: z.array(window).length(4),
    forecast: z.object({ issuedAt: time, hourly: z.array(hourly).length(12),
      upcomingWindows: z.array(window).length(4),
      uncertainty: z.object({ basis: z.literal('scripted-demo-assumptions'),
        description: z.string(), calibrated: z.literal(false) }),
    }),
  }),
  watershed: z.object({ id: z.string(), observedAt: time, riverStage: measurement,
    discharge: measurement, soilSaturation: measurement,
    floodStage: measurement, trend: z.enum(['stable', 'rising']),
    floodStatus: z.enum(['below-flood-stage', 'flooding']), upstreamRainLastHour: measurement,
  }),
  baseline: z.object({ kind: z.literal('synthetic-reference'),
    description: z.string(), rainfallTypical12h: measurement,
    thresholdsOperationallyValidated: z.literal(false) }),
  alerts: z.array(z.object({ id: z.string(), source: z.literal('simulated-authority'),
    event: z.enum(['flood-watch', 'flood-warning']), issuedAt: time,
    expiresAt: time, areaId: z.string(), instruction: z.string() })),
  impacts: z.object({ floodingConfirmed: z.boolean(), roads: z.array(z.object({
    id: z.string(), status: z.enum(['open', 'closed']), reason: z.string(), updatedAt: time,
  })), power: z.enum(['available', 'local-outage']), communications: z.literal('available') }),
  resources: z.array(resource),
  residentContext: z.object({ synthetic: z.literal(true), id: z.string(),
    mobility: z.string(), communicationPreference: z.string(), supportContactId: z.string() }),
  branch: z.object({ id: z.enum(['assisted-departure', 'shelter-assistance']),
    departureRouteAvailable: z.boolean(), helperStatus: z.string(),
    assistanceStatus: z.literal('not-executed'), assessmentFocus: z.string() }),
  aiHandoff: z.object({ requestId: z.string(), evidenceRevision: z.number().int(),
    assessmentSuggested: z.literal(true), trigger: z.enum(['routine-context', 'prepare-context', 'event-context']),
    evidenceIds: z.array(z.string()), task: z.string(), notificationAuthorized: z.literal(false) }),
});

export type Context = z.infer<typeof ContextSchema>;
export const ControlSchema = z.object({
  action: z.enum(['play', 'pause', 'reset', 'seek', 'branch']),
  seconds: z.number().min(0).max(300).optional(),
  branch: z.enum(['assisted-departure', 'shelter-assistance']).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.action === 'seek' && v.seconds === undefined) ctx.addIssue({ code: 'custom', message: 'seek requires seconds' });
  if (v.action === 'branch' && v.branch === undefined) ctx.addIssue({ code: 'custom', message: 'branch requires branch' });
});
