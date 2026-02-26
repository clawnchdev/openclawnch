import { describe, it, expect } from 'vitest';
import {
  stringEnum,
  optionalStringEnum,
  jsonResult,
  textResult,
  errorResult,
  readStringParam,
  readNumberParam,
  ToolInputError,
} from '../extensions/crypto/src/lib/tool-helpers.js';

describe('stringEnum', () => {
  it('creates a TypeBox schema with enum values', () => {
    const schema = stringEnum(['a', 'b', 'c'] as const);
    expect(schema.type).toBe('string');
    expect(schema.enum).toEqual(['a', 'b', 'c']);
  });

  it('passes through additional options', () => {
    const schema = stringEnum(['x'] as const, { description: 'test' });
    expect((schema as any).description).toBe('test');
  });
});

describe('optionalStringEnum', () => {
  it('wraps stringEnum in Type.Optional', () => {
    const schema = optionalStringEnum(['a', 'b'] as const);
    // TypeBox Optional wraps with a modifier
    expect(schema).toBeDefined();
  });
});

describe('jsonResult', () => {
  it('serializes objects as JSON text content', () => {
    const result = jsonResult({ foo: 'bar', count: 42 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.foo).toBe('bar');
    expect(parsed.count).toBe(42);
  });

  it('passes strings through directly', () => {
    const result = jsonResult('hello');
    expect(result.content[0]!.text).toBe('hello');
  });

  it('handles bigint values by converting to string', () => {
    const result = jsonResult({ value: 1000000000000000000n });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.value).toBe('1000000000000000000');
  });

  it('handles nested objects', () => {
    const result = jsonResult({
      token: { address: '0x123', balance: 500n },
      status: 'ok',
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.token.address).toBe('0x123');
    expect(parsed.token.balance).toBe('500');
  });
});

describe('textResult', () => {
  it('wraps text in content array', () => {
    const result = textResult('Transaction sent');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toBe('Transaction sent');
  });
});

describe('errorResult', () => {
  it('prefixes message with Error:', () => {
    const result = errorResult('something broke');
    expect(result.content[0]!.text).toBe('Error: something broke');
  });

  it('sets isError flag', () => {
    const result = errorResult('fail');
    expect(result.isError).toBe(true);
  });
});

describe('readStringParam', () => {
  it('reads a direct key', () => {
    expect(readStringParam({ action: 'connect' }, 'action')).toBe('connect');
  });

  it('reads snake_case fallback', () => {
    expect(readStringParam({ token_in: '0xabc' }, 'tokenIn')).toBe('0xabc');
  });

  it('returns undefined for missing optional param', () => {
    expect(readStringParam({}, 'action')).toBeUndefined();
  });

  it('throws ToolInputError for missing required param', () => {
    expect(() => readStringParam({}, 'action', { required: true })).toThrow(ToolInputError);
    expect(() => readStringParam({}, 'action', { required: true })).toThrow('Missing required parameter: action');
  });

  it('converts non-string values to string', () => {
    expect(readStringParam({ count: 42 }, 'count')).toBe('42');
  });
});

describe('readNumberParam', () => {
  it('reads a number value', () => {
    expect(readNumberParam({ slippage: 1.5 }, 'slippage')).toBe(1.5);
  });

  it('converts string numbers', () => {
    expect(readNumberParam({ slippage: '2.5' }, 'slippage')).toBe(2.5);
  });

  it('reads snake_case fallback', () => {
    expect(readNumberParam({ vault_percentage: 50 }, 'vaultPercentage')).toBe(50);
  });

  it('returns undefined for missing optional param', () => {
    expect(readNumberParam({}, 'slippage')).toBeUndefined();
  });

  it('throws for missing required param', () => {
    expect(() => readNumberParam({}, 'slippage', { required: true })).toThrow(ToolInputError);
  });

  it('throws for non-numeric values', () => {
    expect(() => readNumberParam({ x: 'abc' }, 'x')).toThrow('must be a number');
  });
});
