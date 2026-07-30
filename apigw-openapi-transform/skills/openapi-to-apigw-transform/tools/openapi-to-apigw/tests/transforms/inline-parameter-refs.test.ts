import { describe, it, expect } from 'vitest';
import { inlineParameterRefs } from '../../src/transforms/inline-parameter-refs.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('inlineParameterRefs', () => {
  it('inlines #/components/parameters/ refs at operation level', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items': {
          get: {
            parameters: [
              { $ref: '#/components/parameters/PageSize' },
              { name: 'filter', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      components: {
        parameters: {
          PageSize: { name: 'page_size', in: 'query', required: false, schema: { type: 'integer' } },
        },
      },
    };
    const diag = createDiagnostics();
    const result = inlineParameterRefs(spec, diag);
    const params = result.paths['/items'].get.parameters;
    expect(params).toHaveLength(2);
    expect(params[0].name).toBe('page_size');
    expect(params[0].$ref).toBeUndefined();
    expect(params[1].name).toBe('filter');
  });

  it('inlines refs at path level', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items/{id}': {
          parameters: [{ $ref: '#/components/parameters/ItemId' }],
          get: { responses: { '200': { description: 'OK' } } },
        },
      },
      components: {
        parameters: {
          ItemId: { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        },
      },
    };
    const result = inlineParameterRefs(spec, createDiagnostics());
    expect(result.paths['/items/{id}'].parameters[0].name).toBe('id');
    expect(result.paths['/items/{id}'].parameters[0].$ref).toBeUndefined();
  });

  it('resolves Swagger 2.0 style #/parameters/ refs', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            parameters: [{ $ref: '#/parameters/Limit' }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
    };
    const result = inlineParameterRefs(spec, createDiagnostics());
    expect(result.paths['/test'].get.parameters[0].name).toBe('limit');
  });

  it('warns on unresolvable $ref and preserves original', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            parameters: [{ $ref: '#/components/parameters/DoesNotExist' }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
      components: { parameters: {} },
    };
    const diag = createDiagnostics();
    const result = inlineParameterRefs(spec, diag);
    expect(result.paths['/test'].get.parameters[0].$ref).toBe('#/components/parameters/DoesNotExist');
    expect(diag.entries.some(e => e.level === 'warning')).toBe(true);
  });

  it('passes through non-$ref parameters unchanged', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            parameters: [
              { name: 'q', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const result = inlineParameterRefs(spec, createDiagnostics());
    expect(result.paths['/test'].get.parameters[0].name).toBe('q');
  });

  it('resolves URL-encoded cross-path parameter refs', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      paths: {
        '/companies/{companyId}/syncs': {
          parameters: [
            { name: 'companyId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          get: { responses: { '200': { description: 'OK' } } },
        },
        '/companies/{companyId}/syncs/config': {
          parameters: [
            { $ref: '#/paths/~1companies~1%7BcompanyId%7D~1syncs/parameters/0' },
          ],
          get: { responses: { '200': { description: 'OK' } } },
        },
      },
    };
    const diag = createDiagnostics();
    const result = inlineParameterRefs(spec, diag);
    const params = result.paths!['/companies/{companyId}/syncs/config']!.parameters;
    expect(params[0].name).toBe('companyId');
    expect(params[0].$ref).toBeUndefined();
  });

  it('handles spec with no paths gracefully', () => {
    const spec = { openapi: '3.0.0', paths: {} };
    const result = inlineParameterRefs(spec, createDiagnostics());
    expect(result.paths).toEqual({});
  });
});
