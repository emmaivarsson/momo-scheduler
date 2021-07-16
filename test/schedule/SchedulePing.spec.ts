import { deepEqual, verify } from 'ts-mockito';

import { SchedulePing } from '../../src/schedule/SchedulePing';
import { ExecutionsRepository } from '../../src/repository/ExecutionsRepository';
import { sleep } from '../utils/sleep';
import { mockRepositories } from '../utils/mockRepositories';

describe('SchedulePing', () => {
  const scheduleId = '123';
  const schedulePing = new SchedulePing(scheduleId, { debug: jest.fn(), error: jest.fn() });
  let executionsRepository: ExecutionsRepository;

  beforeAll(() => {
    SchedulePing.interval = 1000;
    executionsRepository = mockRepositories().executionsRepository;
  });

  it('starts, pings, cleans and stops', async () => {
    schedulePing.start();
    await sleep(SchedulePing.interval);

    verify(executionsRepository.ping(scheduleId)).once();
    verify(executionsRepository.clean()).once();

    await schedulePing.stop();
    await sleep(SchedulePing.interval);

    verify(executionsRepository.ping(scheduleId)).once();
    verify(executionsRepository.delete(deepEqual({ scheduleId: scheduleId }))).once();
  });
});