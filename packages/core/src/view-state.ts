export interface ViewState {
  sourceID: string;
  projectID: string;
  directory: string;
  days: number;
  fromDate: string;
  toDate: string;
  includeChildren: boolean;
  includeArchived: boolean;
}

export const DEFAULT_VIEW_STATE: Readonly<ViewState> = Object.freeze({
  sourceID: '', projectID: '', directory: '', days: 0, fromDate: '', toDate: '', includeChildren: true, includeArchived: false,
});
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function normalizeViewState(value: unknown): ViewState {
  const result = { ...DEFAULT_VIEW_STATE };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const input = value as Record<string, unknown>;
  for (const key of ['sourceID', 'projectID', 'directory'] as const) if (typeof input[key] === 'string' && input[key].length <= 4096) result[key] = input[key];
  if ([0, 7, 30, 90].includes(input.days as number)) result.days = input.days as number;
  for (const key of ['includeChildren', 'includeArchived'] as const) if (typeof input[key] === 'boolean') result[key] = input[key];
  for (const key of ['fromDate', 'toDate'] as const) if (validDate(input[key])) result[key] = input[key];
  if (result.fromDate && result.toDate && result.fromDate > result.toDate) { result.fromDate = ''; result.toDate = ''; }
  return result;
}
