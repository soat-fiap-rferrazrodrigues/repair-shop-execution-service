import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export type ExecutionStatus =
  'QUEUED' | 'IN_DIAGNOSIS' | 'IN_REPAIR' | 'FINISHED';

export interface PartLine {
  partId: string;
  quantity: number;
}

export interface Execution {
  orderId: string;
  paymentId: string;
  status: ExecutionStatus;
  parts: PartLine[];
  queuedAt: string;
  updatedAt: string;
  history: { status: ExecutionStatus; at: string; note?: string }[];
}

export type EnqueueResult = 'ENQUEUED' | 'DUPLICATE' | 'OUT_OF_STOCK';

/**
 * Single-table design:
 *   pk=EXEC#{orderId}  sk=EXEC   → execution document (+ sparse GSI1 while active)
 *   pk=PART#{partId}   sk=STOCK  → { quantity }
 * GSI1 (gsi1pk="QUEUE", gsi1sk="{queuedAt}#{orderId}") is the FIFO queue;
 * finished executions drop the GSI keys and leave the queue.
 */
export class ExecutionRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  /**
   * Atomically creates the execution and decrements stock for every part.
   * Either everything is written or nothing is (TransactWriteItems).
   */
  async reserveAndEnqueue(
    exec: Omit<Execution, 'status' | 'queuedAt' | 'updatedAt' | 'history'>,
    now: string,
  ): Promise<EnqueueResult> {
    const parts = ExecutionRepository.aggregate(exec.parts);
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: {
                  pk: `EXEC#${exec.orderId}`,
                  sk: 'EXEC',
                  gsi1pk: 'QUEUE',
                  gsi1sk: `${now}#${exec.orderId}`,
                  ...exec,
                  parts,
                  status: 'QUEUED',
                  queuedAt: now,
                  updatedAt: now,
                  history: [{ status: 'QUEUED', at: now }],
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            ...parts.map((p) => ({
              Update: {
                TableName: this.table,
                Key: { pk: `PART#${p.partId}`, sk: 'STOCK' },
                UpdateExpression: 'SET quantity = quantity - :q',
                ConditionExpression: 'quantity >= :q',
                ExpressionAttributeValues: { ':q': p.quantity },
              },
            })),
          ],
        }),
      );
      return 'ENQUEUED';
    } catch (err) {
      const e = err as {
        name?: string;
        CancellationReasons?: { Code?: string }[];
      };
      if (e.name !== 'TransactionCanceledException') throw err;
      const reasons = e.CancellationReasons ?? [];
      if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'DUPLICATE';
      if (reasons.some((r) => r.Code === 'ConditionalCheckFailed'))
        return 'OUT_OF_STOCK';
      throw err;
    }
  }

  async get(orderId: string): Promise<Execution | null> {
    const { Item } = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: `EXEC#${orderId}`, sk: 'EXEC' },
      }),
    );
    return Item ? ExecutionRepository.toExecution(Item) : null;
  }

  /** Optimistic transition: only applies if the current status is `from`. */
  async updateStatus(
    orderId: string,
    from: ExecutionStatus,
    to: ExecutionStatus,
    now: string,
    note?: string,
  ): Promise<Execution | null> {
    const entry = note
      ? { status: to, at: now, note }
      : { status: to, at: now };
    try {
      const { Attributes } = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `EXEC#${orderId}`, sk: 'EXEC' },
          UpdateExpression:
            'SET #s = :to, updatedAt = :now, history = list_append(history, :h)' +
            (to === 'FINISHED' ? ' REMOVE gsi1pk, gsi1sk' : ''),
          ConditionExpression: '#s = :from',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':to': to,
            ':from': from,
            ':now': now,
            ':h': [entry],
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return ExecutionRepository.toExecution(Attributes!);
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException')
        return null;
      throw err;
    }
  }

  async listQueue(): Promise<Execution[]> {
    const { Items = [] } = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :q',
        ExpressionAttributeValues: { ':q': 'QUEUE' },
        ScanIndexForward: true,
      }),
    );
    return Items.map((i) => ExecutionRepository.toExecution(i));
  }

  async getStock(partId: string): Promise<number | null> {
    const { Item } = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: `PART#${partId}`, sk: 'STOCK' },
      }),
    );
    return Item ? Number(Item.quantity) : null;
  }

  async setStock(partId: string, quantity: number): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `PART#${partId}`, sk: 'STOCK', quantity },
      }),
    );
  }

  /** DynamoDB rejects two operations on the same key in one transaction. */
  static aggregate(parts: PartLine[] = []): PartLine[] {
    const map = new Map<string, number>();
    for (const p of parts)
      map.set(p.partId, (map.get(p.partId) ?? 0) + p.quantity);
    return [...map].map(([partId, quantity]) => ({ partId, quantity }));
  }

  private static toExecution(item: Record<string, unknown>): Execution {
    return {
      orderId: item.orderId as string,
      paymentId: item.paymentId as string,
      status: item.status as ExecutionStatus,
      parts: item.parts as PartLine[],
      queuedAt: item.queuedAt as string,
      updatedAt: item.updatedAt as string,
      history: item.history as Execution['history'],
    };
  }
}
