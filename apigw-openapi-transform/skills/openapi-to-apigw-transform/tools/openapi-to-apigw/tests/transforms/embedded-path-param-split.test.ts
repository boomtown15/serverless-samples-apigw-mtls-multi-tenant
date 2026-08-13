import { describe, it, expect } from 'vitest';
import { embeddedPathParamSplit } from '../../src/transforms/embedded-path-param-split.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('embeddedPathParamSplit', () => {
  it('strips .ext suffix from /{id}.json', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' },
      paths: {
        '/items/{id}.json': { get: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = embeddedPathParamSplit(spec, diag);
    expect(result.paths['/items/{id}']).toBeDefined();
    expect(result.paths['/items/{id}.json']).toBeUndefined();
    const warns = diag.entries.filter(e => e.feature === 'embedded-path-param-split');
    expect(warns).toHaveLength(1);
  });

  it('splits :action suffix into /{param}/{action} sub-path', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' },
      paths: {
        '/forms/{formId}:batchUpdate': { post: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = embeddedPathParamSplit(spec, diag);
    expect(result.paths['/forms/{formId}/batchUpdate']).toBeDefined();
    expect(result.paths['/forms/{formId}:batchUpdate']).toBeUndefined();
    expect(result.paths['/forms/{formId}/batchUpdate']['x-original-path']).toBe('/forms/{formId}:batchUpdate');
  });

  it('drops .ext variant and emits breaking on collision with sibling', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' },
      paths: {
        '/items/{id}.json': { get: { summary: 'json', responses: { '200': { description: 'OK' } } } },
        '/items/{id}': { get: { summary: 'plain', responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = embeddedPathParamSplit(spec, diag);
    expect(result.paths['/items/{id}'].get.summary).toBe('plain');
    expect(result.paths['/items/{id}.json']).toBeUndefined();
    const br = diag.entries.filter(e => e.level === 'breaking' && e.feature === 'embedded-path-param-collision');
    expect(br).toHaveLength(1);
  });

  it('only rewrites the affected segment in multi-segment paths', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' },
      paths: {
        '/v1/projects/{pid}/forms/{fid}:renew': { post: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = embeddedPathParamSplit(spec, diag);
    expect(result.paths['/v1/projects/{pid}/forms/{fid}/renew']).toBeDefined();
    expect(result.paths['/v1/projects/{pid}/forms/{fid}:renew']).toBeUndefined();
  });

  it('leaves plain paths alone', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' },
      paths: { '/items/{id}': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    const result = embeddedPathParamSplit(spec, diag);
    expect(result.paths['/items/{id}']).toBeDefined();
    expect(diag.entries.filter(e => e.rule === 'embedded-path-param-split')).toHaveLength(0);
  });
});
