import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ExecutionRepository } from './execution.repository';

const NOW = '2026-11-16T10:00:00.000Z';
const canceled = (codes: string[]) =>
  Object.assign(new Error('canceled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('ExecutionRepository', () => {
  const send = jest.fn<Promise<Record<string, unknown>>, [unknown]>();
  const repo = new ExecutionRepository({ send } as never, 'tbl');
  const lastCmd = <T>() => send.mock.calls.at(-1)![0] as T;

  beforeEach(() => send.mockReset().mockResolvedValue({}));

  describe('reserveAndEnqueue', () => {
    const exec = {
      orderId: 'o1',
      paymentId: 'p1',
      parts: [
        { partId: 'a', quantity: 1 },
        { partId: 'a', quantity: 2 },
        { partId: 'b', quantity: 1 },
      ],
    };

    it('writes execution + stock decrements in one transaction', async () => {
      await expect(repo.reserveAndEnqueue(exec, NOW)).resolves.toBe('ENQUEUED');
      const { TransactItems } = lastCmd<TransactWriteCommand>().input;
      expect(TransactItems).toHaveLength(3); // put + 2 aggregated parts
      expect(TransactItems![0].Put).toMatchObject({
        ConditionExpression: 'attribute_not_exists(pk)',
        Item: {
          pk: 'EXEC#o1',
          gsi1pk: 'QUEUE',
          gsi1sk: `${NOW}#o1`,
          status: 'QUEUED',
          history: [{ status: 'QUEUED', at: NOW }],
        },
      });
      expect(TransactItems![1].Update).toMatchObject({
        Key: { pk: 'PART#a', sk: 'STOCK' },
        ConditionExpression: 'quantity >= :q',
        ExpressionAttributeValues: { ':q': 3 },
      });
    });

    it('DUPLICATE when the execution already exists', async () => {
      send.mockRejectedValue(canceled(['ConditionalCheckFailed', 'None']));
      await expect(repo.reserveAndEnqueue(exec, NOW)).resolves.toBe(
        'DUPLICATE',
      );
    });

    it('OUT_OF_STOCK when a part condition fails', async () => {
      send.mockRejectedValue(
        canceled(['None', 'None', 'ConditionalCheckFailed']),
      );
      await expect(repo.reserveAndEnqueue(exec, NOW)).resolves.toBe(
        'OUT_OF_STOCK',
      );
    });

    it('rethrows other cancellations and errors', async () => {
      send.mockRejectedValueOnce(canceled(['TransactionConflict']));
      await expect(repo.reserveAndEnqueue(exec, NOW)).rejects.toThrow();
      send.mockRejectedValueOnce(
        Object.assign(new Error('x'), { name: 'TransactionCanceledException' }),
      );
      await expect(repo.reserveAndEnqueue(exec, NOW)).rejects.toThrow();
      send.mockRejectedValueOnce(new Error('network'));
      await expect(repo.reserveAndEnqueue(exec, NOW)).rejects.toThrow(
        'network',
      );
    });
  });

  it('get maps item or returns null', async () => {
    send.mockResolvedValueOnce({
      Item: { pk: 'EXEC#o1', orderId: 'o1', status: 'QUEUED' },
    });
    expect(await repo.get('o1')).toMatchObject({
      orderId: 'o1',
      status: 'QUEUED',
    });
    expect(lastCmd<GetCommand>().input.Key).toEqual({
      pk: 'EXEC#o1',
      sk: 'EXEC',
    });
    expect(await repo.get('o2')).toBeNull();
  });

  describe('updateStatus', () => {
    it('conditional update with history entry', async () => {
      send.mockResolvedValueOnce({
        Attributes: { orderId: 'o1', status: 'IN_DIAGNOSIS' },
      });
      const r = await repo.updateStatus(
        'o1',
        'QUEUED',
        'IN_DIAGNOSIS',
        NOW,
        'n',
      );
      expect(r?.status).toBe('IN_DIAGNOSIS');
      const input = lastCmd<UpdateCommand>().input;
      expect(input.ConditionExpression).toBe('#s = :from');
      expect(input.UpdateExpression).not.toContain('REMOVE');
      expect(input.ExpressionAttributeValues![':h']).toEqual([
        { status: 'IN_DIAGNOSIS', at: NOW, note: 'n' },
      ]);
    });

    it('FINISHED removes the item from the queue index', async () => {
      send.mockResolvedValueOnce({ Attributes: { orderId: 'o1' } });
      await repo.updateStatus('o1', 'IN_REPAIR', 'FINISHED', NOW);
      const input = lastCmd<UpdateCommand>().input;
      expect(input.UpdateExpression).toContain('REMOVE gsi1pk, gsi1sk');
      expect(input.ExpressionAttributeValues![':h']).toEqual([
        { status: 'FINISHED', at: NOW },
      ]);
    });

    it('null on concurrent change, rethrows others', async () => {
      send.mockRejectedValueOnce(
        Object.assign(new Error(), { name: 'ConditionalCheckFailedException' }),
      );
      expect(
        await repo.updateStatus('o1', 'QUEUED', 'IN_DIAGNOSIS', NOW),
      ).toBeNull();
      send.mockRejectedValueOnce(new Error('boom'));
      await expect(
        repo.updateStatus('o1', 'QUEUED', 'IN_DIAGNOSIS', NOW),
      ).rejects.toThrow('boom');
    });
  });

  it('listQueue queries the GSI ascending', async () => {
    send.mockResolvedValueOnce({ Items: [{ orderId: 'o1' }] });
    expect(await repo.listQueue()).toHaveLength(1);
    expect(lastCmd<QueryCommand>().input).toMatchObject({
      IndexName: 'gsi1',
      ScanIndexForward: true,
    });
    send.mockResolvedValueOnce({});
    expect(await repo.listQueue()).toEqual([]);
  });

  it('stock get/set', async () => {
    send.mockResolvedValueOnce({ Item: { quantity: 5 } });
    expect(await repo.getStock('a')).toBe(5);
    expect(await repo.getStock('b')).toBeNull();
    await repo.setStock('a', 7);
    expect(lastCmd<PutCommand>().input.Item).toEqual({
      pk: 'PART#a',
      sk: 'STOCK',
      quantity: 7,
    });
  });

  it('aggregate handles undefined', () => {
    expect(ExecutionRepository.aggregate()).toEqual([]);
  });
});
