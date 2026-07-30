import { describe, it, expect } from 'vitest';
import { inlineResponseRefs } from '../../src/transforms/inline-response-refs.js';
import { createDiagnostics } from '../../src/diagnostics.js';

describe('inlineResponseRefs', () => {
  it('inlines $ref responses from components', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            responses: {
              '500': { $ref: '#/components/responses/InternalError' },
            },
          },
        },
      },
      components: {
        responses: {
          InternalError: { description: 'Internal Server Error' },
        },
      },
    };
    const diag = createDiagnostics();
    const result = inlineResponseRefs(spec, diag);
    expect(result.paths['/test'].get.responses['500'].description).toBe('Internal Server Error');
    expect(result.paths['/test'].get.responses['500'].$ref).toBeUndefined();
  });

  it('warns on unresolvable $ref', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            responses: {
              '404': { $ref: '#/components/responses/NotFound' },
            },
          },
        },
      },
      components: { responses: {} },
    };
    const diag = createDiagnostics();
    inlineResponseRefs(spec, diag);
    expect(diag.entries.some(e => e.level === 'warning')).toBe(true);
  });

  it('leaves non-$ref responses unchanged', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/test': {
          get: {
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema: {} } } },
            },
          },
        },
      },
    };
    const diag = createDiagnostics();
    const result = inlineResponseRefs(spec, diag);
    expect(result.paths['/test'].get.responses['200'].description).toBe('OK');
  });
});
