import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Execution,
  ExecutionRepository,
  ExecutionStatus,
  PartLine,
} from './execution.repository';
import { EventPublisher } from '../messaging/event-publisher';

export interface ReserveAndEnqueueCommand {
  orderId: string;
  paymentId: string;
  parts?: PartLine[];
}

const NEXT: Record<ExecutionStatus, ExecutionStatus | null> = {
  QUEUED: 'IN_DIAGNOSIS',
  IN_DIAGNOSIS: 'IN_REPAIR',
  IN_REPAIR: 'FINISHED',
  FINISHED: null,
};

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    private readonly repo: ExecutionRepository,
    private readonly events: EventPublisher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ── execution.ReserveAndEnqueue ───────────────────────────────────
  async reserveAndEnqueue(cmd: ReserveAndEnqueueCommand): Promise<void> {
    const result = await this.repo.reserveAndEnqueue(
      {
        orderId: cmd.orderId,
        paymentId: cmd.paymentId,
        parts: cmd.parts ?? [],
      },
      this.now(),
    );
    this.logger.log(`reserve orderId=${cmd.orderId} result=${result}`);

    // DUPLICATE re-publishes ExecutionQueued: the first publish may have been lost.
    await this.events.publish(
      result === 'OUT_OF_STOCK'
        ? {
            type: 'StockUnavailable',
            orderId: cmd.orderId,
            paymentId: cmd.paymentId,
          }
        : { type: 'ExecutionQueued', orderId: cmd.orderId },
    );
  }

  // ── Workshop operations ───────────────────────────────────────────
  async advance(
    orderId: string,
    to: ExecutionStatus,
    note?: string,
  ): Promise<Execution> {
    const current = await this.repo.get(orderId);
    if (!current) throw new NotFoundException('execution not found');

    // Retrying "finish" re-publishes the event (covers a failed publish).
    if (current.status === 'FINISHED' && to === 'FINISHED') {
      await this.publishFinished(orderId);
      return current;
    }
    if (NEXT[current.status] !== to) {
      throw new BadRequestException(
        `invalid transition ${current.status} → ${to}`,
      );
    }

    const updated = await this.repo.updateStatus(
      orderId,
      current.status,
      to,
      this.now(),
      note,
    );
    if (!updated) throw new ConflictException('execution changed, retry');

    if (to === 'FINISHED') await this.publishFinished(orderId);
    return updated;
  }

  async get(orderId: string): Promise<Execution> {
    const exec = await this.repo.get(orderId);
    if (!exec) throw new NotFoundException('execution not found');
    return exec;
  }

  listQueue(): Promise<Execution[]> {
    return this.repo.listQueue();
  }

  async getStock(
    partId: string,
  ): Promise<{ partId: string; quantity: number }> {
    const quantity = await this.repo.getStock(partId);
    if (quantity === null) throw new NotFoundException('part not found');
    return { partId, quantity };
  }

  async setStock(partId: string, quantity: unknown) {
    if (!Number.isInteger(quantity) || (quantity as number) < 0) {
      throw new BadRequestException('quantity must be a non-negative integer');
    }
    await this.repo.setStock(partId, quantity as number);
    return { partId, quantity: quantity as number };
  }

  private publishFinished(orderId: string) {
    return this.events.publish({ type: 'ExecutionFinished', orderId });
  }

  private now() {
    return this.clock().toISOString();
  }
}
