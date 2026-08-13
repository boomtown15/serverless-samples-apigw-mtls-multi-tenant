import { describe, it, expect } from 'vitest';
import { rpcFragmentPath } from '../../src/transforms/rpc-fragment-path.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('rpcFragmentPath', () => {
  it('rewrites a single RPC fragment path to /{Op}', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'LM', version: '1' },
      paths: {
        '/#X-Amz-Target=AWSLicenseManager.ListLicenses': {
          post: { responses: { '200': { description: 'OK' } } },
        },
      },
    };
    const diag = createDiagnostics();
    const result = rpcFragmentPath(spec, diag);
    expect(result.paths['/ListLicenses']).toBeDefined();
    expect(result.paths['/#X-Amz-Target=AWSLicenseManager.ListLicenses']).toBeUndefined();
    expect(result.paths['/ListLicenses']['x-original-path']).toBe('/#X-Amz-Target=AWSLicenseManager.ListLicenses');
    const warns = diag.entries.filter(e => e.level === 'warning' && e.feature === 'rpc-fragment-path-rewritten');
    expect(warns).toHaveLength(1);
  });

  it('rewrites multiple RPC paths for the same service', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'LM', version: '1' },
      paths: {
        '/#X-Amz-Target=Svc.Foo': { post: { responses: { '200': { description: 'OK' } } } },
        '/#X-Amz-Target=Svc.Bar': { post: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = rpcFragmentPath(spec, diag);
    expect(result.paths['/Foo']).toBeDefined();
    expect(result.paths['/Bar']).toBeDefined();
    const warns = diag.entries.filter(e => e.feature === 'rpc-fragment-path-rewritten');
    expect(warns).toHaveLength(2);
  });

  it('drops RPC path and emits breaking on collision with existing /{Op}', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'LM', version: '1' },
      paths: {
        '/#X-Amz-Target=Svc.Foo': { post: { summary: 'rpc', responses: { '200': { description: 'OK' } } } },
        '/Foo': { get: { summary: 'rest', responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = rpcFragmentPath(spec, diag);
    expect(result.paths['/Foo'].get.summary).toBe('rest');
    expect(result.paths['/#X-Amz-Target=Svc.Foo']).toBeUndefined();
    const br = diag.entries.filter(e => e.level === 'breaking' && e.feature === 'rpc-fragment-path-collision');
    expect(br).toHaveLength(1);
  });

  it('continues rewriting siblings after one RPC path collides', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'LM', version: '1' },
      paths: {
        '/#X-Amz-Target=Svc.Foo': { post: { responses: { '200': { description: 'OK' } } } },
        '/#X-Amz-Target=Svc.Bar': { post: { responses: { '200': { description: 'OK' } } } },
        '/Foo': { get: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = rpcFragmentPath(spec, diag);
    // Foo collides and is dropped; Bar rewrites successfully
    expect(result.paths['/Foo']).toBeDefined();
    expect(result.paths['/#X-Amz-Target=Svc.Foo']).toBeUndefined();
    expect(result.paths['/Bar']).toBeDefined();
    expect(result.paths['/#X-Amz-Target=Svc.Bar']).toBeUndefined();
    const br = diag.entries.filter(e => e.level === 'breaking' && e.feature === 'rpc-fragment-path-collision');
    const warns = diag.entries.filter(e => e.level === 'warning' && e.feature === 'rpc-fragment-path-rewritten');
    expect(br).toHaveLength(1);
    expect(warns).toHaveLength(1);
  });

  it('leaves non-RPC paths alone', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'x', version: '1' },
      paths: { '/items/{id}': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    const result = rpcFragmentPath(spec, diag);
    expect(result.paths['/items/{id}']).toBeDefined();
    expect(diag.entries.filter(e => e.rule === 'rpc-fragment-path')).toHaveLength(0);
  });
});
