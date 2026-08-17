import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseDataset } from '../src';

const fixtures = resolve(__dirname, 'fixtures');

describe('parseDataset - CSV', async () => {
  const csv = readFileSync(resolve(fixtures, 'sample.csv'), 'utf8');

  it('should parse CSV with headers', async () => {
    const result = await parseDataset(csv, { format: 'csv' });
    expect(result.headers).toEqual(['id', 'prompt', 'type', 'answer']);
    expect(result.totalCount).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      id: 1,
      prompt: 'What is 2+2?',
      type: 'math',
      answer: 4,
    });
  });

  it('should support preview mode', async () => {
    const result = await parseDataset(csv, { format: 'csv', preview: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.totalCount).toBe(3);
  });
});

describe('parseDataset - JSONL', async () => {
  const jsonl = readFileSync(resolve(fixtures, 'sample.jsonl'), 'utf8');

  it('should parse JSONL', async () => {
    const result = await parseDataset(jsonl, { format: 'jsonl' });
    expect(result.headers).toEqual(['question', 'choices', 'answer']);
    expect(result.totalCount).toBe(3);
    expect(result.rows[0]).toMatchObject({
      answer: 1,
      choices: ['3', '4', '5', '6'],
      question: 'What is 2+2?',
    });
  });

  it('should support preview mode', async () => {
    const result = await parseDataset(jsonl, { format: 'jsonl', preview: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.totalCount).toBe(3);
  });
});

describe('parseDataset - JSON', async () => {
  const json = readFileSync(resolve(fixtures, 'sample.json'), 'utf8');

  it('should parse JSON array', async () => {
    const result = await parseDataset(json, { format: 'json' });
    expect(result.headers).toEqual(['input', 'expected', 'tags']);
    expect(result.totalCount).toBe(3);
    expect(result.rows[1]).toMatchObject({ expected: 'Paris', input: 'Capital of France?' });
  });

  it('should support preview mode', async () => {
    const result = await parseDataset(json, { format: 'json', preview: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.totalCount).toBe(3);
  });
});

describe('parseDataset - auto detection', async () => {
  it('should auto-detect CSV by filename', async () => {
    const csv = readFileSync(resolve(fixtures, 'sample.csv'), 'utf8');
    const result = await parseDataset(csv, { filename: 'sample.csv' });
    expect(result.format).toBe('csv');
    expect(result.headers).toContain('prompt');
  });

  it('should auto-detect JSONL by filename', async () => {
    const jsonl = readFileSync(resolve(fixtures, 'sample.jsonl'), 'utf8');
    const result = await parseDataset(jsonl, { filename: 'sample.jsonl' });
    expect(result.format).toBe('jsonl');
  });

  it('should auto-detect JSON by content', async () => {
    const json = readFileSync(resolve(fixtures, 'sample.json'), 'utf8');
    const result = await parseDataset(json);
    expect(result.format).toBe('json');
  });
});
