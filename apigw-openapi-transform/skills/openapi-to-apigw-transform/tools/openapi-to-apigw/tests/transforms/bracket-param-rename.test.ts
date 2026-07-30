import { describe, it, expect } from 'vitest';
import { bracketParamRename } from '../../src/transforms/bracket-param-rename.js';
import { createDiagnostics } from '../../src/diagnostics.js';
import { runPipeline } from '../../src/pipeline.js';

describe('bracketParamRename', () => {
  it('renames simple bracket query params', () => {
    const spec: any = {
      openapi: '3.0.0', paths: {
        '/items': {
          get: { parameters: [{ name: 'filter[tag]', in: 'query', schema: { type: 'string' } }] },
        },
      },
    };
    const diag = createDiagnostics();
    const result = bracketParamRename(spec, diag);
    expect(result.paths['/items'].get.parameters[0].name).toBe('_tag');
  });

  it('preserves $ when present', () => {
    const spec: any = {
      openapi: '3.0.0', paths: {
        '/items': {
          get: { parameters: [{ name: 'createdAt[$gte]', in: 'query', schema: { type: 'string' } }] },
        },
      },
    };
    const diag = createDiagnostics();
    const result = bracketParamRename(spec, diag);
    expect(result.paths['/items'].get.parameters[0].name).toBe('_$gte');
  });

  it('flattens nested brackets left-to-right', () => {
    const spec: any = {
      openapi: '3.0.0', paths: {
        '/items': {
          get: { parameters: [{ name: 'a[x][y]', in: 'query', schema: { type: 'string' } }] },
        },
      },
    };
    const diag = createDiagnostics();
    const result = bracketParamRename(spec, diag);
    expect(result.paths['/items'].get.parameters[0].name).toBe('_x_y');
  });

  it('leaves non-query params unchanged', () => {
    const spec: any = {
      openapi: '3.0.0', paths: {
        '/items/{id}': {
          get: { parameters: [{ name: 'X[foo]', in: 'header', schema: { type: 'string' } }] },
        },
      },
    };
    const diag = createDiagnostics();
    const result = bracketParamRename(spec, diag);
    expect(result.paths['/items/{id}'].get.parameters[0].name).toBe('X[foo]');
  });

  it('emits a warning and a breaking entry per rename', () => {
    const spec: any = {
      openapi: '3.0.0', paths: {
        '/items': {
          get: {
            parameters: [
              { name: 'filter[tag]', in: 'query' },
              { name: 'page[number]', in: 'query' },
              { name: 'createdAt[$gte]', in: 'query' },
            ],
          },
        },
      },
    };
    const diag = createDiagnostics();
    bracketParamRename(spec, diag);
    const warnings = diag.entries.filter(e => e.level === 'warning' && e.feature === 'bracket-query-param');
    expect(warnings).toHaveLength(3);
    const breaking = diag.entries.filter(e => e.level === 'breaking' && e.feature === 'query-param-renamed');
    expect(breaking).toHaveLength(3);
  });

  it('renames path-level parameters too', () => {
    const spec: any = {
      openapi: '3.0.0', paths: {
        '/items': {
          parameters: [{ name: 'filter[tag]', in: 'query' }],
          get: {},
        },
      },
    };
    const diag = createDiagnostics();
    const result = bracketParamRename(spec, diag);
    expect(result.paths['/items'].parameters[0].name).toBe('_tag');
  });

  it('leaves parameters without brackets unchanged', () => {
    const spec: any = {
      openapi: '3.0.0', paths: {
        '/items': {
          get: { parameters: [{ name: 'normalName', in: 'query' }] },
        },
      },
    };
    const diag = createDiagnostics();
    const result = bracketParamRename(spec, diag);
    expect(result.paths['/items'].get.parameters[0].name).toBe('normalName');
    expect(diag.entries).toHaveLength(0);
  });
});

describe('bracketParamRename pipeline ordering', () => {
  it('runs BEFORE parameterCleanup (which would strip brackets)', () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/items': {
          get: {
            parameters: [{ name: 'filter[tag]', in: 'query', schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = runPipeline(spec, diag);
    // If bracketParamRename runs before parameterCleanup, the param is renamed to _tag.
    // If it runs after, parameterCleanup strips the brackets first and we get 'filtertag'.
    expect(result.paths['/items'].get.parameters[0].name).toBe('_tag');
    // Confirm both diagnostics fired (bracket rename — NOT parameterCleanup's strip).
    const bracketDiag = diag.entries.find(e => e.feature === 'bracket-query-param');
    expect(bracketDiag).toBeDefined();
    const breakingDiag = diag.entries.find(e => e.feature === 'query-param-renamed');
    expect(breakingDiag).toBeDefined();
  });
});
