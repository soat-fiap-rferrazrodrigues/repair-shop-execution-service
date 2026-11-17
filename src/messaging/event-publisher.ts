import { Injectable, Logger } from '@nestjs/common';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';

export type ExecutionEvent =
  | { type: 'ExecutionQueued'; orderId: string }
  | { type: 'StockUnavailable'; orderId: string; paymentId: string }
  | { type: 'ExecutionFinished'; orderId: string };

export abstract class EventPublisher {
  abstract publish(event: ExecutionEvent): Promise<void>;
}

@Injectable()
export class LoggingEventPublisher extends EventPublisher {
  private readonly logger = new Logger('EventPublisher');

  publish(event: ExecutionEvent): Promise<void> {
    this.logger.log(`event=${event.type} correlation_id=${event.orderId}`);
    return Promise.resolve();
  }
}

export class SnsEventPublisher extends EventPublisher {
  constructor(
    private readonly client: SNSClient,
    private readonly topicArn: string,
  ) {
    super();
  }

  async publish(event: ExecutionEvent): Promise<void> {
    await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify(event),
        MessageAttributes: {
          type: { DataType: 'String', StringValue: event.type },
          correlation_id: { DataType: 'String', StringValue: event.orderId },
        },
      }),
    );
  }
}
