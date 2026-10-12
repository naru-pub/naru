/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { MAINTENANCE_JOBS } from "@/lib/maintenance/jobs";

describe("maintenance jobs", () => {
  // A periodic job is scheduled `*/<minutes> * * * *` (schedules.ts), which
  // pg_cron refuses past 59, and which runs unevenly unless it divides 60.
  test("every periodic interval is a pg_cron minute step", () => {
    for (const job of MAINTENANCE_JOBS)
      if (!("hour" in job))
        expect([job.name, 60 % job.minutes]).toEqual([job.name, 0]);
    for (const job of MAINTENANCE_JOBS)
      if (!("hour" in job)) expect(job.minutes).toBeLessThan(60);
  });
});
