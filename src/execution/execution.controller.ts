import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ExecutionService } from './execution.service';
import { Roles } from '../auth/jwt-auth.guard';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

const NOTE_BODY = {
  required: false,
  schema: { type: 'object', properties: { note: { type: 'string' } } },
};

/** Workshop back-office: only staff (admin) may read or move the queue/stock. */
@ApiTags('execution')
@ApiBearerAuth()
@ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
@ApiResponse({ status: 403, description: 'Requer perfil admin' })
@Roles('admin')
@Controller()
export class ExecutionController {
  constructor(private readonly service: ExecutionService) {}

  /** Active executions in FIFO order. */
  @ApiOperation({ summary: 'Fila de execuções ativas (FIFO)' })
  @Get('executions')
  queue() {
    return this.service.listQueue();
  }

  @ApiOperation({ summary: 'Detalhe da execução de uma OS' })
  @ApiResponse({ status: 404, description: 'Execução não encontrada' })
  @Get('executions/:orderId')
  get(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.service.get(orderId);
  }

  @ApiOperation({ summary: 'QUEUED → IN_DIAGNOSIS' })
  @ApiBody(NOTE_BODY)
  @ApiResponse({ status: 409, description: 'Transição inválida' })
  @Post('executions/:orderId/diagnosis')
  @HttpCode(200)
  startDiagnosis(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: { note?: string } = {},
  ) {
    return this.service.advance(orderId, 'IN_DIAGNOSIS', body?.note);
  }

  @ApiOperation({ summary: 'IN_DIAGNOSIS → IN_REPAIR' })
  @ApiBody(NOTE_BODY)
  @Post('executions/:orderId/repair')
  @HttpCode(200)
  startRepair(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: { note?: string } = {},
  ) {
    return this.service.advance(orderId, 'IN_REPAIR', body?.note);
  }

  @ApiOperation({
    summary: 'IN_REPAIR → FINISHED',
    description: 'Publica ExecutionFinished; a OS vai para FINISHED.',
  })
  @ApiBody(NOTE_BODY)
  @Post('executions/:orderId/finish')
  @HttpCode(200)
  finish(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: { note?: string } = {},
  ) {
    return this.service.advance(orderId, 'FINISHED', body?.note);
  }

  @ApiOperation({ summary: 'Saldo de estoque de uma peça' })
  @Get('stock/:partId')
  getStock(@Param('partId') partId: string) {
    return this.service.getStock(partId);
  }

  @ApiOperation({ summary: 'Define o saldo de estoque de uma peça' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['quantity'],
      properties: { quantity: { type: 'integer', minimum: 0 } },
    },
  })
  @Put('stock/:partId')
  setStock(
    @Param('partId') partId: string,
    @Body() body: { quantity?: unknown },
  ) {
    return this.service.setStock(partId, body?.quantity);
  }
}
