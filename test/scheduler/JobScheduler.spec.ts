import { anything, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import { ObjectId } from 'mongodb';

import { ExecutionsRepository } from '../../src/repository/ExecutionsRepository';
import { JobDefinition, ParsedIntervalSchedule, toJobDefinition } from '../../src/job/Job';
import { JobExecutor } from '../../src/executor/JobExecutor';
import { JobRepository } from '../../src/repository/JobRepository';
import { JobScheduler } from '../../src/scheduler/JobScheduler';
import { MomoErrorType, momoError } from '../../src';
import { loggerForTests } from '../utils/logging';
import { sleep } from '../utils/sleep';
import { CronSchedule } from '../../src/job/MomoJob';

describe('JobScheduler', () => {
  const errorFn = jest.fn();
  const scheduleId = '123';

  let executionsRepository: ExecutionsRepository;
  let jobRepository: JobRepository;
  let jobExecutor: JobExecutor;
  let jobScheduler: JobScheduler;

  beforeEach(() => {
    executionsRepository = mock(ExecutionsRepository);
    jobRepository = mock(JobRepository);
    jobExecutor = mock(JobExecutor);
    when(jobExecutor.execute(anything())).thenResolve();
    when(jobExecutor.execute(anything(), anything())).thenResolve();
  });

  afterEach(async () => {
    await jobScheduler.stop();
  });

  function createJob<Schedule extends ParsedIntervalSchedule | CronSchedule>(
    job: JobDefinition<Schedule>
  ): JobDefinition<Schedule> {
    jobScheduler = new JobScheduler(
      job.name,
      instance(jobExecutor),
      scheduleId,
      instance(executionsRepository),
      instance(jobRepository),
      loggerForTests(errorFn)
    );
    when(jobRepository.findOne(deepEqual({ name: job.name }))).thenResolve({
      ...toJobDefinition(job),
      _id: new ObjectId(),
    });
    when(executionsRepository.countRunningExecutions(job.name)).thenResolve(0);
    return job;
  }

  function createIntervalJob(
    partialJob: Partial<JobDefinition<ParsedIntervalSchedule>> = {}
  ): JobDefinition<ParsedIntervalSchedule> {
    const job = {
      name: 'interval job',
      schedule: { interval: '1 second', parsedInterval: 1000, firstRunAfter: 1000, parsedFirstRunAfter: 1000 },
      concurrency: 1,
      maxRunning: 0,
      ...partialJob,
    };
    return createJob(job);
  }

  function createCronJob(partialJob: Partial<JobDefinition<CronSchedule>> = {}): JobDefinition<CronSchedule> {
    return createJob({
      name: 'cron job',
      schedule: { cronSchedule: '*/1 * * * * *' },
      concurrency: 1,
      maxRunning: 0,
      ...partialJob,
    });
  }

  describe('single interval job', () => {
    it('executes a job', async () => {
      createIntervalJob();
      await jobScheduler.start();

      await sleep(1100);
      verify(await jobExecutor.execute(anything(), anything())).once();
    });

    it('executes a job with the desired paramteres', async () => {
      createIntervalJob({ parameters: { foo: 'bar' } });
      await jobScheduler.start();

      await sleep(1100);
      verify(await jobExecutor.execute(anything(), deepEqual({ foo: 'bar' }))).once();
    });

    it('executes a job with firstRunAfter=0 immediately', async () => {
      createIntervalJob({
        schedule: { interval: '1 second', parsedInterval: 60_000, firstRunAfter: 0, parsedFirstRunAfter: 0 },
      });

      await jobScheduler.start();

      await sleep(100);
      verify(await jobExecutor.execute(anything(), anything())).once();
    });

    it('stops a job', async () => {
      createIntervalJob();
      await jobScheduler.start();

      await sleep(1100);
      verify(await jobExecutor.execute(anything(), anything())).once();

      await jobScheduler.stop();

      await sleep(1100);
      verify(await jobExecutor.execute(anything(), anything())).once();
    });

    it('returns job description', async () => {
      const job = createIntervalJob();

      const jobDescription = await jobScheduler.getJobDescription();
      expect(jobDescription).toEqual({
        name: job.name,
        schedule: {
          firstRunAfter: 1000,
          interval: '1 second',
        },
        concurrency: job.concurrency,
        maxRunning: job.maxRunning,
      });
    });

    it('returns job description for started job', async () => {
      const job = createIntervalJob();
      await jobScheduler.start();

      const jobDescription = await jobScheduler.getJobDescription();
      expect(jobDescription).toEqual({
        name: job.name,
        concurrency: job.concurrency,
        maxRunning: job.maxRunning,
        schedule: {
          firstRunAfter: 1000,
          interval: '1 second',
        },
        schedulerStatus: {
          schedule: {
            firstRunAfter: 1000,
            interval: '1 second',
          },
          running: 0,
        },
      });
    });
  });

  describe('single cron job', () => {
    it('executes a job', async () => {
      createCronJob();
      await jobScheduler.start();

      await sleep(1000);
      verify(await jobExecutor.execute(anything(), anything())).once();
    });

    it('executes a job with the desired parameters', async () => {
      createCronJob({ parameters: { foo: 'bar' } });
      await jobScheduler.start();

      await sleep(1000);
      verify(await jobExecutor.execute(anything(), deepEqual({ foo: 'bar' }))).once();
    });

    it('stops a job', async () => {
      createCronJob();
      await jobScheduler.start();

      await sleep(1000);
      verify(await jobExecutor.execute(anything(), anything())).once();

      await jobScheduler.stop();

      await sleep(1000);
      verify(await jobExecutor.execute(anything(), anything())).once();
    });

    it('returns job description', async () => {
      const job = createCronJob();

      const jobDescription = await jobScheduler.getJobDescription();
      expect(jobDescription).toEqual({
        name: job.name,
        concurrency: job.concurrency,
        maxRunning: job.maxRunning,
        schedule: { cronSchedule: '*/1 * * * * *' },
      });
    });

    it('returns job description for started job', async () => {
      const job = createCronJob();
      await jobScheduler.start();

      const jobDescription = await jobScheduler.getJobDescription();
      expect(jobDescription).toEqual({
        name: job.name,
        concurrency: job.concurrency,
        maxRunning: job.maxRunning,
        schedule: { cronSchedule: '*/1 * * * * *' },
        schedulerStatus: { schedule: job.schedule, running: 0 },
      });
    });
  });

  describe('error cases', () => {
    it('reports error when job was removed before scheduling', async () => {
      const job = createIntervalJob();
      when(jobRepository.findOne(deepEqual({ name: job.name }))).thenResolve(undefined);

      await jobScheduler.start();

      expect(errorFn).toHaveBeenCalledWith(
        'cannot schedule job',
        MomoErrorType.scheduleJob,
        { name: job.name },
        momoError.jobNotFound
      );
    });

    it('reports unexpected error with mongo', async () => {
      const job = createIntervalJob();
      await jobScheduler.start();

      const error = new Error('something unexpected happened');
      when(jobRepository.findOne(deepEqual({ name: job.name }))).thenThrow(error);

      await sleep(1100);

      expect(errorFn).toHaveBeenCalledWith(
        'an unexpected error occurred while executing job',
        MomoErrorType.executeJob,
        { name: job.name },
        error
      );

      expect(jobScheduler.getUnexpectedErrorCount()).toBe(1);
    });
  });

  describe('concurrent interval job', () => {
    it('executes job thrice', async () => {
      createIntervalJob({ concurrency: 3, maxRunning: 3 });
      await jobScheduler.start();

      await sleep(1100);
      verify(await jobExecutor.execute(anything(), anything())).thrice();
    });

    it('executes job when no maxRunning is set', async () => {
      const job = createIntervalJob({ maxRunning: 0, concurrency: 3 });
      await jobScheduler.start();

      await sleep(2100);
      verify(await jobExecutor.execute(anything(), anything())).times(2 * job.concurrency);
    });

    it('executes job only twice if it is already running', async () => {
      const job = createIntervalJob({ concurrency: 3, maxRunning: 3 });
      when(executionsRepository.countRunningExecutions(job.name)).thenResolve(1);

      await jobScheduler.start();

      await sleep(1100);
      verify(await jobExecutor.execute(anything(), anything())).twice();
    });
  });

  describe('concurrent cron job', () => {
    it('executes job thrice', async () => {
      createCronJob({ concurrency: 3, maxRunning: 3 });
      await jobScheduler.start();

      await sleep(1000);
      verify(await jobExecutor.execute(anything(), anything())).thrice();
    });

    it('executes job when no maxRunning is set', async () => {
      const job = createCronJob({ maxRunning: 0, concurrency: 3 });
      await jobScheduler.start();

      await sleep(2000);
      verify(await jobExecutor.execute(anything(), anything())).times(2 * job.concurrency);
    });

    it('executes job only twice if it is already running', async () => {
      const job = createCronJob({ concurrency: 3, maxRunning: 3 });
      when(executionsRepository.countRunningExecutions(job.name)).thenResolve(1);

      await jobScheduler.start();

      await sleep(1000);
      verify(await jobExecutor.execute(anything(), anything())).twice();
    });
  });
});
