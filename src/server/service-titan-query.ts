interface ServiceTitanJobsListQuery {
  startDate: string;
  endDateExclusive: string;
  page: number;
  pageSize: number;
}

const COMPLETED_JOB_STATUS = 'Completed';

export const serviceTitanJobsListParams = (query: ServiceTitanJobsListQuery) => ({
  firstAppointmentStartsOnOrAfter: query.startDate,
  firstAppointmentStartsBefore: query.endDateExclusive,
  jobStatus: COMPLETED_JOB_STATUS,
  page: query.page,
  pageSize: query.pageSize,
  includeTotal: true,
});

export const filterJobsByLocationIds = <T extends { locationId: number }>(
  jobs: T[],
  locationIds: ReadonlySet<number>,
): T[] => jobs.filter((job) => locationIds.has(job.locationId));
