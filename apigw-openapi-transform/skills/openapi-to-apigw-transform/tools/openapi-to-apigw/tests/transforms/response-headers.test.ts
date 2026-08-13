import { describe, it, expect } from 'vitest';
import { responseHeaders } from '../../src/transforms/response-headers.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('responseHeaders', () => {
  it('logs preserved x-* response headers', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                headers: {
                  'x-correlation-id': { schema: { type: 'string' } },
                  'x-next': { schema: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    responseHeaders(spec, diag);
    expect(diag.entries.some(e =>
      e.message.includes('x-correlation-id') && e.message.includes('x-next'),
    )).toBe(true);
  });

  it('does nothing when no headers present', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': { get: { responses: { '200': { description: 'OK' } } } },
      },
    };
    const diag = createDiagnostics();
    responseHeaders(spec, diag);
    expect(diag.entries).toHaveLength(0);
  });

  it('checks component-level responses too', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {},
      components: {
        responses: {
          Paginated: {
            description: 'Paginated',
            headers: { 'x-page-token': { schema: { type: 'string' } } },
          },
        },
      },
    };
    const diag = createDiagnostics();
    responseHeaders(spec, diag);
    expect(diag.entries.some(e => e.message.includes('x-page-token'))).toBe(true);
  });
});
