import { describe, it, expect } from 'vitest';
import { serverBasepath } from '../../src/transforms/server-basepath.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('serverBasepath', () => {
  it('prepends base path from server URL to all paths', () => {
    const spec = {
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com/v2' }],
      paths: {
        '/users': { get: { responses: { '200': { description: 'OK' } } } },
        '/items': { get: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    const result = serverBasepath(spec, diag);
    expect(result.paths['/v2/users']).toBeDefined();
    expect(result.paths['/v2/items']).toBeDefined();
    expect(result.paths['/users']).toBeUndefined();
  });

  it('handles deep base paths with multiple segments', () => {
    const spec = {
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com/api/v4.0/inventory' }],
      paths: { '/items': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    const result = serverBasepath(spec, diag);
    expect(result.paths['/api/v4.0/inventory/items']).toBeDefined();
  });

  it('skips when base path is /', () => {
    const spec = {
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com/' }],
      paths: { '/test': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    const result = serverBasepath(spec, diag);
    expect(result.paths['/test']).toBeDefined();
  });

  it('skips when base path contains template variables', () => {
    const spec = {
      openapi: '3.0.0',
      servers: [{ url: 'https://{region}.api.example.com/{version}' }],
      paths: { '/test': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    const result = serverBasepath(spec, diag);
    expect(result.paths['/test']).toBeDefined();
    expect(diag.entries.some(e => e.feature === 'template-basepath')).toBe(true);
  });

  it('skips when no servers defined', () => {
    const spec = {
      openapi: '3.0.0',
      paths: { '/test': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    const result = serverBasepath(spec, diag);
    expect(result.paths['/test']).toBeDefined();
  });

  it('resets server URL to / after base path extraction', () => {
    const spec = {
      openapi: '3.0.0', info: { title: 'Test', version: '1.0' },
      servers: [{ url: '/v1' }],
      paths: { '/users': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    const result = serverBasepath(spec, diag);
    expect(result.paths!['/v1/users']).toBeDefined();
    expect(result.servers![0].url).toBe('/');
  });

  it('handles relative server URLs', () => {
    const spec = {
      openapi: '3.0.0',
      servers: [{ url: '/api/v1' }],
      paths: { '/users': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const diag = createDiagnostics();
    const result = serverBasepath(spec, diag);
    expect(result.paths['/api/v1/users']).toBeDefined();
  });
});
