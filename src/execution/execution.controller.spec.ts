import { ExecutionController } from './execution.controller';

describe('ExecutionController', () => {
  const service = {
    listQueue: jest.fn(),
    get: jest.fn(),
    advance: jest.fn(),
    getStock: jest.fn(),
    setStock: jest.fn(),
  };
  const c = new ExecutionController(service as never);

  beforeEach(() => jest.resetAllMocks());

  it('delegates queries', async () => {
    await c.queue();
    await c.get('o1');
    await c.getStock('a');
    expect(service.listQueue).toHaveBeenCalled();
    expect(service.get).toHaveBeenCalledWith('o1');
    expect(service.getStock).toHaveBeenCalledWith('a');
  });

  it('maps actions to target statuses', async () => {
    await c.startDiagnosis('o1', { note: 'n' });
    await c.startRepair('o1');
    await c.finish('o1', undefined);
    expect(service.advance.mock.calls).toEqual([
      ['o1', 'IN_DIAGNOSIS', 'n'],
      ['o1', 'IN_REPAIR', undefined],
      ['o1', 'FINISHED', undefined],
    ]);
  });

  it('setStock passes body quantity', async () => {
    await c.setStock('a', { quantity: 3 });
    await c.setStock('a', undefined as never);
    expect(service.setStock.mock.calls).toEqual([
      ['a', 3],
      ['a', undefined],
    ]);
  });
});
