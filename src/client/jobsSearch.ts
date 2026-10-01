export interface JobFilters {
  start: string;
  end: string;
  zip: string;
}

export interface JobsSearchState {
  filters: JobFilters;
  page: number;
  pageSize: number;
}

export const DEFAULT_JOBS_PAGE_SIZE = 25;

export const parseJobsSearch = (search: string, defaults: JobFilters): JobsSearchState => {
  const params = new URLSearchParams(search);
  return {
    filters: {
      start: params.get('start') || defaults.start,
      end: params.get('end') || defaults.end,
      zip: params.get('zip')?.trim() || '',
    },
    page: positiveInteger(params.get('page'), 1),
    pageSize: positiveInteger(params.get('pageSize'), DEFAULT_JOBS_PAGE_SIZE, 50),
  };
};

export const jobsListUrl = (state: JobsSearchState, page = state.page): string => {
  const params = new URLSearchParams({
    start: state.filters.start,
    end: state.filters.end,
    page: String(page),
    pageSize: String(state.pageSize),
  });
  if (state.filters.zip) params.set('zip', state.filters.zip);
  return `/?${params.toString()}`;
};

export const jobDetailsUrl = (jobId: number, state: JobsSearchState): string =>
  `/jobs/${jobId}${jobsListUrl(state).slice(1)}`;

const positiveInteger = (value: string | null, fallback: number, maximum?: number): number => {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && (maximum === undefined || parsed <= maximum)
    ? parsed
    : fallback;
};
