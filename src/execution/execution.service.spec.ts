import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ExecutionService } from './execution.service';
import { Execution, ExecutionStatus } from './execution.repository';
import { ExecutionEvent } from '../messaging/event-publisher';

const NOW = new Date('2026-11-16T10:00:00.000Z');

describe('ExecutionService', () => {
  const repo = {
    reserveAndEnqueue: jest.fn(),
    get: jest.fn(),
    updateStatus: jest.fn(),
    listQueue: jest.fn(),
    getStock: jest.fn(),
    setStock: jest.fn(),
  };
  let events: ExecutionEvent[];
  let service: ExecutionService;

  const exec = (status: ExecutionStatus) =>
    ({ orderId: 'o1', status }) as Execution;

  beforeEach(() => {
    jest.resetAllMocks();
    events = [];
    service = new ExecutionService(
      repo as never,
      {
        publish: (e: ExecutionEvent) => {
          events.push(e);
          return Promise.resolve();
        },
      },
      () => NOW,
    );
  });

  describe('reserveAndEnqueue', () => {
    it.each([
      ['ENQUEUED', { type: 'ExecutionQueued', orderId: 'o1' }],
      ['DUPLICATE', { type: 'ExecutionQueued', orderId: 'o1' }],
      [
        'OUT_OF_STOCK',
        { type: 'StockUnavailable', orderId: 'o1', paymentId: 'p1' },
      ],
    ])('%s → publishes the matching event', async (result, event) => {
      repo.reserveAndEnqueue.mockResolvedValue(result);
      await service.reserveAndEnqueue({ orderId: 'o1', paymentId: 'p1' });
      expect(repo.reserveAndEnqueue).toHaveBeenCalledWith(
        { orderId: 'o1', paymentId: 'p1', parts: [] },
        NOW.toISOString(),
      );
      expect(events).toEqual([event]);
    });
  });

  describe('advance', () => {
    it.each([
      ['QUEUED', 'IN_DIAGNOSIS'],
      ['IN_DIAGNOSIS', 'IN_REPAIR'],
    ] as const)('%s → %s without events', async (from, to) => {
      repo.get.mockResolvedValue(exec(from));
      repo.updateStatus.mockResolvedValue(exec(to));
      await expect(service.advance('o1', to, 'n')).resolves.toMatchObject({
        status: to,
      });
      expect(repo.updateStatus).toHaveBeenCalledWith(
        'o1',
        from,
        to,
        NOW.toISOString(),
        'n',
      );
      expect(events).toEqual([]);
    });

    it('IN_REPAIR → FINISHED publishes ExecutionFinished', async () => {
      repo.get.mockResolvedValue(exec('IN_REPAIR'));
      repo.updateStatus.mockResolvedValue(exec('FINISHED'));
      await service.advance('o1', 'FINISHED');
      expect(events).toEqual([{ type: 'ExecutionFinished', orderId: 'o1' }]);
    });

    it('re-finishing re-publishes without writing', async () => {
      repo.get.mockResolvedValue(exec('FINISHED'));
      await service.advance('o1', 'FINISHED');
      expect(repo.updateStatus).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
    });

    it('rejects skipped steps', async () => {
      repo.get.mockResolvedValue(exec('QUEUED'));
      await expect(service.advance('o1', 'FINISHED')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404 for unknown execution', async () => {
      repo.get.mockResolvedValue(null);
      await expect(
        service.advance('o1', 'IN_DIAGNOSIS'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409 on concurrent update', async () => {
      repo.get.mockResolvedValue(exec('QUEUED'));
      repo.updateStatus.mockResolvedValue(null);
      await expect(
        service.advance('o1', 'IN_DIAGNOSIS'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('get / listQueue', async () => {
    repo.get.mockResolvedValueOnce(exec('QUEUED')).mockResolvedValueOnce(null);
    await expect(service.get('o1')).resolves.toMatchObject({ orderId: 'o1' });
    await expect(service.get('o1')).rejects.toBeInstanceOf(NotFoundException);
    repo.listQueue.mockResolvedValue([]);
    await expect(service.listQueue()).resolves.toEqual([]);
  });

  it('stock operations validate input', async () => {
    repo.getStock.mockResolvedValueOnce(3).mockResolvedValueOnce(null);
    await expect(service.getStock('a')).resolves.toEqual({
      partId: 'a',
      quantity: 3,
    });
    await expect(service.getStock('b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.setStock('a', 4)).resolves.toEqual({
      partId: 'a',
      quantity: 4,
    });
    for (const bad of [-1, 1.5, '3', undefined]) {
      await expect(service.setStock('a', bad)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('default clock uses current time', async () => {
    const s = new ExecutionService(repo as never, {
      publish: () => Promise.resolve(),
    });
    repo.reserveAndEnqueue.mockResolvedValue('ENQUEUED');
    await s.reserveAndEnqueue({ orderId: 'o1', paymentId: 'p', parts: [] });
    const at = (repo.reserveAndEnqueue.mock.calls as unknown[][])[0][1];
    expect(Date.parse(at as string)).not.toBeNaN();
  });
});
