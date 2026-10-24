import { z } from 'zod';

export const HazardSchema = z.enum(['flood','fire','earthquake','outage','heat']);
export type Hazard = z.infer<typeof HazardSchema>;
export const RequestSchema = z.object({hazard:HazardSchema, seconds:z.number().finite().min(0).max(300)}).strict();
const iso = z.iso.datetime();
const MetricSchema = z.enum(['rainfall','riverLevel','windGust','temperature','humidity','pm25','fireArea','fireDistance','magnitude','shakingIntensity','customersWithoutPower','heatIndex']);
export const METRICS = {
  rainfall:{unit:'mm',aggregation:'sum'}, riverLevel:{unit:'m',aggregation:'latest'},
  windGust:{unit:'km/h',aggregation:'max'}, temperature:{unit:'degC',aggregation:'mean'},
  humidity:{unit:'%',aggregation:'mean'}, pm25:{unit:'ug/m3',aggregation:'mean'},
  fireArea:{unit:'ha',aggregation:'latest'}, fireDistance:{unit:'km',aggregation:'latest'},
  magnitude:{unit:'Mw',aggregation:'max'}, shakingIntensity:{unit:'MMI',aggregation:'max'},
  customersWithoutPower:{unit:'%',aggregation:'latest'}, heatIndex:{unit:'degC',aggregation:'max'},
} as const;
export const RecordSchema = z.object({
  id:z.string().min(1), sourceId:z.string().min(1), areaId:z.string().min(1),
  kind:z.enum(['observation','forecast']), metric:MetricSchema,
  value:z.number().finite().nullable(), unit:z.string(),
  validFrom:iso, validTo:iso, issuedAt:iso, retrievedAt:iso,
  provenance:z.enum(['simulated','live']),
  quality:z.object({validity:z.enum(['passed','unavailable']), geographicFit:z.enum(['local','regional','unknown']),
    uncertainty:z.enum(['not-calibrated','provider-supplied','unknown'])}).strict(),
}).strict().superRefine((r,ctx)=>{
  if(r.unit!==METRICS[r.metric].unit)ctx.addIssue({code:'custom',message:'Incorrect canonical unit'});
  if(Date.parse(r.validTo)<=Date.parse(r.validFrom))ctx.addIssue({code:'custom',message:'Empty or reversed interval'});
  if((r.value===null)!==(r.quality.validity==='unavailable'))ctx.addIssue({code:'custom',message:'Missing values must be unavailable'});
  if(['rainfall','riverLevel','windGust','pm25','fireArea','fireDistance','shakingIntensity','customersWithoutPower'].includes(r.metric)&&r.value!==null&&r.value<0)ctx.addIssue({code:'custom',message:'Negative value not permitted'});
  if(['humidity','customersWithoutPower'].includes(r.metric)&&r.value!==null&&(r.value<0||r.value>100))ctx.addIssue({code:'custom',message:'Percentage out of range'});
});
export type EvidenceRecord=z.infer<typeof RecordSchema>;
const SourceSchema=z.object({id:z.string(),name:z.string(),provenance:z.enum(['simulated','live']),updateIntervalSeconds:z.number().positive()}).strict();
export const BatchSchema=z.object({source:SourceSchema,records:z.array(RecordSchema)}).strict();
export interface SourceAdapter {
  source:z.infer<typeof SourceSchema>;
  read(request:{hazard:Hazard;asOf:string;areaId:string}):Promise<unknown>;
}
export const StageSchema=z.object({level:z.union([z.literal(1),z.literal(2),z.literal(3)]).nullable(),
  name:z.enum(['steady','prepare','event','unknown']),summary:z.string(),
  basis:z.enum(['scripted-fixture','external-assessment','unavailable']),evidenceIds:z.array(z.string())}).strict();
export interface Assessor { assess(input:{hazard:Hazard;asOf:string;records:EvidenceRecord[]}):Promise<z.infer<typeof StageSchema>> }
const AggregateMetricSchema=z.object({metric:MetricSchema,unit:z.string(),aggregation:z.enum(['sum','latest','max','mean']),value:z.number().finite().nullable(),coveredHours:z.number().nonnegative(),coverage:z.enum(['complete','partial','unavailable']),evidenceIds:z.array(z.string())}).strict();
const WindowSchema=z.object({hours:z.union([z.literal(1),z.literal(4),z.literal(8),z.literal(12)]),start:iso,end:iso,metrics:z.array(AggregateMetricSchema)}).strict();
export const EventContextSchema=z.object({
 schemaVersion:z.literal('2.0.0'),hazard:HazardSchema,asOf:iso,area:z.object({id:z.string()}),
 mode:z.enum(['simulation','live','mixed','unavailable']),revision:z.string(),sources:z.array(SourceSchema),stage:StageSchema,
 quality:z.object({validity:z.enum(['passed','degraded']),freshness:z.enum(['unknown','stale','current']),geographicFit:z.array(z.enum(['local','regional','unknown'])),uncertainty:z.string()}),
 failures:z.array(z.object({sourceId:z.string(),reason:z.string()})),
 latest:z.array(z.object({metric:MetricSchema,unit:z.string(),value:z.number().finite().nullable(),evidenceId:z.string().nullable(),validTo:iso.nullable()})),
 history:z.array(WindowSchema).length(4),forecast:z.object({windows:z.array(WindowSchema).length(4),uncertainty:z.string()}),records:z.array(RecordSchema),
 scene:z.object({hazard:HazardSchema,stage:z.union([z.literal(1),z.literal(2),z.literal(3)]).nullable(),available:z.boolean(),animationIsIllustrative:z.literal(true)}),
 aiHandoff:z.object({requestId:z.string(),assessmentSuggested:z.boolean(),notificationAuthorized:z.literal(false),evidenceIds:z.array(z.string()),focus:z.string(),unknowns:z.array(z.string()),instructions:z.string()})
}).strict();
