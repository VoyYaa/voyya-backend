import { runMonitoredJob } from './run-monitored-job';
import { SCHEDULED_JOBS } from './scheduled-jobs';

const mockCaptureError = jest.fn();
const mockGetClient = jest.fn();
const mockWithMonitor = jest.fn();

jest.mock('./sentry', () => ({
  captureError: (error: unknown) => mockCaptureError(error),
  Sentry: {
    getClient: () => mockGetClient(),
    withMonitor: (...args: unknown[]) => mockWithMonitor(...args),
  },
}));

const job = SCHEDULED_JOBS.driverLocationPurge;

type CheckInStatus = 'ok' | 'error';

function installCheckInRecorder(): CheckInStatus[] {
  const checkIns: CheckInStatus[] = [];
  mockWithMonitor.mockImplementation(async (_slug: string, callback: () => Promise<void>) => {
    try {
      const result = await callback();
      checkIns.push('ok');
      return result;
    } catch (error) {
      checkIns.push('error');
      throw error;
    }
  });
  return checkIns;
}

describe('runMonitoredJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetClient.mockReturnValue({});
  });

  it('records an ok check-in and does not capture when the job finishes', async () => {
    const checkIns = installCheckInRecorder();

    await runMonitoredJob(job, async () => undefined);

    expect(checkIns).toEqual(['ok']);
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('records an error check-in and captures the error when the job throws', async () => {
    const checkIns = installCheckInRecorder();
    const failure = new Error('purge exploded');

    await expect(
      runMonitoredJob(job, async () => {
        throw failure;
      }),
    ).resolves.toBeUndefined();

    expect(checkIns).toEqual(['error']);
    expect(mockCaptureError).toHaveBeenCalledWith(failure);
  });

  it('declares the schedule from the single job definition', async () => {
    installCheckInRecorder();

    await runMonitoredJob(job, async () => undefined);

    expect(mockWithMonitor).toHaveBeenCalledWith(job.slug, expect.any(Function), {
      schedule: { type: 'crontab', value: job.cron },
      checkinMargin: job.checkinMarginMin,
      maxRuntime: job.maxRuntimeMin,
      timezone: 'UTC',
    });
  });

  it('captures the error without Sentry client and still resolves', async () => {
    mockGetClient.mockReturnValue(undefined);
    const failure = new Error('boom');

    await runMonitoredJob(job, async () => {
      throw failure;
    });

    expect(mockWithMonitor).not.toHaveBeenCalled();
    expect(mockCaptureError).toHaveBeenCalledWith(failure);
  });
});
