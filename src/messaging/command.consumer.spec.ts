import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { CommandConsumer } from './command.consumer';

const body = (o: Record<string, unknown>) => ({ Body: JSON.stringify(o) });
const valid = {
  type: 'execution.ReserveAndEnqueue',
  orderId: 'o1',
  paymentId: 'p1',
  parts: [{ partId: 'a', quantity: 2 }],
};

describe('CommandConsumer', () => {
  const send = jest.fn<Promise<unknown>, [unknown]>();
  const service = { reserveAndEnqueue: jest.fn() };
  const consumer = new CommandConsumer(
    { send } as never,
    'q',
    service as never,
  );

  beforeEach(() => jest.resetAllMocks());

  describe('parse', () => {
    it('raw body', () => {
      expect(CommandConsumer.parse(body(valid))).toEqual({
        orderId: 'o1',
        paymentId: 'p1',
        parts: [{ partId: 'a', quantity: 2 }],
      });
    });

    it('SNS envelope with type attribute; parts default to []', () => {
      const Body = JSON.stringify({
        Type: 'Notification',
        Message: JSON.stringify({ orderId: 'o1', paymentId: 'p1' }),
        MessageAttributes: {
          type: { Value: 'execution.ReserveAndEnqueue' },
        },
      });
      expect(CommandConsumer.parse({ Body }).parts).toEqual([]);
    });

    it('type from SQS attributes', () => {
      const { type: _t, ...rest } = valid;
      void _t;
      expect(
        CommandConsumer.parse({
          ...body(rest),
          MessageAttributes: {
            type: {
              DataType: 'String',
              StringValue: 'execution.ReserveAndEnqueue',
            },
          },
        }).orderId,
      ).toBe('o1');
    });

    it.each([
      [{ ...valid, type: 'billing.CreatePayment' }],
      [{ ...valid, orderId: 1 }],
      [{ ...valid, paymentId: undefined }],
      [{ ...valid, parts: 'x' }],
      [{ ...valid, parts: [{ partId: 'a', quantity: 0 }] }],
      [{ ...valid, parts: [{ partId: 1, quantity: 1 }] }],
    ])('rejects invalid %#', (o) => {
      expect(() => CommandConsumer.parse(body(o))).toThrow();
    });

    it('rejects empty body', () => {
      expect(() => CommandConsumer.parse({})).toThrow();
    });
  });

  it('handles and deletes', async () => {
    send.mockResolvedValueOnce({
      Messages: [{ ...body(valid), ReceiptHandle: 'r' }],
    });
    await consumer.poll();
    expect(send.mock.calls[0][0]).toBeInstanceOf(ReceiveMessageCommand);
    expect(service.reserveAndEnqueue).toHaveBeenCalled();
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteMessageCommand);
  });

  it('keeps message on failure and on poison', async () => {
    service.reserveAndEnqueue.mockRejectedValueOnce(new Error('ddb'));
    await consumer.process(body(valid));
    await consumer.process({ Body: 'x' });
    expect(send).not.toHaveBeenCalled();
  });

  it('empty poll', async () => {
    send.mockResolvedValueOnce({});
    await consumer.poll();
    expect(service.reserveAndEnqueue).not.toHaveBeenCalled();
  });

  it('loop survives errors and stops on shutdown', async () => {
    jest.useFakeTimers();
    send.mockRejectedValueOnce(new Error('net')).mockImplementation(() => {
      consumer.onApplicationShutdown();
      return Promise.resolve({});
    });
    consumer.start();
    consumer.start();
    await jest.advanceTimersByTimeAsync(1000);
    jest.useRealTimers();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
