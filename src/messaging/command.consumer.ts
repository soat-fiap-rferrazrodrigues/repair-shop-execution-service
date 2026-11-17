import { withCorrelation } from '../logging/json.logger';
import { Logger, OnApplicationShutdown } from '@nestjs/common';
import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  ExecutionService,
  ReserveAndEnqueueCommand,
} from '../execution/execution.service';

const COMMAND = 'execution.ReserveAndEnqueue';

/**
 * Long-polls the execution command queue (SNS filter: type prefix
 * "execution."). Deletes only after success; failures go to the DLQ.
 */
export class CommandConsumer implements OnApplicationShutdown {
  private readonly logger = new Logger(CommandConsumer.name);
  private running = false;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly service: ExecutionService,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  onApplicationShutdown(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.poll();
      } catch (err) {
        this.logger.error(`poll failed: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async poll(): Promise<void> {
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        MessageAttributeNames: ['All'],
      }),
    );
    for (const msg of Messages) await this.process(msg);
  }

  async process(msg: Message): Promise<void> {
    let cmd: ReserveAndEnqueueCommand;
    try {
      cmd = CommandConsumer.parse(msg);
    } catch (err) {
      this.logger.error(`invalid message ${msg.MessageId}: ${String(err)}`);
      return;
    }
    await withCorrelation(cmd.orderId, () => this.handle(msg, cmd));
  }

  private async handle(
    msg: Message,
    cmd: ReserveAndEnqueueCommand,
  ): Promise<void> {
    try {
      await this.service.reserveAndEnqueue(cmd);
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
    } catch (err) {
      this.logger.error(
        `handle failed correlation_id=${cmd.orderId}: ${(err as Error).message}`,
      );
    }
  }

  static parse(msg: Message): ReserveAndEnqueueCommand {
    const body = JSON.parse(msg.Body ?? '') as Record<string, unknown>;
    let data = body;
    let type: unknown = body.type ?? msg.MessageAttributes?.type?.StringValue;
    if (body.Type === 'Notification' && typeof body.Message === 'string') {
      data = JSON.parse(body.Message) as Record<string, unknown>;
      const attrs = body.MessageAttributes as
        Record<string, { Value: string }> | undefined;
      type = data.type ?? attrs?.type?.Value;
    }
    if (type !== COMMAND) throw new Error(`unknown command: ${String(type)}`);
    if (typeof data.orderId !== 'string') throw new Error('missing orderId');
    if (typeof data.paymentId !== 'string')
      throw new Error('missing paymentId');
    const parts = (data.parts ?? []) as unknown[];
    if (
      !Array.isArray(parts) ||
      !parts.every(
        (p) =>
          typeof (p as PartLike).partId === 'string' &&
          Number.isInteger((p as PartLike).quantity) &&
          (p as PartLike).quantity > 0,
      )
    )
      throw new Error('invalid parts');
    return {
      orderId: data.orderId,
      paymentId: data.paymentId,
      parts: parts as ReserveAndEnqueueCommand['parts'],
    };
  }
}

type PartLike = { partId: unknown; quantity: number };
