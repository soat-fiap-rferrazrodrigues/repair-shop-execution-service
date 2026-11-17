import { Controller, Get } from '@nestjs/common';
import { ExecutionRepository } from '../execution/execution.repository';
import { Public } from '../auth/jwt-auth.guard';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly repo: ExecutionRepository) {}

  @Get()
  async check() {
    try {
      await this.repo.getStock('__health__');
      return { status: 'ok', database: 'up' };
    } catch {
      return { status: 'degraded', database: 'down' };
    }
  }
}
