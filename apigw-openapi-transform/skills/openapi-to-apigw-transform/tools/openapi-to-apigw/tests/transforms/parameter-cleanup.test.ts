import { describe, it, expect } from 'vitest';
import { parameterCleanup } from '../../src/transforms/parameter-cleanup.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('parameterCleanup', () => {
  it('removes unsupported parameter fields', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items': {
          get: {
            parameters: [{
              name: 'filter',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              style: 'form',
              explode: true,
              allowReserved: true,
              allowEmptyValue: true,
            }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = parameterCleanup(spec, diag);
    const param = result.paths['/items'].get.parameters[0];
    expect(param.name).toBe('filter');
    expect(param.style).toBeUndefined();
    expect(param.explode).toBeUndefined();
    expect(param.allowReserved).toBeUndefined();
    expect(param.allowEmptyValue).toBeUndefined();
  });

  it('removes cookie parameters', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            parameters: [
              { name: 'session', in: 'cookie', schema: { type: 'string' } },
              { name: 'id', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = parameterCleanup(spec, diag);
    expect(result.paths['/test'].get.parameters).toHaveLength(1);
    expect(result.paths['/test'].get.parameters[0].name).toBe('id');
    expect(diag.entries.some(e => e.feature === 'cookie-parameter')).toBe(true);
  });

  it('keeps allowed fields', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items': {
          get: {
            parameters: [{
              name: 'id',
              in: 'path',
              required: true,
              description: 'Item ID',
              schema: { type: 'string' },
            }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = parameterCleanup(spec, diag);
    const param = result.paths['/items'].get.parameters[0];
    expect(param.name).toBe('id');
    expect(param.in).toBe('path');
    expect(param.required).toBe(true);
    expect(param.description).toBe('Item ID');
  });

  it('cleans path-level parameters', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, style: 'simple', schema: { type: 'string' } }],
          get: { responses: { '200': { description: 'OK' } } },
        },
      },
    };
    const diag = createDiagnostics();
    const result = parameterCleanup(spec, diag);
    expect(result.paths['/items/{id}'].parameters[0].style).toBeUndefined();
  });

  it('preserves $ref parameters', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            parameters: [{ $ref: '#/components/parameters/PageSize' }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      components: {
        parameters: {
          PageSize: { name: 'page_size', in: 'query', schema: { type: 'integer' } },
        },
      },
    };
    const diag = createDiagnostics();
    const result = parameterCleanup(spec, diag);
    expect(result.paths['/test'].get.parameters[0].$ref).toBe('#/components/parameters/PageSize');
  });
});
