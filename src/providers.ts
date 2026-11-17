import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  EventPublisher,
  LoggingEventPublisher,
  SnsEventPublisher,
} from './messaging/event-publisher';
import { CommandConsumer } from './messaging/command.consumer';
import { ExecutionRepository } from './execution/execution.repository';
import { ExecutionService } from './execution/execution.service';

export const aws = (config: ConfigService) => ({
  region: config.get<string>('AWS_REGION'),
  endpoint: config.get<string>('AWS_ENDPOINT_URL') || undefined,
});

export const repositoryProvider: Provider = {
  provide: ExecutionRepository,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new ExecutionRepository(
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          ...aws(config),
          endpoint:
            config.get<string>('DYNAMODB_ENDPOINT') || aws(config).endpoint,
        }),
      ),
      config.get<string>('DYNAMODB_TABLE') ?? 'execution',
    ),
};

export const serviceProvider: Provider = {
  provide: ExecutionService,
  inject: [ExecutionRepository, EventPublisher],
  useFactory: (repo: ExecutionRepository, events: EventPublisher) =>
    new ExecutionService(repo, events),
};

export const eventPublisherProvider: Provider = {
  provide: EventPublisher,
  inject: [ConfigService],
  useFactory: (config: ConfigService): EventPublisher => {
    const topicArn = config.get<string>('EXECUTION_SNS_TOPIC_ARN');
    return topicArn
      ? new SnsEventPublisher(new SNSClient(aws(config)), topicArn)
      : new LoggingEventPublisher();
  },
};

export const commandConsumerProvider: Provider = {
  provide: CommandConsumer,
  inject: [ConfigService, ExecutionService],
  useFactory: (config: ConfigService, service: ExecutionService) => {
    const queueUrl = config.get<string>('EXECUTION_SQS_QUEUE_URL');
    if (!queueUrl) return null;
    const consumer = new CommandConsumer(
      new SQSClient(aws(config)),
      queueUrl,
      service,
    );
    consumer.start();
    return consumer;
  },
};
