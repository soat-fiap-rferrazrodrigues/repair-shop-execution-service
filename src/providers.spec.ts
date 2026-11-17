import { ConfigService } from '@nestjs/config';
import { PublishCommand } from '@aws-sdk/client-sns';
import {
  commandConsumerProvider,
  eventPublisherProvider,
  repositoryProvider,
  serviceProvider,
} from './providers';
import {
  LoggingEventPublisher,
  SnsEventPublisher,
} from './messaging/event-publisher';
import { CommandConsumer } from './messaging/command.consumer';
import { ExecutionRepository } from './execution/execution.repository';
import { ExecutionService } from './execution/execution.service';
import { HealthController } from './health/health.controller';

type Factory = (...args: unknown[]) => unknown;
const factory = (p: unknown) => (p as { useFactory: Factory }).useFactory;
const config = (env: Record<string, string>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService;

describe('providers', () => {
  it('repository with default and custom table', () => {
    expect(factory(repositoryProvider)(config({}))).toBeInstanceOf(
      ExecutionRepository,
    );
    expect(
      factory(repositoryProvider)(
        config({ DYNAMODB_TABLE: 't', DYNAMODB_ENDPOINT: 'http://ddb:8000' }),
      ),
    ).toBeInstanceOf(ExecutionRepository);
  });

  it('service', () => {
    expect(factory(serviceProvider)({}, {})).toBeInstanceOf(ExecutionService);
  });

  it('publisher selection', async () => {
    const log = factory(eventPublisherProvider)(
      config({}),
    ) as LoggingEventPublisher;
    expect(log).toBeInstanceOf(LoggingEventPublisher);
    await log.publish({ type: 'ExecutionQueued', orderId: 'o' });
    expect(
      factory(eventPublisherProvider)(
        config({ EXECUTION_SNS_TOPIC_ARN: 'arn', AWS_REGION: 'us-east-1' }),
      ),
    ).toBeInstanceOf(SnsEventPublisher);
  });

  it('consumer only with queue url', () => {
    expect(factory(commandConsumerProvider)(config({}), {})).toBeNull();
    const start = jest
      .spyOn(CommandConsumer.prototype, 'start')
      .mockImplementation(() => undefined);
    expect(
      factory(commandConsumerProvider)(
        config({ EXECUTION_SQS_QUEUE_URL: 'q', AWS_REGION: 'us-east-1' }),
        {},
      ),
    ).toBeInstanceOf(CommandConsumer);
    expect(start).toHaveBeenCalled();
  });
});

describe('SnsEventPublisher', () => {
  it('publishes with attributes', async () => {
    const send = jest
      .fn<Promise<unknown>, [PublishCommand]>()
      .mockResolvedValue({});
    await new SnsEventPublisher({ send } as never, 'arn').publish({
      type: 'StockUnavailable',
      orderId: 'o1',
      paymentId: 'p',
    });
    const { input } = send.mock.calls[0][0];
    expect(input.MessageAttributes?.type.StringValue).toBe('StockUnavailable');
    expect(JSON.parse(input.Message!)).toMatchObject({ paymentId: 'p' });
  });
});

describe('HealthController', () => {
  it('up / down', async () => {
    const repo = {
      getStock: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error()),
    };
    const h = new HealthController(repo as never);
    await expect(h.check()).resolves.toMatchObject({ status: 'ok' });
    await expect(h.check()).resolves.toMatchObject({ status: 'degraded' });
  });
});
